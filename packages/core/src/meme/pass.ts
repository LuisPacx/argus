import type { ExistingToken } from "../beta/distinct-name.ts";
import { rankRoomLeft } from "../beta/room-left.ts";
import { BrainError, type Brain, type BrainRun } from "../brain.ts";
import type { CollisionChecker, CollisionResult } from "../collision.ts";
import { MAX_NEW_PROPOSALS_PER_DAY, MemeTrioExistsError, type Datastore, type NarrativeEmbedder, type Narrative, type Proposal, type Score } from "../datastore.ts";
import { InvalidEvidenceLinkError, normalizeEvidenceLinks } from "../evidence-links.ts";
import { META_RULE, type MetaConfig } from "../meta/config.ts";
import { groupTokens } from "../meta/group.ts";
import { headlineNamesKey, newsForKeys } from "../meta/news.ts";
import { leaderTag } from "../meta/new-meta.ts";
import type { CurrentMeta, MetaNewEvent, MetaRun } from "../meta/store.ts";
import { currentSummaryFresh, leaderAt } from "../meta/summary.ts";
import { mergeThemes } from "../meta/theme.ts";
import { DEFAULT_RESEARCH_BUDGET_CONFIG, researchRunCaps, researchUsage, type ResearchBudgetConfig } from "../research-budget.ts";
import type { DexPair } from "../sources/dexscreener.ts";
import { sourceClass } from "../sources/source-class.ts";
import type { LaunchedToken } from "../study/store.ts";
import { avoidLabels, cleanLine, memeIdeasPromptFor, MEME_PROMPT_MARKET_SIGNALS, MEME_PROMPT_NEWS, MEME_PROMPT_TOKENS, newsMemePromptFor, parseMemeOutput, topicMemePromptFor, type MemeIdea, type MemeParse, type MemePromptToken } from "./ideas.ts";
import { deadTokenNotes } from "./live-token.ts";
import type { MemeAttempt, MemeOutcome } from "./store.ts";
import { angleAttemptCap, MAKE_IDEAS_ANGLE_TEXT, topicKey, type AngleRequest } from "./angle.ts";
import { MEME_REFRESH_MS, MEME_WINDOW_MS, NEWS_MEME_FLOORS, NEWS_MEME_LIVE_MS, newsMemeKey, type MemeSnapshotTriggerKind, type MemeTriggerKind, type MetaSnapshotV2, type NarrativeSnapshotV3, type NewMemeIdea, type SnapshotNews, type TopicSnapshotV4 } from "./types.ts";

/**
 * The meme ideas pass (ADR 0013, amended by meta redesign ticket 03): for each current Meta (ADR 0014; a Watching subject never), one
 * sonnet run that returns three meme ideas, stored as `meme` Proposals. It follows the Meta summary pass:
 * - the trigger is plain code and nothing else (news is context, ADR 0011): a Meta is due when a live New Meta event has not been tried for,
 *   or its last started try is `MEME_REFRESH_MS` (12 h) old, or it was never tried; a failed try is due again after `failedRetryMinutes`.
 *   An event bypasses the 12 h gap but not the 6 h trio guard (`MEME_WINDOW_MS`), so a Meta that leaves and comes back is not run twice;
 * - the order spends the cap well: New Meta events first (oldest first), then refreshes by oldest last try;
 * - its own cap of `maxRunsPerDay` runs (24) in any rolling 24 hours (refused and failed ones included, the retry included), counting only
 *   automatic runs (the Operator's angle runs have a separate allowance of 5, below), taken from the shared research budget: a reached cap is recorded once per slot with its reason, logs what waits, and ends the pass without error;
 * - an `in-flight` brain_runs row exists before the child is spawned and the run's cost is recorded the moment it returns;
 * - the answer is untrusted: it must fit `parseMemeOutput` exactly, and no name may copy a token of the Meta's group or one DexScreener
 *   lists (the distinct-name rule); a copy goes back once with the copied names listed, then fails closed with nothing stored;
 * - a rate limit, a budget stop or a shutdown ends the pass at once; three transient failures in a row end it too.
 * After the Metas the same pass serves news stories (proposal-routing ticket 04, ADR 0013 amendment): a news Narrative that failed the
 * buildability gate and passed the floors (`narrativesToMeme`) gets one trio too, from the same `meme-ideas` task, the same 24 a day and the
 * same research budget, Metas first. A story that names a current Meta or Watching subject is left to that Meta; a story has one trio ever.
 * A third kind of job, the Operator's angle (meta redesign ticket 11, `runMemeAngles`): a pending `meme_angle_requests` row is run through this
 * same loop (the same `mayRun`, `ask`, `check`, collision checks and `createMemeProposals`), with the angle as a fenced block of the prompt. It is
 * counted in its own daily allowance (ticket 12: 5 angle runs, apart from the 8; `dailyMemeRunLimit`) and in the research budget, and ends its request
 * `done`, `refused`, `failed` or `capped` (never left pending by a cap); a rate limit, a shutdown or a dry run leaves it pending.
 * Nothing here launches, signs or spends anything (ADR 0002), and nothing makes a Narrative, a Score or a Spec.
 */

/** The most meme-ideas runs started in any rolling 24 hours, whatever is configured: the hard ceiling, which configuration cannot pass. */
export const MAX_MEME_RUNS_PER_DAY = 40;

/**
 * The Operator's angle runs have a daily allowance of their own (ticket 12, from ticket 11's grilling): 10 in any rolling 24 hours (ticket 16
 * raised it from 5), never more than the ceiling. Since ticket 16 it counts only runs that filed Proposals (one per filed trio, its retries
 * included); a refused run does not spend it. All angle attempts, refused ones and retries included, are held by a hard cap of
 * `ANGLE_ATTEMPT_CAP_FACTOR` (3) times the allowance (`angleAttemptCap`). The regular cap does not count angle runs and they do not count against it.
 */
export const DEFAULT_ANGLE_DAILY_MEME_RUNS = 10;
export const MAX_ANGLE_DAILY_MEME_RUNS = 10;

/** THE one place that says how many meme-ideas runs started in the last 24 h stop another run of this kind (only runs of the same kind are counted): `maxRunsPerDay` for an automatic run, the angle allowance (of filed trios) for an angle run. */
export function dailyMemeRunLimit(kind: "automatic" | "angle", maxRunsPerDay: number, angleAllowance: number = DEFAULT_ANGLE_DAILY_MEME_RUNS): number {
  return kind === "angle" ? Math.min(MAX_ANGLE_DAILY_MEME_RUNS, angleAllowance) : Math.min(MAX_MEME_RUNS_PER_DAY, maxRunsPerDay);
}

/**
 * The live-Metas rule (ticket 17): a refresh is skipped when the Meta had fewer than `MEME_LIVE_MIN_CREATES` creates in its `MEME_LIVE_WINDOW`
 * counts (the last 6 h, the Meta's own stored counts). A New Meta event is never skipped by it. Review 2026-11-19: 18 Proposals went to Metas with
 * 0 creates in 6 h while the cap refused Metas with hundreds of copiers.
 */
export const MEME_LIVE_MIN_CREATES = 10;
export const MEME_LIVE_WINDOW = "6h" as const;

export interface MemeConfig {
  /** Most meme-ideas runs started in any rolling 24 hours (the retry for a copied name included); at most `MAX_MEME_RUNS_PER_DAY`. */
  maxRunsPerDay: number;
  /** Most Metas tried in one pass. */
  maxPerPass: number;
  /** A try that failed (not refused) is tried again no sooner than this many minutes later. */
  failedRetryMinutes: number;
  /** This many transient failures in a row end the pass, as a rate limit does. */
  maxConsecutiveFailures: number;
}

