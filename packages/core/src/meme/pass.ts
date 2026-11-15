import type { ExistingToken } from "../beta/distinct-name.ts";
import { rankRoomLeft } from "../beta/room-left.ts";
import { BrainError, type Brain, type BrainRun } from "../brain.ts";
import type { CollisionChecker, CollisionResult } from "../collision.ts";
import { MemeTrioExistsError, type Datastore, type Proposal } from "../datastore.ts";
import { InvalidEvidenceLinkError, normalizeEvidenceLinks } from "../evidence-links.ts";
import { META_RULE, type MetaConfig } from "../meta/config.ts";
import { groupTokens } from "../meta/group.ts";
import { newsForKeys } from "../meta/news.ts";
import { leaderTag } from "../meta/new-meta.ts";
import type { CurrentMeta, MetaNewEvent, MetaRun } from "../meta/store.ts";
import { currentSummaryFresh, metaMoney } from "../meta/summary.ts";
import { mergeThemes } from "../meta/theme.ts";
import { DEFAULT_RESEARCH_BUDGET_CONFIG, researchRunCaps, researchUsage, type ResearchBudgetConfig } from "../research-budget.ts";
import type { DexPair } from "../sources/dexscreener.ts";
import type { LaunchedToken } from "../study/store.ts";
import { avoidLabels, cleanLine, copiedNames, memeIdeasPromptFor, MEME_PROMPT_NEWS, MEME_PROMPT_TOKENS, parseMemeOutput, type MemeIdea, type MemeParse, type MemePromptToken } from "./ideas.ts";
import type { MemeAttempt, MemeOutcome } from "./store.ts";
import { MEME_REFRESH_MS, MEME_WINDOW_MS, type MemeTriggerKind, type MetaSnapshotV2, type NewMemeIdea, type SnapshotNews } from "./types.ts";

/**
 * The meme ideas pass (ADR 0013, amended by meta redesign ticket 03): for each current Meta (ADR 0014; a Watching subject never), one
 * sonnet run that returns three meme ideas, stored as `meme` Proposals. It follows the Meta summary pass:
 * - the trigger is plain code and nothing else (news is context, ADR 0011): a Meta is due when a live New Meta event has not been tried for,
 *   or its last started try is `MEME_REFRESH_MS` (12 h) old, or it was never tried; a failed try is due again after `failedRetryMinutes`.
 *   An event bypasses the 12 h gap but not the 6 h trio guard (`MEME_WINDOW_MS`), so a Meta that leaves and comes back is not run twice;
 * - the order spends the cap well: New Meta events first (oldest first), then refreshes by oldest last try;
 * - its own cap of `maxRunsPerDay` runs (8) in any rolling 24 hours (refused and failed ones included, the retry included), taken from the
 *   shared research budget: a reached cap is recorded once per slot with its reason, logs what waits, and ends the pass without error;
 * - an `in-flight` brain_runs row exists before the child is spawned and the run's cost is recorded the moment it returns;
 * - the answer is untrusted: it must fit `parseMemeOutput` exactly, and no name may copy a token of the Meta's group or one DexScreener
 *   lists (the distinct-name rule); a copy goes back once with the copied names listed, then fails closed with nothing stored;
 * - a rate limit, a budget stop or a shutdown ends the pass at once; three transient failures in a row end it too.
 * Nothing here launches, signs or spends anything (ADR 0002), and nothing makes a Narrative, a Score or a Spec.
 */

/** The most meme-ideas runs started in any rolling 24 hours, whatever is configured: the hard ceiling, which configuration cannot pass. */
export const MAX_MEME_RUNS_PER_DAY = 40;

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

/** 8 runs a day (Operator, 2026-11-15): three Metas refreshed every 12 h is 6, with room for new Metas and a retry. */
export const DEFAULT_MEME_CONFIG: MemeConfig = { maxRunsPerDay: 8, maxPerPass: 3, failedRetryMinutes: 30, maxConsecutiveFailures: 3 };