/**
 * 24 runs a day (ticket 17, from the proposal review of 2026-11-19; was 8 from 2026-11-15): the live-Metas rule below drops the dead refreshes,
 * so the runs go to Metas with a copy flow; 8 runs cost about $0.33. The 3x attempt cap (`angleAttemptCap`) belongs to the angle allowance and is unchanged (30).
 */
export const DEFAULT_MEME_CONFIG: MemeConfig = { maxRunsPerDay: 24,maxPerPass: 3, failedRetryMinutes: 30, maxConsecutiveFailures: 3 };

/**
 * ARGUS_MEME_IDEAS (`1` turns the pass on; unset, empty or `0` leave it off; anything else is an error) and ARGUS_MEME_MAX_PER_DAY (a
 * whole number from 1 to the hard ceiling of 40, which may lower or raise the default of 24). An invalid value is an error and never a
 * fallback, as for the other ARGUS_* caps.
 */
export function memeConfigFromEnv(env: Record<string, string | undefined>): { enabled: boolean; config: MemeConfig } {
  const rawSwitch = env.ARGUS_MEME_IDEAS?.trim() ?? "";
  if (rawSwitch !== "" && rawSwitch !== "0" && rawSwitch !== "1") throw new Error(`ARGUS_MEME_IDEAS must be 1 (on) or 0 or unset (off), got "${env.ARGUS_MEME_IDEAS}"`);
  const rawCap = env.ARGUS_MEME_MAX_PER_DAY?.trim() ?? "";
  let maxRunsPerDay = DEFAULT_MEME_CONFIG.maxRunsPerDay;
  if (rawCap !== "") {
    const v = Number(rawCap);
    if (!Number.isInteger(v) || v < 1) throw new Error(`ARGUS_MEME_MAX_PER_DAY must be a whole number, 1 or more, got "${env.ARGUS_MEME_MAX_PER_DAY}"`);
    if (v > MAX_MEME_RUNS_PER_DAY) throw new Error(`ARGUS_MEME_MAX_PER_DAY must be at most ${MAX_MEME_RUNS_PER_DAY} (the hard ceiling in code), got "${env.ARGUS_MEME_MAX_PER_DAY}"`);
    maxRunsPerDay = v;
  }
  return { enabled: rawSwitch === "1", config: { ...DEFAULT_MEME_CONFIG, maxRunsPerDay } };
}

/** The one DexScreener method the name check needs; `DexScreenerClient` satisfies it, tests pass a counting fake. */
export interface MemeDexClient {
  search(query: string): Promise<DexPair[]>;
}

export interface MemeResult {
  /** Brain runs started (the retry for a copied name included). */
  called: number;
  /** Metas whose trio of Proposals was stored. */
  stored: number;
  /** Tries whose answer did not fit, or whose names copied a token twice; nothing was stored. */
  refused: number;
  /** Runs that failed (error, budget, timeout). */
  failed: number;
  /** Due Metas passed over because the Meta already had a trio in the last 6 h (the trio guard). */
  skipped: number;
  /** News stories whose answer was dropped because the Narrative stopped being eligible before the trio was stored. */
  withdrawn: number;
  stoppedBy?: "off" | "api-hold" | "daily-cap" | "research-cap" | "proposal-cap" | "rate-limited" | "interrupted" | "dry-run" | "backoff";
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface MemeOptions {
  /** The switch (`ARGUS_MEME_IDEAS`). Off, the pass reads nothing, calls nothing and stores nothing. Default off. */
  enabled?: boolean;
  now?: Date;
  config?: Partial<MemeConfig>;
  research?: ResearchBudgetConfig;
  metaConfig?: MetaConfig;
  log?: (line: string) => void;
  signal?: AbortSignal;
  /** DexScreener search for the distinct-name rule; without one only the Meta's own tokens are compared. */
  dex?: MemeDexClient;
  /** The collision checks of each idea's name and ticker, stored with the Proposal (see collision.ts); without one nothing is checked. */
  collisions?: CollisionChecker;
  /** The Narrative embedder of the news stories (the one the judge uses). Without one the news path is off and only Metas are served. */
  embedder?: NarrativeEmbedder;
  /** What the pass serves: the automatic jobs (Metas, then news stories; the default) or only the Operator's pending angle requests (ticket 11). */
  jobs?: "automatic" | "angles";
}

/** The tokens of the Meta's group as of the run: the same grouping and theme merge the ranking used, so the group is the one the row counted. Empty for a Meta that outlived its launch wave. */
function groupOf(store: Datastore, key: string, computedAt: string, config: MetaConfig): LaunchedToken[] {
  const to = Date.parse(computedAt);
  const tokens = store.study.createdBetween(new Date(to - DAY_MS).toISOString(), computedAt);
  const clones = groupTokens(tokens);
  const groups = config.theme ? mergeThemes(clones, config.theme) : clones;
  return groups.find((g) => g.key === key)?.tokens ?? [];
}

/**
 * Up to 8 tokens for the prompt and the snapshot: the leader first (it may be of any age and so outside the group), then the Meta's top
 * tokens, then migrated ones, then the earliest creates of the group.
 */
function shownTokens(store: Datastore, meta: CurrentMeta, group: readonly LaunchedToken[]): MemePromptToken[] {
  const leader = meta.leader;
  const caps = new Map(meta.topTokens.flatMap((t) => (t.marketCapUsd !== undefined ? [[t.mint, t.marketCapUsd] as const] : [])));
  caps.set(leader.mint, leader.marketCapUsd);
  const first = new Map(meta.topTokens.map((t, i) => [t.mint, i + 1]));
  first.set(leader.mint, 0);
  const byMint = new Map(group.map((t) => [t.mint, t]));
  const ordered = [...group].sort(
    (a, b) =>
      (first.get(a.mint) ?? 99) - (first.get(b.mint) ?? 99) ||
      (a.migratedAt === null ? 1 : 0) - (b.migratedAt === null ? 1 : 0) ||
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
      (a.mint < b.mint ? -1 : 1),
  );
  const describe = (mint: string): { description?: string } => {
    const description = store.study.getSnapshot(mint)?.description;
    return description !== undefined && description !== "" ? { description } : {};
  };
  const lead: MemePromptToken = { mint: leader.mint, name: leader.name, symbol: leader.symbol, migrated: (byMint.get(leader.mint)?.migratedAt ?? null) !== null, marketCapUsd: leader.marketCapUsd, ...describe(leader.mint) };
  const rest: MemePromptToken[] = ordered
    .filter((t) => t.mint !== leader.mint)
    .map((t) => ({ mint: t.mint, name: t.name, symbol: t.symbol, migrated: t.migratedAt !== null, ...(caps.has(t.mint) ? { marketCapUsd: caps.get(t.mint) as number } : {}), ...describe(t.mint) }));
  if (rest.length === 0) {
    // No group in the last 24 h: the stored top tokens stand in.
    return [lead, ...meta.topTokens.filter((t) => t.mint !== leader.mint).map((t) => ({ mint: t.mint, name: t.name, symbol: t.symbol, migrated: false, ...(t.marketCapUsd !== undefined ? { marketCapUsd: t.marketCapUsd } : {}) }))].slice(0, MEME_PROMPT_TOKENS);
  }
  return [lead, ...rest].slice(0, MEME_PROMPT_TOKENS);
}

/** The room-left ranking's verdict for one Meta as text built from numbers only: an input to the prompt, never a gate. */
export function roomLeftOf(run: MetaRun, key: string): { passed: boolean; text: string } {
  try {
    const ranking = rankRoomLeft(run);
    const at = ranking.candidates.findIndex((c) => c.row.key === key);
    if (at >= 0) return { passed: true, text: `still has room (number ${at + 1} of ${ranking.candidates.length} by the room-left ranking): ${ranking.candidates[at]!.reasons.join("; ")}` };
    const rejected = ranking.rejected.find((r) => r.row.key === key);
    if (rejected) return { passed: false, text: `may have no room left (${rejected.gate}): ${rejected.reason}` };
  } catch {
    // an unreadable run says nothing about room
  }
  return { passed: false, text: "no room-left verdict for this Meta" };
}

/** The Meta as it stands, in the shape that is stored with each idea and never changed (version 2; version 1 snapshots of the Hot now era stay readable). */
export function buildSnapshot(args: {
  now: Date;
  meta: CurrentMeta;
  run: { id: number; computedAt: string };
  trigger: { kind: MemeSnapshotTriggerKind; reason: string; at: string };
  summary?: string;
  roomLeft: { passed: boolean; text: string };
  tokens: readonly MemePromptToken[];
  news: readonly SnapshotNews[];
}): MetaSnapshotV2 {
  const { meta, run, trigger } = args;
  return {
    version: 2,
    capturedAt: args.now.toISOString(),
    meta: {
      key: meta.key,
      label: meta.label,
      enteredAt: meta.enteredAt,
      holding: meta.holding,
      counts: meta.counts,
      topTokens: meta.topTokens,
      ...(args.summary !== undefined && args.summary !== "" ? { summary: args.summary } : {}),
    },
    leader: { mint: meta.leader.mint, name: meta.leader.name, symbol: meta.leader.symbol, marketCapUsd: meta.leader.marketCapUsd },
    trigger: { kind: trigger.kind, reason: trigger.reason, at: trigger.at },
    run: { id: run.id, computedAt: run.computedAt },
    roomLeft: args.roomLeft,
    tokens: args.tokens.map((t) => ({ mint: t.mint, name: t.name, symbol: t.symbol, migrated: t.migrated, ...(t.marketCapUsd !== undefined ? { marketCapUsd: t.marketCapUsd } : {}) })),
    news: args.news.map((n) => ({ title: n.title, sourceLabel: n.sourceLabel, url: n.url, publishedAt: n.publishedAt })),
  };
}

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * The evidence links, built by code and never by the model: the Meta's leader and top tokens (their DexScreener pages, the host the Meta
 * ranking already links, the leader first) and the matching news that has a valid http(s) link. At most 3 and 5, distinct.
 */