/**
 * ARGUS_MEME_IDEAS (`1` turns the pass on; unset, empty or `0` leave it off; anything else is an error) and ARGUS_MEME_MAX_PER_DAY (a
 * whole number from 1 to the hard ceiling of 40, which may lower or raise the default of 8). An invalid value is an error and never a
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
  stoppedBy?: "off" | "api-hold" | "daily-cap" | "research-cap" | "rate-limited" | "interrupted" | "dry-run" | "backoff";
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
  trigger: { kind: MemeTriggerKind; reason: string; at: string };
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
export function dueMetas(metas: readonly CurrentMeta[], events: ReadonlyMap<string, Pick<MetaNewEvent, "raisedAt">>, lastTry: (key: string) => Pick<MemeAttempt, "at" | "outcome" | "eventAt"> | undefined, now: Date, config: Pick<MemeConfig, "failedRetryMinutes">): MemeDue[] {
  const due: MemeDue[] = [];
  for (const meta of metas) {
    const last = lastTry(meta.key);
    const event = events.get(meta.key);
    if (event && (!last || last.at < event.raisedAt)) {
      due.push({ meta, kind: "new-meta", eventAt: event.raisedAt, since: event.raisedAt });
    } else if (last?.outcome === "failed") {
      if (now.getTime() - Date.parse(last.at) < config.failedRetryMinutes * 60_000) continue;
      due.push({ meta, kind: event?.raisedAt === last.eventAt ? "new-meta" : "refresh", eventAt: last.eventAt, since: last.eventAt });
    } else if (!last) {
      due.push({ meta, kind: "refresh", eventAt: meta.enteredAt, since: meta.enteredAt });
    } else if (now.getTime() - Date.parse(last.at) >= MEME_REFRESH_MS) {
      due.push({ meta, kind: "refresh", eventAt: new Date(Date.parse(last.at) + MEME_REFRESH_MS).toISOString(), since: last.at });
    }
  }
  const rank = (d: MemeDue) => (d.kind === "new-meta" ? 0 : 1);
  return due.sort((a, b) => rank(a) - rank(b) || (a.since < b.since ? -1 : a.since > b.since ? 1 : 0) || (a.meta.key < b.meta.key ? -1 : 1));
}

/** "$JENSEN at $2.4M, 14 creators in 24 h": a Meta's leader, cap and copies as the stored reason and the prompt state them. Creator text is cleaned and cut. */
export function metaFacts(m: Pick<CurrentMeta, "leader" | "counts">): string {
  const copies = m.counts["24h"].creators;
  return `${leaderTag(m.leader)} at ${metaMoney(m.leader.marketCapUsd)}, ${copies} ${copies === 1 ? "creator" : "creators"} in 24 h`;
}

type Asked = { kind: "ok"; runId: number; result: BrainRun<string> } | { kind: "stop"; stoppedBy: NonNullable<MemeResult["stoppedBy"]> } | { kind: "failed"; budget: boolean };