export function evidenceFor(tokens: readonly { mint: string }[], news: readonly SnapshotNews[]): string[] {
  const links: string[] = [];
  for (const t of tokens.slice(0, 3)) if (BASE58_ADDRESS.test(t.mint)) links.push(`https://dexscreener.com/solana/${t.mint}`);
  for (const n of news.slice(0, MEME_PROMPT_NEWS)) {
    try {
      links.push(...normalizeEvidenceLinks([n.url]));
    } catch (e) {
      if (!(e instanceof InvalidEvidenceLinkError)) throw e;
    }
  }
  return normalizeEvidenceLinks(links);
}

/** A current Meta the pass has decided to try, and why. */
export interface MemeDue {
  meta: CurrentMeta;
  kind: MemeTriggerKind;
  /** The slot this try fills, the key of its cap refusal: the event's `raisedAt` (new Meta) or the start of the refresh slot (the last try plus 12 h, or when the Meta entered when it was never tried). */
  eventAt: string;
  /** What orders the list within its kind: the event time, or the last try (oldest first). */
  since: string;
}

/**
 * Which current Metas are due and in what order (pure over what it reads). New Meta events come first (oldest event first), then refreshes by
 * oldest last try. A Meta is due when its newest live event is newer than its last started try (or it has no try); else a failed last try
 * is due again after `failedRetryMinutes`; else a Meta never tried, or last tried `MEME_REFRESH_MS` ago, is due for a refresh. Watching
 * subjects are not in `metas`, so they are never due.
 */
export function dueMetas(metas: readonly CurrentMeta[], events: ReadonlyMap<string, Pick<MetaNewEvent, "raisedAt">>, lastTry: (key: string) => Pick<MemeAttempt, "at" | "outcome" | "eventAt"> | undefined, now: Date, config: Pick<MemeConfig, "failedRetryMinutes">, heldMs: (since: string, ttlMs: number) => number = () => 0): MemeDue[] {
  const due: MemeDue[] = [];
  for (const meta of metas) {
    const last = lastTry(meta.key);
    const event = events.get(meta.key);
    // Ticket 17: a refresh of a Meta with no copy flow is not worth a run; a New Meta event is never skipped here.
    const live = meta.counts[MEME_LIVE_WINDOW].tokens >= MEME_LIVE_MIN_CREATES;
    if (event && (!last || last.at < event.raisedAt)) {
      due.push({ meta, kind: "new-meta", eventAt: event.raisedAt, since: event.raisedAt });
    } else if (last?.outcome === "failed") {
      if (now.getTime() - Date.parse(last.at) < config.failedRetryMinutes * 60_000) continue;
      const kind = event?.raisedAt === last.eventAt ? "new-meta" : "refresh";
      if (kind === "refresh" && !live) continue;
      due.push({ meta, kind, eventAt: last.eventAt, since: last.eventAt });
    } else if (!last) {
      if (!live) continue;
      due.push({ meta, kind: "refresh", eventAt: meta.enteredAt, since: meta.enteredAt });
    } else {
      // The 12 h counts running time: recorded worker downtime after the last try holds the refresh (ticket 10).
      const slot = Date.parse(last.at) + MEME_REFRESH_MS + heldMs(last.at, MEME_REFRESH_MS);
      if (now.getTime() >= slot && live) due.push({ meta, kind: "refresh", eventAt: new Date(slot).toISOString(), since: last.at });
    }
  }
  const rank = (d: MemeDue) => (d.kind === "new-meta" ? 0 : 1);
  return due.sort((a, b) => rank(a) - rank(b) || (a.since < b.since ? -1 : a.since > b.since ? 1 : 0) || (a.meta.key < b.meta.key ? -1 : 1));
}

/** "$JENSEN at $2.4M, 14 creators in 24 h": a Meta's leader, cap and copies as the stored reason and the prompt state them. Creator text is cleaned and cut. */
export function metaFacts(m: Pick<CurrentMeta, "leader" | "counts">): string {
  const copies = m.counts["24h"].creators;
  return `${leaderTag(m.leader)}${leaderAt(m.leader.marketCapUsd)}, ${copies} ${copies === 1 ? "creator" : "creators"} in 24 h`;
}

/** A news story the pass has decided to try. */
export interface NewsMemeDue {
  narrative: Narrative;
  /** The Score the story was selected on (its latest). */
  score: Score;
  /** The slot this try fills, the key of its cap refusal: when that Score was made, so a re-score is a new slot. */
  eventAt: string;
}

/**
 * Which selected stories are due (pure over what it reads), in the order given: a story never tried, or re-scored since its last try
 * (a re-score that lifts it over the floors is a new reason to try), or whose last try failed (not refused) `failedRetryMinutes` ago. A story
 * whose last try was refused, copied a name twice or was withdrawn waits for its next Score. A cap refusal is not a try.
 */
export function dueNewsMemes(candidates: ReadonlyArray<{ narrative: Narrative; score: Score }>, lastTry: (key: string) => Pick<MemeAttempt, "at" | "outcome"> | undefined, now: Date, config: Pick<MemeConfig, "failedRetryMinutes">): NewsMemeDue[] {
  const due: NewsMemeDue[] = [];
  for (const c of candidates) {
    const last = lastTry(newsMemeKey(c.narrative.id));
    const retry = last?.outcome === "failed" && now.getTime() - Date.parse(last.at) >= config.failedRetryMinutes * 60_000;
    if (!last || last.at < c.score.createdAt || retry) due.push({ narrative: c.narrative, score: c.score, eventAt: c.score.createdAt });
  }
  return due;
}

/** The most stories read from the selector in one pass (they are tried at most `maxPerPass` at a time, best first). */
const NEWS_MEME_SELECT_LIMIT = 20;

/**
 * The stories due now: the selector's, less those that name a current Meta or Watching subject (`subjectKeys`; the headline match of
 * `meta/news.ts`, no RegExp), then `dueNewsMemes`. A skipped story starts no run and stores nothing.
 */
function newsDueOf(store: Datastore, embedder: NarrativeEmbedder, gateMin: number, subjectKeys: readonly string[], now: Date, config: Pick<MemeConfig, "failedRetryMinutes">): NewsMemeDue[] {
  const since = new Date(now.getTime() - NEWS_MEME_LIVE_MS).toISOString();
  const own = store.narrativesToMeme(embedder, since, gateMin, NEWS_MEME_FLOORS, NEWS_MEME_SELECT_LIMIT).filter((c) => !subjectKeys.some((key) => headlineNamesKey(c.narrative.title, key)));
  return dueNewsMemes(own, (key) => store.meme.lastTry(key), now, config);
}

/** "buildability 4 under the gate of 5; legitimacy 6, hook 8, momentum 9": why a story became a news meme, from the Score's numbers only. */
export function newsMemeReason(score: Pick<Score, "scores">, gateMin: number): string {
  const s = score.scores;
  return `buildability ${s.buildability} under the gate of ${gateMin}; legitimacy ${s.legitimacy}, hook ${s.hook}, momentum ${s.momentum}`;
}

/** What a news Narrative is tried as, beside a Meta (`Job`): the same loop serves both. */
interface Job {
  key: string;
  label: string;
  eventAt: string;
  /** True when this subject already has a trio that bars another one now. */
  guarded(now: Date): boolean;
  /** The context of one try, read once. */
  prepare(now: Date): Prepared;
  /** Set for the Operator's angle (ticket 11): the request this job runs. The request ends with the job's outcome. */
  angle?: { requestId: number };
  /** A reason the job cannot run at all now (the Meta is no longer current): the request ends `refused` before any cap or run. */
  refusal?(now: Date): string | undefined;
  /** A cap that holds the job now beyond the shared ones (the 30 a day new Proposals): the request ends `capped`. */
  capReason?(now: Date): string | undefined;
}

/** Why a prompt is asked a second time: the copied names (the existing retry) or the contract error (the repair retry, ticket 16). */
interface Retry {
  copies?: readonly string[];
  problem?: string;
}

/**
 * The lessons a Make ideas try shows (human researcher tickets 09 and 19), read once: the newest non-empty Pick lessons and the newest idea lessons, which
 * may come from different versions. `playbookVersions` is what each new Proposal records: `playbookVersion` is the Pick lessons' version (the ideas
 * version when no Pick lessons were shown) and `ideasPlaybookVersion` the version whose idea lessons were shown.
 */
function readLessons(store: Datastore): { playbook?: { id: string; text: string }; ideaLessons?: { id: string; text: string }; playbookVersions: { playbookVersion?: string; ideasPlaybookVersion?: string } } {
  const { picks, ideas } = store.playbookLessons();
  const first = picks ?? ideas;
  return {
    ...(picks ? { playbook: picks } : {}),
    ...(ideas ? { ideaLessons: ideas } : {}),
    playbookVersions: { ...(first ? { playbookVersion: first.id } : {}), ...(ideas ? { ideasPlaybookVersion: ideas.id } : {}) },
  };
}

/** The prompt inputs of a retry. */
const retryFields = (retry: Retry | undefined): { retryCopies?: readonly string[]; retryProblem?: string } => ({
  ...(retry?.copies ? { retryCopies: retry.copies } : {}),
  ...(retry?.problem ? { retryProblem: retry.problem } : {}),
});

interface Prepared {
  /** Tokens the ideas must not copy (a Meta's group; none for a story: DexScreener's list is the check). */
  existing: ExistingToken[];
  promptFor(retry?: Retry): string;
  /** Stores the trio, or "withdrawn" when the subject stopped being eligible. Throws `MemeTrioExistsError`. */
  create(ideas: NewMemeIdea[], now: Date, runIds: number[]): Proposal[] | "withdrawn";
  /** The log line of a stored trio. */
  doneLine(made: Proposal[]): string;
}

type Asked = { kind: "ok"; runId: number; result: BrainRun<string> } | { kind: "stop"; stoppedBy: NonNullable<MemeResult["stoppedBy"]> } | { kind: "failed"; budget: boolean };