export async function generateMemeIdeas(store: Datastore, brain: Brain, opts: MemeOptions = {}): Promise<MemeResult> {
  const out: MemeResult = { called: 0, stored: 0, refused: 0, failed: 0, skipped: 0 };
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

  // The Metas as of the newest run (ADR 0014). A run older than the carried state's limit no longer describes the market: nothing is due.
  const current = store.currentMetas();
  if (!current) return out;
  const startedAt = clock();
  const runAge = startedAt.getTime() - Date.parse(current.computedAt);
  if (!Number.isFinite(runAge) || runAge > metaConfig.stateMaxMinutes * 60_000) return out;
  // The live New Meta events, newest per Meta. An event is live for `newMetaLiveHours`; its Meta must still be a Meta in the newest run.
  const events = new Map<string, MetaNewEvent>();
  for (const e of store.newMetaEvents(new Date(startedAt.getTime() - metaConfig.newMetaLiveHours * HOUR_MS).toISOString())) if (!events.has(e.key)) events.set(e.key, e);
  const queue = dueMetas(current.metas, events, (key) => store.meme.lastTry(key), startedAt, config);
  if (queue.length === 0) return out;
  // The launch-theme run only feeds the room-left ranking (an input to the prompt, never a gate).
  const launchRun = store.latestMetas("24h", 200);

  let transientInARow = 0;
  let tried = 0;

  /** Whether another meme-ideas run may start: the daily cap and the research budget. A refusal is recorded with its reason once per slot. */
  const mayRun = (due: MemeDue): { ok: true } | { ok: false; stoppedBy: "daily-cap" | "research-cap"; detail: string } => {
    const spent = store.memeIdeasSpendSince(new Date(clock().getTime() - DAY_MS).toISOString(), caps);
    if (spent.runs >= maxRunsPerDay) {
      const detail = `daily cap of ${maxRunsPerDay} meme-ideas runs reached (${spent.runs} runs, $${spent.chargedUsd.toFixed(4)} in 24 h)`;
      store.meme.record({ key: due.meta.key, eventAt: due.eventAt, at: clock().toISOString(), outcome: "daily-cap", detail, runs: 0 });
      return { ok: false, stoppedBy: "daily-cap", detail };
    }
    const usage = researchUsage(store, clock(), research, caps);
    if (usage.exhausted) {
      const detail = `research budget reached ($${usage.usedUsd.toFixed(4)} of $${usage.budgetUsd.toFixed(2)} in 24 h, judge, propose, summaries and meme ideas together)`;
      store.meme.record({ key: due.meta.key, eventAt: due.eventAt, at: clock().toISOString(), outcome: "research-cap", detail, runs: 0 });
      return { ok: false, stoppedBy: "research-cap", detail };
    }
    return { ok: true };
  };

  /** One meme-ideas run: an in-flight row first, the cost recorded the moment it returns. */
  const ask = async (prompt: string, label: string): Promise<Asked> => {
    const runId = store.startBrainRun({ proposalId: 0, task: "meme-ideas", ...brain.routeFor("meme-ideas") }, clock());
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

  for (const [index, due] of queue.entries()) {
    if (opts.signal?.aborted) return { ...out, stoppedBy: "interrupted" };
    const meta = due.meta;
    const now = clock();
    // The trio guard (ADR 0013): a Meta that got a trio in the last 6 h gets none, whatever the trigger (an event too).
    if (store.hasMemeSince(meta.key, new Date(now.getTime() - MEME_WINDOW_MS).toISOString())) {
      out.skipped++;
      continue;
    }
    if (tried >= config.maxPerPass) break;

    const gate = mayRun(due);
    if (!gate.ok) {
      const waiting = queue.slice(index + 1).filter((d) => !store.hasMemeSince(d.meta.key, new Date(now.getTime() - MEME_WINDOW_MS).toISOString()));
      log(`[worker] meme ideas: ${gate.detail}; "${cleanLine(meta.label, 60)}" waits${waiting.length > 0 ? `, and so ${waiting.length === 1 ? "does" : "do"} ${waiting.map((d) => `"${cleanLine(d.meta.label, 60)}"`).join(", ")}` : ""}`);
      return { ...out, stoppedBy: gate.stoppedBy };
    }
    tried++;

    // The Meta's context, read once per try.
    const group = groupOf(store, meta.key, current.computedAt, metaConfig);
    const tokens = shownTokens(store, meta, group);
    const existing: ExistingToken[] = [
      { name: meta.leader.name, symbol: meta.leader.symbol },
      ...(group.length > 0 ? group.map((t) => ({ name: t.name, symbol: t.symbol })) : meta.topTokens.map((t) => ({ name: t.name, symbol: t.symbol }))),
    ];
    const news: SnapshotNews[] = (newsForKeys(store, [meta.key], now, metaConfig).get(meta.key) ?? []).map((n) => ({ title: n.title, sourceLabel: n.sourceLabel, url: n.url, publishedAt: n.publishedAt }));
    const roomLeft = launchRun ? roomLeftOf(launchRun, meta.key) : { passed: false, text: "no room-left verdict for this Meta" };
    const legitimacy = store.getRubric().dimensions.find((d) => d.key === "legitimacy")?.description ?? "";
    const facts = metaFacts(meta);
    const trigger = { kind: due.kind, reason: facts, at: due.eventAt };
    const promptFor = (retryCopies?: readonly string[]) =>
      memeIdeasPromptFor({ label: meta.label, counts: meta.counts, enteredAt: meta.enteredAt, leader: meta.leader, trigger, tokens, avoid: avoidLabels(existing), news, roomLeft: roomLeft.text, legitimacy, ...(retryCopies ? { retryCopies } : {}) });

    const record = (outcome: MemeOutcome, detail: string, runs: number) => store.meme.record({ key: meta.key, eventAt: due.eventAt, at: clock().toISOString(), outcome, detail, runs });

    /** The answer's check: the schema and the Meta's own tokens (`parseMemeOutput`), then DexScreener's. */
    const check = async (output: string): Promise<MemeParse> => {
      const parsed = parseMemeOutput(output, existing);
      if (!parsed.ok) return parsed;
      const listed = await dexCopies(parsed.ideas, opts.dex, log);
      return listed.length > 0 ? { ok: false, problem: "a name or ticker copies a token DexScreener lists", copies: listed } : parsed;
    };

    const first = await ask(promptFor(), meta.label);
    if (first.kind === "stop") return { ...out, stoppedBy: first.stoppedBy };
    if (first.kind === "failed") {
      out.failed++;
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
    if (!parsed.ok) log(`[worker] meme ideas: "${cleanLine(meta.label, 60)}" refused: ${parsed.problem}. Output not stored: ${JSON.stringify(first.result.output.trim().slice(0, 200))}`);

    // A copied name goes back exactly once, with the copied names listed; the retry is one more run under the same caps.
    if (!parsed.ok && parsed.copies !== undefined) {
      const retryGate = mayRun(due);
      if (!retryGate.ok) {
        log(`[worker] meme ideas: "${cleanLine(meta.label, 60)}" copies existing names but ${retryGate.detail}; nothing stored`);
      } else {
        const second = await ask(promptFor(parsed.copies), meta.label);
        if (second.kind === "stop") {
          record("name-copy", "interrupted before the retry", runIds.length);
          return { ...out, stoppedBy: second.stoppedBy };
        }
        if (second.kind === "ok") {
          runIds.push(second.runId);
          parsed = await check(second.result.output);
          finish(second, parsed.ok);
          if (!parsed.ok) log(`[worker] meme ideas: "${cleanLine(meta.label, 60)}" retry refused: ${parsed.problem}. Output not stored: ${JSON.stringify(second.result.output.trim().slice(0, 200))}`);
        }
      }
    }
    if (!parsed.ok) {
      out.refused++;
      record(parsed.copies !== undefined ? "name-copy" : "refused", parsed.problem, runIds.length);
      continue;
    }

    // The ideas are valid and distinct. Collision checks of each name, then the trio is stored in one transaction.
    const ideas: NewMemeIdea[] = [];
    for (const idea of parsed.ideas) {
      const collisions = await collisionsOf(idea, opts.collisions, log);
      ideas.push({ ...idea, ...(collisions ? { collisions } : {}) });
    }
    const stored = store.meta.summaries([meta.key]).get(meta.key);
    const snapshot = buildSnapshot({ now, meta, run: { id: current.runId, computedAt: current.computedAt }, trigger, ...(currentSummaryFresh(stored, now.getTime()) && stored?.summary ? { summary: stored.summary } : {}), roomLeft, tokens, news });
    let made: Proposal[];
    try {
      made = store.createMemeProposals(
        {
          metaKey: meta.key,
          metaLabel: meta.label,
          snapshot,
          reason: `${due.kind === "new-meta" ? "New Meta" : "Meta refresh"}: ${facts}`,
          summary: summaryLine(meta, due.kind),
          evidenceLinks: evidenceFor([meta.leader, ...meta.topTokens], news),
          ideas,
        },
        { now, attachRunId: runIds },
      );
    } catch (e) {
      if (e instanceof MemeTrioExistsError) {
        record("exists", "the Meta already had a trio in the last 6 h", runIds.length);
        log(`[worker] meme ideas: "${cleanLine(meta.label, 60)}" already has a trio; answer dropped`);
        continue;
      }
      out.failed++;
      record("failed", "the ideas could not be stored", runIds.length);
      log(`[worker] meme ideas: "${cleanLine(meta.label, 60)}" not stored: ${e instanceof Error ? e.message : String(e)}`);
      if (++transientInARow >= config.maxConsecutiveFailures) return { ...out, stoppedBy: "backoff" };
      continue;
    }
    out.stored++;
    record("stored", `${made.length} ideas`, runIds.length);
    log(`[worker] meme ideas: ${made.length} ideas for "${cleanLine(meta.label, 60)}" (${due.kind === "new-meta" ? "new Meta" : "refresh"}; proposals ${made.map((p) => p.id).join(", ")})`);
  }
  return out;
}

/** The list line of an idea: the Meta, its leader and cap, and what triggered the run, written by code from the stored Meta (text still creator-derived: cleaned and cut). */
export function summaryLine(meta: Pick<CurrentMeta, "label" | "leader" | "counts">, kind: MemeTriggerKind): string {
  return `Meta ${cleanLine(meta.label, 60)}: led by ${cleanLine(leaderTag(meta.leader), 40)} at ${metaMoney(meta.leader.marketCapUsd)}, ${meta.counts["24h"].creators} creators in 24 h. ${kind === "new-meta" ? "New Meta" : "Refresh after 12 h"}.`;
}

/** The existing tokens DexScreener lists on Solana for each idea's name and ticker that the idea copies, as display labels. A lookup that fails is logged and skips that idea. */
async function dexCopies(ideas: readonly MemeIdea[], dex: MemeDexClient | undefined, log: (line: string) => void): Promise<string[]> {
  if (!dex) return [];
  const out: string[] = [];
  for (const idea of ideas) {
    try {
      const pairs = [...(await dex.search(idea.name)), ...(await dex.search(idea.ticker))].filter((p) => p.chainId === "solana");
      for (const c of copiedNames([idea], pairs.map((p) => ({ name: p.name, symbol: p.symbol })))) if (!out.includes(c)) out.push(c);
    } catch (e) {
      log(`[worker] meme ideas: DexScreener name lookup failed, that idea is checked against the Meta's tokens only: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
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