export async function generateMemeIdeas(store: Datastore, brain: Brain, opts: MemeOptions = {}): Promise<MemeResult> {
  const out: MemeResult = { called: 0, stored: 0, refused: 0, failed: 0, skipped: 0, withdrawn: 0 };
  // The switch: off, nothing below runs, so nothing is read, called or stored.
  if (opts.enabled !== true) return { ...out, stoppedBy: "off" };
  const config = { ...DEFAULT_MEME_CONFIG, ...opts.config };
  const maxRunsPerDay = Math.min(config.maxRunsPerDay, MAX_MEME_RUNS_PER_DAY);
  const metaConfig = opts.metaConfig ?? META_RULE;
  const research = opts.research ?? DEFAULT_RESEARCH_BUDGET_CONFIG;
  const caps = researchRunCaps(brain);
  const log = opts.log ?? console.log;
  const clock = () => opts.now ?? new Date();

  // The API fallback is holding the research tasks on the API: spawning claude here would probe the rate limit and extend the hold.
  if (brain.routeFor("judge").backend === "api") return { ...out, stoppedBy: "api-hold" };

  const anglesOnly = opts.jobs === "angles";
  // A request a dead worker left `running` is waiting again (the pass is re-entrancy guarded, so none is running now).
  if (anglesOnly) store.requeueRunningAngleRequests();

  // The Metas as of the newest run (ADR 0014). A run older than the carried state's limit no longer describes the market: nothing is due.
  const current = store.currentMetas();
  const startedAt = clock();
  let metaQueue: MemeDue[] = [];
  if (current && !anglesOnly) {
    const runAge = startedAt.getTime() - Date.parse(current.computedAt);
    if (Number.isFinite(runAge) && runAge <= metaConfig.stateMaxMinutes * 60_000) {
      // The live New Meta events, newest per Meta. An event is live for `newMetaLiveHours`; its Meta must still be a Meta in the newest run.
      const events = new Map<string, MetaNewEvent>();
      for (const e of store.newMetaEvents(new Date(startedAt.getTime() - metaConfig.newMetaLiveHours * HOUR_MS).toISOString())) if (!events.has(e.key)) events.set(e.key, e);
      metaQueue = dueMetas(current.metas, events, (key) => store.meme.lastTry(key), startedAt, config, (since, ttl) => store.workerGapMsHeld(since, ttl));
    }
  }
  // The news stories (ticket 04), after the Metas. A story that names a current Meta or Watching subject is left to that Meta (its trio wins);
  // the subjects are read from the newest run whatever its age, so a stale run skips more, never fewer.
  const gateMin = store.getRubric().gateMinScore;
  const newsQueue = opts.embedder && !anglesOnly ? newsDueOf(store, opts.embedder, gateMin, [...(current?.metas ?? []), ...(current?.watching ?? [])].map((m) => m.key), startedAt, config) : [];
  // The Operator's angles (ticket 11), oldest first; only the angle pass reads them.
  const angleQueue = anglesOnly ? store.pendingAngleRequests() : [];
  if (metaQueue.length === 0 && newsQueue.length === 0 && angleQueue.length === 0) return out;
  // The launch-theme run only feeds the room-left ranking (an input to the prompt, never a gate).
  const launchRun = metaQueue.length > 0 || angleQueue.length > 0 ? store.latestMetas("24h", 200) : undefined;
  const embedder = opts.embedder;

  let transientInARow = 0;
  let tried = 0;

  /** Whether another meme-ideas run may start: the daily cap and the research budget. A refusal is recorded with its reason once per slot. */
  const mayRun = (due: Pick<Job, "key" | "eventAt" | "angle">): { ok: true } | { ok: false; stoppedBy: "daily-cap" | "research-cap"; detail: string } => {
    const since = new Date(clock().getTime() - DAY_MS).toISOString();
    const spent = store.memeIdeasSpendSince(since, caps);
    const runs = store.memeRunsSince(since);
    const dailyLimit = dailyMemeRunLimit(due.angle ? "angle" : "automatic", maxRunsPerDay);
    // The caps are told apart in the words: the regular cap, the angle allowance (filed trios only, ticket 16) and the hard cap on all angle attempts.
    const capped = (detail: string) => {
      store.meme.record({ key: due.key, eventAt: due.eventAt, at: clock().toISOString(), outcome: "daily-cap", detail, runs: 0 });
      return { ok: false, stoppedBy: "daily-cap", detail } as const;
    };
    if (due.angle) {
      if (runs.angleFiled >= dailyLimit) return capped(`angle allowance of ${dailyLimit} meme-ideas runs a day reached (${runs.angleFiled} runs that filed ideas in 24 h; refused runs do not count; the regular cap is separate)`);
      const attemptCap = angleAttemptCap(dailyLimit);
      if (runs.angle >= attemptCap) return capped(`angle attempt cap of ${attemptCap} meme-ideas runs a day reached (${runs.angle} angle runs in 24 h, refused runs and retries included; the cap is 3 times the allowance of ${dailyLimit})`);
    } else if (runs.regular >= dailyLimit) {
      return capped(`daily cap of ${dailyLimit} meme-ideas runs reached (${runs.regular} runs, $${spent.chargedUsd.toFixed(4)} in 24 h)`);
    }
    const usage = researchUsage(store, clock(), research, caps);
    if (usage.exhausted) {
      const detail = `research budget reached ($${usage.usedUsd.toFixed(4)} of $${usage.budgetUsd.toFixed(2)} in 24 h, judge, propose, summaries and meme ideas together)`;
      store.meme.record({ key: due.key, eventAt: due.eventAt, at: clock().toISOString(), outcome: "research-cap", detail, runs: 0 });
      return { ok: false, stoppedBy: "research-cap", detail };
    }
    return { ok: true };
  };

  /** One meme-ideas run: an in-flight row first, the cost recorded the moment it returns. */
  const ask = async (prompt: string, label: string, angle: boolean): Promise<Asked> => {
    const runId = store.startBrainRun({ proposalId: 0, task: "meme-ideas", angle, ...brain.routeFor("meme-ideas") }, clock());
    out.called++;
    let result;
    try {
      result = await brain.run<string>("meme-ideas", { prompt }, { signal: opts.signal, onBackend: (r) => store.setBrainRunBackend(runId, r.backend, r.model) });
    } catch (e) {
      const brainError = e instanceof BrainError ? e : undefined;
      const kind = brainError?.kind ?? "failed";
      store.finishBrainRun(runId, { sessionId: brainError?.sessionId ?? null, totalCostUsd: brainError?.totalCostUsd ?? 0, exitStatus: kind, backend: brainError?.backend, model: brainError?.model });
      if (kind === "interrupted") return { kind: "stop", stoppedBy: "interrupted" };
      if (kind === "rate-limited") {
        log("[worker] meme ideas: rate-limited, stopping the pass; the Meta stays queued");
        return { kind: "stop", stoppedBy: "rate-limited" };
      }
      log(`[worker] meme ideas: "${label}" ${kind}: ${e instanceof Error ? e.message : String(e)}`);
      return { kind: "failed", budget: kind === "budget-exceeded" };
    }
    if (result.dryRun) {
      store.discardBrainRun(runId);
      out.called--;
      log("[worker] meme ideas: dry-run, nothing spawned; stopping the pass");
      return { kind: "stop", stoppedBy: "dry-run" };
    }
    return { kind: "ok", runId, result };
  };

  /** The spend is recorded the moment the answer is read, before anything else happens to it. */
  const finish = (a: { runId: number; result: BrainRun<string> }, ok: boolean) =>
    store.finishBrainRun(a.runId, { sessionId: a.result.sessionId ?? null, totalCostUsd: a.result.totalCostUsd, exitStatus: ok ? "success" : "invalid-output", backend: a.result.backend, model: a.result.model });

  /** What a try on a Meta or Watching subject reads, once: its group, shown tokens, matching news, room-left and the Rubric's legitimacy text. Shared by an automatic try and an Operator's angle. */
  const subjectContext = (meta: CurrentMeta, run: { runId: number; computedAt: string }, now: Date) => {
    const group = groupOf(store, meta.key, run.computedAt, metaConfig);
    const tokens = shownTokens(store, meta, group);
    const existing: ExistingToken[] = [
      { name: meta.leader.name, symbol: meta.leader.symbol },
      ...(group.length > 0 ? group.map((t) => ({ name: t.name, symbol: t.symbol })) : meta.topTokens.map((t) => ({ name: t.name, symbol: t.symbol }))),
    ];
    const news: SnapshotNews[] = (newsForKeys(store, [meta.key], now, metaConfig).get(meta.key) ?? []).map((n) => ({ title: n.title, sourceLabel: n.sourceLabel, url: n.url, publishedAt: n.publishedAt }));
    const roomLeft = launchRun ? roomLeftOf(launchRun, meta.key) : { passed: false, text: "no room-left verdict for this Meta" };
    const legitimacy = store.getRubric().dimensions.find((d) => d.key === "legitimacy")?.description ?? "";
    return { tokens, existing, news, roomLeft, legitimacy, facts: metaFacts(meta) };
  };

  /** A Meta as a job: its context is the group, tokens, matching news and room-left of the newest run. */
  const metaJob = (due: MemeDue, run: { runId: number; computedAt: string }): Job => ({
    key: due.meta.key,
    label: due.meta.label,
    eventAt: due.eventAt,
    guarded: (now) => store.hasMemeSince(due.meta.key, new Date(now.getTime() - MEME_WINDOW_MS).toISOString()),
    prepare: (now): Prepared => {
      const meta = due.meta;
      const { tokens, existing, news, roomLeft, legitimacy, facts } = subjectContext(meta, run, now);
      const trigger = { kind: due.kind, reason: facts, at: due.eventAt };
      return {
        existing,
        promptFor: (retry) => memeIdeasPromptFor({ label: meta.label, counts: meta.counts, ...(meta.grads ? { grads: meta.grads } : {}), enteredAt: meta.enteredAt, leader: meta.leader, trigger, tokens, avoid: avoidLabels(existing), news, roomLeft: roomLeft.text, legitimacy, ...retryFields(retry) }),
        create: (ideas, at, runIds) => {
          const stored = store.meta.summaries([meta.key]).get(meta.key);
          const snapshot = buildSnapshot({ now: at, meta, run: { id: run.runId, computedAt: run.computedAt }, trigger, ...(currentSummaryFresh(stored, at.getTime()) && stored?.summary ? { summary: stored.summary } : {}), roomLeft, tokens, news });
          return store.createMemeProposals(
            {
              metaKey: meta.key,
              metaLabel: meta.label,
              snapshot,
              reason: `${due.kind === "new-meta" ? "New Meta" : "Meta refresh"}: ${facts}`,
              summary: summaryLine(meta, due.kind),
              evidenceLinks: evidenceFor([meta.leader, ...meta.topTokens], news),
              ideas,
            },
            { now: at, attachRunId: runIds },
          );
        },
        doneLine: (made) => `${made.length} ideas for "${cleanLine(meta.label, 60)}" (${due.kind === "new-meta" ? "new Meta" : "refresh"}; proposals ${made.map((p) => p.id).join(", ")})`,
      };
    },
  });

  /** A news story as a job: the story, its Signals and its Score are the subject; the trio is stored only if it is still eligible then. */
  const newsJob = (due: NewsMemeDue): Job => {
    const key = newsMemeKey(due.narrative.id);
    const label = cleanLine(due.narrative.title, 160);
    const liveSince = (at: Date) => new Date(at.getTime() - NEWS_MEME_LIVE_MS).toISOString();
    return {
      key,
      label,
      eventAt: due.eventAt,
      guarded: () => store.hasMemeEver(key),
      prepare: (): Prepared => {
        const detail = store.getNarrative(due.narrative.id);
        const signals = detail?.signals ?? [];
        const news: SnapshotNews[] = signals.filter((s) => sourceClass(s.sourceId) !== "market").slice(0, MEME_PROMPT_NEWS).map((s) => ({ title: s.title, sourceLabel: s.sourceLabel, url: s.url, publishedAt: s.publishedAt }));
        const market = signals.filter((s) => sourceClass(s.sourceId) === "market").slice(0, MEME_PROMPT_MARKET_SIGNALS).map((s) => ({ title: s.title, sourceLabel: s.sourceLabel, publishedAt: s.publishedAt }));
        const legitimacy = store.getRubric().dimensions.find((d) => d.key === "legitimacy")?.description ?? "";
        const n = due.narrative;
        return {
          existing: [],
          promptFor: (retry) => newsMemePromptFor({ title: n.title, summary: n.summary, signalCount: n.signalCount, lastSignalAt: n.lastSignalAt, news, market, score: { total: due.score.total, scores: due.score.scores, rationale: due.score.rationale, gateMin }, legitimacy, ...retryFields(retry) }),
          create: (ideas, at, runIds) => {
            // The story may have been scored again, or stopped moving, while the model ran: it is judged on the same terms as the selector's, now.
            const again = embedder ? store.narrativesToMeme(embedder, liveSince(at), store.getRubric().gateMinScore, NEWS_MEME_FLOORS, 1, n.id)[0] : undefined;
            if (!again) return "withdrawn";
            const reason = newsMemeReason(again.score, store.getRubric().gateMinScore);
            const snapshot: NarrativeSnapshotV3 = {
              version: 3,
              kind: "narrative",
              capturedAt: at.toISOString(),
              narrative: { id: n.id, title: n.title, summary: n.summary, signalCount: again.narrative.signalCount, createdAt: n.createdAt, lastSignalAt: again.narrative.lastSignalAt },
              score: { id: again.score.id, rubricVersion: again.score.rubricVersion, total: again.score.total, scores: { ...again.score.scores }, rationale: again.score.rationale, gateMin: store.getRubric().gateMinScore, createdAt: again.score.createdAt },
              trigger: { kind: "news-meme", reason, at: again.score.createdAt },
              news,
            };
            return store.createMemeProposals(
              {
                narrative: { id: n.id, scoreId: again.score.id },
                metaKey: key,
                metaLabel: label,
                snapshot,
                reason: `News meme: ${reason}`,
                summary: `From news: ${cleanLine(n.title, 120)}. Buildability ${again.score.scores.buildability} under the gate of ${store.getRubric().gateMinScore}, so no Tech.`,
                evidenceLinks: evidenceFor([], news),
                ideas,
              },
              { now: at, attachRunId: runIds },
            );
          },
          doneLine: (made) => `${made.length} ideas for the news story "${cleanLine(n.title, 60)}" (proposals ${made.map((p) => p.id).join(", ")})`,
        };
      },
    };
  };

  /**
   * The Operator's angle on a Meta or Watching subject as a job (ticket 11): the subject's context as an automatic try reads it, with the angle in
   * its own fenced block. The Meta trio guard does not apply (an angle is the point of asking again); the request is guarded by its own id.
   */
  const angleJob = (req: AngleRequest): Job => {
    const subject = [...(current?.metas ?? []), ...(current?.watching ?? [])].find((m) => m.key === req.metaKey);
    const run = { runId: current?.runId ?? 0, computedAt: current?.computedAt ?? "" };
    return {
      key: `angle:${req.id}`,
      label: req.metaLabel,
      eventAt: req.createdAt,
      angle: { requestId: req.id },
      guarded: () => store.angleTrioProposalIds(req.id).length > 0,
      refusal: () => (subject ? undefined : "no longer a Meta"),
      capReason: (now) => (store.researchProposalsSince(new Date(now.getTime() - DAY_MS).toISOString()) >= MAX_NEW_PROPOSALS_PER_DAY ? `daily cap of ${MAX_NEW_PROPOSALS_PER_DAY} new Proposals reached` : undefined),
      prepare: (now): Prepared => {
        const meta = subject as CurrentMeta; // `refusal` ended the request before this runs when the subject is gone
        const { tokens, existing, news, roomLeft, legitimacy, facts } = subjectContext(meta, run, now);
        const trigger = { kind: "operator-angle" as const, reason: facts, at: req.createdAt };
        // The latest Playbook version (human researcher ticket 09), read once for the try: the prompt carries it and each Proposal records its id.
        const { playbook, ideaLessons, playbookVersions } = readLessons(store);
        return {
          existing,
          promptFor: (retry) => memeIdeasPromptFor({ label: meta.label, counts: meta.counts, ...(meta.grads ? { grads: meta.grads } : {}), enteredAt: meta.enteredAt, leader: meta.leader, trigger, tokens, avoid: avoidLabels(existing), news, roomLeft: roomLeft.text, legitimacy, ...(req.angle !== "" ? { angle: req.angle } : {}), ...(playbook ? { playbook } : {}), ...(ideaLessons ? { ideaLessons } : {}), ...retryFields(retry) }),
          create: (ideas, at, runIds) => {
            const stored = store.meta.summaries([meta.key]).get(meta.key);
            const snapshot = buildSnapshot({ now: at, meta, run: { id: run.runId, computedAt: run.computedAt }, trigger, ...(currentSummaryFresh(stored, at.getTime()) && stored?.summary ? { summary: stored.summary } : {}), roomLeft, tokens, news });
            return store.createMemeProposals(
              {
                metaKey: meta.key,
                metaLabel: meta.label,
                snapshot,
                reason: req.angle !== "" ? `Operator angle: ${cleanLine(req.angle, 160)}` : "Operator pressed Make ideas",
                summary: req.angle !== "" ? `Operator angle on ${cleanLine(meta.label, 60)}: ${cleanLine(req.angle, 160)}` : `Operator pressed Make ideas on ${cleanLine(meta.label, 60)}`,
                evidenceLinks: evidenceFor([meta.leader, ...meta.topTokens], news),
                ideas,
                operatorAngle: { requestId: req.id, angle: req.angle !== "" ? req.angle : MAKE_IDEAS_ANGLE_TEXT, sourceUrl: req.sourceUrl, urlDropped: req.urlDropped },
                ...playbookVersions,
              },
              { now: at, attachRunId: runIds },
            );
          },
          doneLine: (made) => `${made.length} ideas for the Operator's angle on "${cleanLine(meta.label, 60)}" (request ${req.id}; proposals ${made.map((p) => p.id).join(", ")})`,
        };
      },
    };
  };

  /**
   * Make ideas under a Research brief as a job (human researcher ticket 06): the same request table, loop, caps, name checks and storage as an
   * angle on a Meta, with the topic and the brief as the subject. The topic and the brief go in as one fenced untrusted block; the brief's coins are
   * the names to avoid. The request ends `refused` before any cap or run when the brief is gone.
   */
  const topicJob = (req: AngleRequest): Job => {
    const researchRequestId = req.researchRequestId as number;
    const found = store.researchBriefOf(researchRequestId);
    return {
      key: `angle:${req.id}`,
      label: req.metaLabel,
      eventAt: req.createdAt,
      angle: { requestId: req.id },
      guarded: () => store.angleTrioProposalIds(req.id).length > 0,
      refusal: () => (found ? undefined : "the Research brief is gone"),
      capReason: (now) => (store.researchProposalsSince(new Date(now.getTime() - DAY_MS).toISOString()) >= MAX_NEW_PROPOSALS_PER_DAY ? `daily cap of ${MAX_NEW_PROPOSALS_PER_DAY} new Proposals reached` : undefined),
      prepare: (): Prepared => {
        const { topic, brief } = found as NonNullable<typeof found>; // `refusal` ended the request before this runs when the brief is gone
        const existing: ExistingToken[] = brief.coins.map((c) => ({ name: c.name, symbol: c.symbol }));
        const legitimacy = store.getRubric().dimensions.find((d) => d.key === "legitimacy")?.description ?? "";
        const reason = `Topic "${cleanLine(topic, 60)}": ${brief.coins.length} coins, ${brief.freeNames.length} free names in the Research brief`;
        const { playbook, ideaLessons, playbookVersions } = readLessons(store); // human researcher tickets 09 and 19: read once for the try
        return {
          existing,
          promptFor: (retry) => topicMemePromptFor({ topic, story: brief.story, coins: brief.coins, freeNames: brief.freeNames, avoid: avoidLabels(existing), legitimacy, ...(playbook ? { playbook } : {}), ...(ideaLessons ? { ideaLessons } : {}), ...retryFields(retry) }),
          create: (ideas, at, runIds) => {
            const snapshot: TopicSnapshotV4 = {
              version: 4,
              kind: "topic",
              capturedAt: at.toISOString(),
              topic: { requestId: researchRequestId, text: topic },
              brief: {
                story: brief.story,
                coins: brief.coins.map((c) => ({ ca: c.ca, name: c.name, symbol: c.symbol, marketCapUsd: c.marketCapUsd, bonded: c.bonded })),
                freeNames: brief.freeNames.map((n) => ({ name: n.name, ticker: n.ticker })),
                createdAt: brief.createdAt,
              },
              trigger: { kind: "operator-topic", reason, at: req.createdAt },
            };
            return store.createMemeProposals(
              {
                metaKey: topicKey(researchRequestId),
                metaLabel: topic,
                snapshot,
                reason: `Operator pressed Make ideas on a Research brief: ${reason}`,
                summary: `From a Research brief on "${cleanLine(topic, 80)}": ${cleanLine(brief.story, 120)}`,
                evidenceLinks: evidenceFor(
                  brief.coins.map((c) => ({ mint: c.ca })),
                  brief.sources.flatMap((s) => (s.url !== null ? [{ title: s.title, sourceLabel: "", url: s.url, publishedAt: "" }] : [])),
                ),
                ideas,
                operatorAngle: { requestId: req.id, angle: topic, sourceUrl: null, urlDropped: false, source: "topic", researchRequestId },
                ...playbookVersions,
              },
              { now: at, attachRunId: runIds },
            );
          },
          doneLine: (made) => `${made.length} ideas for the Research brief on "${cleanLine(topic, 60)}" (request ${req.id}; proposals ${made.map((p) => p.id).join(", ")})`,
        };
      },
    };
  };

  // Metas first, then the stories (Q8): a story is tried only when the Metas left room in this pass. The angle pass has only the Operator's requests.
  const jobs: Job[] = anglesOnly ? angleQueue.map((r) => (r.researchRequestId !== null ? topicJob(r) : angleJob(r))) :[...(current ? metaQueue.map((d) => metaJob(d, current)) : []), ...newsQueue.map(newsJob)];

  for (const [index, job] of jobs.entries()) {
    if (opts.signal?.aborted) return { ...out, stoppedBy: "interrupted" };
    const now = clock();
    /** An Operator's angle request ends with its job's outcome; any other job has no request. */
    const endRequest = (status: "done" | "refused" | "failed" | "capped", detail: string, proposalIds?: number[]) => {
      if (job.angle) store.resolveAngleRequest(job.angle.requestId, { status, detail, ...(proposalIds ? { proposalIds } : {}) }, clock());
    };
    /** A rate limit, a shutdown or a dry run ends the pass and leaves an Operator's request waiting for the next one. */
    const stopPass = (stoppedBy: NonNullable<MemeResult["stoppedBy"]>): MemeResult => {
      if (job.angle) store.releaseAngleRequest(job.angle.requestId);
      return { ...out, stoppedBy };
    };
    // The trio guard (ADR 0013): a Meta that got a trio in the last 6 h gets none, whatever the trigger (an event too); a story has one ever.
    // An angle request is guarded by its own id: a trio it already made (the worker stopped before the request was ended) ends it done.
    if (job.guarded(now)) {
      out.skipped++;
      if (job.angle) {
        const ids = store.angleTrioProposalIds(job.angle.requestId);
        endRequest("done", `${ids.length} ideas`, ids);
      }
      continue;
    }
    const refusal = job.refusal?.(now);
    if (refusal !== undefined) {
      out.refused++;
      log(`[worker] meme ideas: "${cleanLine(job.label, 60)}" refused: ${refusal}`);
      endRequest("refused", refusal);
      continue;
    }
    if (tried >= config.maxPerPass) break;

    const capReason = job.capReason?.(now);
    if (capReason !== undefined) {
      log(`[worker] meme ideas: ${capReason}; "${cleanLine(job.label, 60)}" is capped`);
      endRequest("capped", capReason);
      return { ...out, stoppedBy: "proposal-cap" };
    }
    const gate = mayRun(job);
    if (!gate.ok) {
      const waiting = jobs.slice(index + 1).filter((j) => !j.guarded(now));
      log(`[worker] meme ideas: ${gate.detail}; "${cleanLine(job.label, 60)}" waits${waiting.length > 0 ? `, and so ${waiting.length === 1 ? "does" : "do"} ${waiting.map((j) => `"${cleanLine(j.label, 60)}"`).join(", ")}` : ""}`);
      // A request is answered, not left waiting: it ends capped with the reason, and the Operator asks again when the cap has room.
      endRequest("capped", gate.detail);
      return { ...out, stoppedBy: gate.stoppedBy };
    }
    if (job.angle && store.claimAngleRequest(job.angle.requestId) === undefined) continue; // taken or ended by someone else
    tried++;

    // The subject's context, read once per try.
    const prepared = job.prepare(now);
    const { existing, promptFor } = prepared;

    const record = (outcome: MemeOutcome, detail: string, runs: number) => store.meme.record({ key: job.key, eventAt: job.eventAt, at: clock().toISOString(), outcome, detail, runs });

    /**
     * The answer's check: the schema and the subject's own tokens (`parseMemeOutput`), then DexScreener's live tokens. A name that only a dead
     * or drained token uses passes, with a note per idea (ticket 16).
     */
    const check = async (output: string): Promise<Checked> => {
      const parsed = parseMemeOutput(output, existing);
      if (!parsed.ok) return parsed;
      const listed = await dexCopies(parsed.ideas, opts.dex, log);
      return listed.live.length > 0 ? { ok: false, problem: "a name or ticker copies a live token DexScreener lists", copies: listed.live } : { ...parsed, notes: listed.notes };
    };

    const first = await ask(promptFor(), job.label, job.angle !== undefined);
    if (first.kind === "stop") return stopPass(first.stoppedBy);
    if (first.kind === "failed") {
      out.failed++;
      endRequest(first.budget ? "refused" : "failed", first.budget ? "the run went over its budget" : "the run failed");
      // A run that was too dear is not a sign of an outage and is not tried again at once: it waits for the next refresh like a refusal.
      record(first.budget ? "refused" : "failed", first.budget ? "the run went over its budget" : "the run failed", 1);
      if (first.budget) transientInARow = 0;
      else if (++transientInARow >= config.maxConsecutiveFailures) {
        log(`[worker] meme ideas: ${transientInARow} consecutive failures (claude missing, auth or network trouble?); stopping the pass, the next tick tries again`);
        return { ...out, stoppedBy: "backoff" };
      }
      continue;
    }
    transientInARow = 0;
    let parsed = await check(first.result.output);
    finish(first, parsed.ok);
    const runIds = [first.runId];
    if (!parsed.ok) log(`[worker] meme ideas: "${cleanLine(job.label, 60)}" refused: ${parsed.problem}. Output not stored: ${JSON.stringify(first.result.output.trim().slice(0, 200))}`);

    // A refusal goes back once per kind, each retry one more run under the same caps: a copied name with the copied names listed, a contract
    // error (ticket 16) with the exact error. The two are independent, so one request makes at most three runs.
    let copyRetried = false;
    let repairRetried = false;
    while (!parsed.ok) {
      const copies = parsed.copies;
      if (copies !== undefined ? copyRetried : repairRetried) break;
      if (copies !== undefined) copyRetried = true;
      else repairRetried = true;
      const retryGate = mayRun(job);
      if (!retryGate.ok) {
        log(`[worker] meme ideas: "${cleanLine(job.label, 60)}" was refused (${parsed.problem}) but ${retryGate.detail}; nothing stored`);
        break;
      }
      const next = await ask(promptFor(copies !== undefined ? { copies } : { problem: parsed.repair ?? parsed.problem }), job.label, job.angle !== undefined);
      if (next.kind === "stop") {
        record(copies !== undefined ? "name-copy" : "refused", "interrupted before the retry", runIds.length);
        return stopPass(next.stoppedBy);
      }
      if (next.kind !== "ok") break;
      runIds.push(next.runId);
      parsed = await check(next.result.output);
      finish(next, parsed.ok);
      if (!parsed.ok) log(`[worker] meme ideas: "${cleanLine(job.label, 60)}" retry refused: ${parsed.problem}. Output not stored: ${JSON.stringify(next.result.output.trim().slice(0, 200))}`);
    }
    if (!parsed.ok) {
      out.refused++;
      record(parsed.copies !== undefined ? "name-copy" : "refused", parsed.problem, runIds.length);
      endRequest("refused", parsed.problem);
      continue;
    }

    // The ideas are valid and distinct. Collision checks of each name, then the trio is stored in one transaction.
    const ideas: NewMemeIdea[] = [];
    for (const [i, idea] of parsed.ideas.entries()) {
      const collisions = await collisionsOf(idea, opts.collisions, log);
      const copyNote = parsed.notes[i];
      ideas.push({ ...idea, ...(collisions ? { collisions } : {}), ...(copyNote !== undefined ? { copyNote } : {}) });
    }
    let made: Proposal[] | "withdrawn";
    try {
      made = prepared.create(ideas, now, runIds);
    } catch (e) {
      if (e instanceof MemeTrioExistsError) {
        record("exists", "the subject already had a trio", runIds.length);
        log(`[worker] meme ideas: "${cleanLine(job.label, 60)}" already has a trio; answer dropped`);
        endRequest("refused", "the ideas for this request already exist");
        continue;
      }
      out.failed++;
      record("failed", "the ideas could not be stored", runIds.length);
      endRequest("failed", "the ideas could not be stored");
      log(`[worker] meme ideas: "${cleanLine(job.label, 60)}" not stored: ${e instanceof Error ? e.message : String(e)}`);
      if (++transientInARow >= config.maxConsecutiveFailures) return { ...out, stoppedBy: "backoff" };
      continue;
    }
    if (made === "withdrawn") {
      out.withdrawn++;
      record("withdrawn", "the story stopped being eligible before the ideas were stored", runIds.length);
      log(`[worker] meme ideas: "${cleanLine(job.label, 60)}" is no longer eligible; answer dropped`);
      continue;
    }
    out.stored++;
    record("stored", `${made.length} ideas`, runIds.length);
    endRequest("done", `${made.length} ideas`, made.map((p) => p.id));
    log(`[worker] meme ideas: ${prepared.doneLine(made)}`);
  }
  return out;
}

/**
 * The Operator's angle step (ticket 11): runs the pending angle requests through `generateMemeIdeas`'s own loop (the same switch, caps, name
 * checks, collision checks and storage) and nothing else. The worker calls it after the meme pass and on its own fast tick, so a request
 * does not wait for the next Meta ranking.
 */
export function runMemeAngles(store: Datastore, brain: Brain, opts: MemeOptions = {}): Promise<MemeResult> {
  // The Operator asked for these (the angle box or "Make ideas"): they run with the automatic switch (ARGUS_MEME_IDEAS) off, under the same caps.
  return generateMemeIdeas(store, brain, { ...opts, enabled: true, jobs: "angles" });
}

/** The list line of an idea: the Meta, its leader and cap, and what triggered the run, written by code from the stored Meta (text still creator-derived: cleaned and cut). */
export function summaryLine(meta: Pick<CurrentMeta, "label" | "leader" | "counts">, kind: MemeTriggerKind): string {
  return `Meta ${cleanLine(meta.label, 60)}: led by ${cleanLine(leaderTag(meta.leader), 40)}${leaderAt(meta.leader.marketCapUsd)}, ${meta.counts["24h"].creators} creators in 24 h. ${kind === "new-meta" ? "New Meta" : "Refresh after 12 h"}.`;
}

/** An answer that passed the schema and the Meta's tokens, with one note per idea (undefined when none) for a dead token that uses its name or ticker. */
type Checked = Exclude<MemeParse, { ok: true }> | (Extract<MemeParse, { ok: true }> & { notes: (string | undefined)[] });

/**
 * What DexScreener says about each idea's name and ticker (ticket 16): `live`, the live Solana tokens the ideas copy, as display labels (they
 * refuse the answer); `notes`, one per idea, naming the dead or drained tokens it copies (they do not). A lookup that fails is logged and
 * skips that idea.
 */
async function dexCopies(ideas: readonly MemeIdea[], dex: MemeDexClient | undefined, log: (line: string) => void): Promise<{ live: string[]; notes: (string | undefined)[] }> {
  const live: string[] = [];
  const notes: (string | undefined)[] = [];
  for (const idea of ideas) {
    let note: string | undefined;
    if (dex) {
      try {
        const found = deadTokenNotes(idea, [...(await dex.search(idea.name)), ...(await dex.search(idea.ticker))]);
        for (const c of found.live) if (!live.includes(c)) live.push(c);
        note = found.note;
      } catch (e) {
        log(`[worker] meme ideas: DexScreener name lookup failed, that idea is checked against the Meta's tokens only: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    notes.push(note);
  }
  return { live, notes };
}

/** The collision checks of one idea; a checker that throws leaves it unchecked (undefined), which the card shows as "not checked", never as clear. */
async function collisionsOf(idea: { name: string; ticker: string }, checker: CollisionChecker | undefined, log: (line: string) => void): Promise<CollisionResult | undefined> {
  if (!checker) return undefined;
  try {
    return await checker.check({ name: idea.name, ticker: idea.ticker });
  } catch (e) {
    log(`[worker] meme ideas: collision check failed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}
