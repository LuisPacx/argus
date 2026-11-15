import type { ExistingToken } from "../beta/distinct-name.ts";
import { rankRoomLeft } from "../beta/room-left.ts";
import { BrainError, type Brain, type BrainRun } from "../brain.ts";
import type { CollisionChecker, CollisionResult } from "../collision.ts";
import { MemeTrioExistsError, type Datastore, type Proposal } from "../datastore.ts";
import { InvalidEvidenceLinkError, normalizeEvidenceLinks } from "../evidence-links.ts";
import { META_RULE, type MetaConfig } from "../meta/config.ts";
import { groupTokens } from "../meta/group.ts";
import { newsForKeys } from "../meta/news.ts";
import type { MetaHotEvent, MetaRow, MetaRun } from "../meta/store.ts";
import { mergeThemes } from "../meta/theme.ts";
import { DEFAULT_RESEARCH_BUDGET_CONFIG, researchRunCaps, researchUsage, type ResearchBudgetConfig } from "../research-budget.ts";
import type { DexPair } from "../sources/dexscreener.ts";
import type { LaunchedToken } from "../study/store.ts";
import { avoidLabels, cleanLine, copiedNames, memeIdeasPromptFor, MEME_PROMPT_NEWS, MEME_PROMPT_TOKENS, parseMemeOutput, type MemeIdea, type MemeParse, type MemePromptToken } from "./ideas.ts";
import type { MemeOutcome } from "./store.ts";
import { MEME_WINDOW_MS, type MetaSnapshot, type NewMemeIdea, type SnapshotNews } from "./types.ts";

/**
 * The meme ideas pass (ADR 0013, missed ideas ticket 06): for each Meta whose Hot now event is live, one sonnet run that returns three
 * meme ideas, stored as `meme` Proposals. It follows the Meta summary pass:
 * - the trigger is a stored Hot now event and nothing else (news is context, ADR 0011), at most once per Meta per 6 h whatever became
 *   of the last try (`meme_attempts`, and the Proposals themselves);
 * - its own cap of `maxRunsPerDay` runs in any rolling 24 hours (refused and failed ones included, the retry included), taken from the
 *   shared research budget: a reached cap is recorded with its reason and ends the pass without error;
 * - an `in-flight` brain_runs row exists before the child is spawned and the run's cost is recorded the moment it returns;
 * - the answer is untrusted: it must fit `parseMemeOutput` exactly, and no name may copy a token of the Meta's group or one DexScreener
 *   lists (the distinct-name rule); a copy goes back once with the copied names listed, then fails closed with nothing stored;
 * - a rate limit, a budget stop or a shutdown ends the pass at once; three transient failures in a row end it too.
 * Nothing here launches, signs or spends anything (ADR 0002), and nothing makes a Narrative, a Score or a Spec.
 */

/** The most meme-ideas runs started in any rolling 24 hours, whatever is configured: configuration can only lower it. */
export const MAX_MEME_RUNS_PER_DAY = 40;

export interface MemeConfig {
  /** Most meme-ideas runs started in any rolling 24 hours (the retry for a copied name included); hard cap `MAX_MEME_RUNS_PER_DAY`. */
  maxRunsPerDay: number;
  /** Most Metas tried in one pass. */
  maxPerPass: number;
  /** A try that failed (not refused) is tried again no sooner than this many minutes later. */
  failedRetryMinutes: number;
  /** This many transient failures in a row end the pass, as a rate limit does. */
  maxConsecutiveFailures: number;
}

export const DEFAULT_MEME_CONFIG: MemeConfig = { maxRunsPerDay: MAX_MEME_RUNS_PER_DAY, maxPerPass: 3, failedRetryMinutes: 30, maxConsecutiveFailures: 3 };

/**
 * ARGUS_MEME_IDEAS (`1` turns the pass on; unset, empty or `0` leave it off; anything else is an error) and ARGUS_MEME_MAX_PER_DAY (a
 * whole number from 1 to 40 that can only LOWER the cap in code). An invalid value is an error and never a fallback, as for the other
 * ARGUS_* caps.
 */
export function memeConfigFromEnv(env: Record<string, string | undefined>): { enabled: boolean; config: MemeConfig } {
  const rawSwitch = env.ARGUS_MEME_IDEAS?.trim() ?? "";
  if (rawSwitch !== "" && rawSwitch !== "0" && rawSwitch !== "1") throw new Error(`ARGUS_MEME_IDEAS must be 1 (on) or 0 or unset (off), got "${env.ARGUS_MEME_IDEAS}"`);
  const rawCap = env.ARGUS_MEME_MAX_PER_DAY?.trim() ?? "";
  let maxRunsPerDay = DEFAULT_MEME_CONFIG.maxRunsPerDay;
  if (rawCap !== "") {
    const v = Number(rawCap);
    if (!Number.isInteger(v) || v < 1) throw new Error(`ARGUS_MEME_MAX_PER_DAY must be a whole number, 1 or more, got "${env.ARGUS_MEME_MAX_PER_DAY}"`);
    if (v > MAX_MEME_RUNS_PER_DAY) throw new Error(`ARGUS_MEME_MAX_PER_DAY must be at most ${MAX_MEME_RUNS_PER_DAY} (a hard cap in code; configuration can only lower it), got "${env.ARGUS_MEME_MAX_PER_DAY}"`);
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
  /** Hot Metas passed over because they were tried within the last 6 h. */
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

/** The tokens of the Meta's group as of the run: the same grouping and theme merge the ranking used, so the group is the one the row counted. */
function groupOf(store: Datastore, row: MetaRow, computedAt: string, config: MetaConfig): LaunchedToken[] {
  const to = Date.parse(computedAt);
  const tokens = store.study.createdBetween(new Date(to - DAY_MS).toISOString(), computedAt);
  const clones = groupTokens(tokens);
  const groups = config.theme ? mergeThemes(clones, config.theme) : clones;
  return groups.find((g) => g.key === row.key)?.tokens ?? [];
}

/** Up to 8 tokens for the prompt and the snapshot: the row's top tokens first, then migrated ones, then the earliest creates. */
function shownTokens(store: Datastore, row: MetaRow, group: readonly LaunchedToken[]): MemePromptToken[] {
  const caps = new Map(row.topTokens.flatMap((t) => (t.marketCapUsd !== undefined ? [[t.mint, t.marketCapUsd] as const] : [])));
  const first = new Map(row.topTokens.map((t, i) => [t.mint, i]));
  const ordered = [...group].sort(
    (a, b) =>
      (first.get(a.mint) ?? 99) - (first.get(b.mint) ?? 99) ||
      (a.migratedAt === null ? 1 : 0) - (b.migratedAt === null ? 1 : 0) ||
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
      (a.mint < b.mint ? -1 : 1),
  );
  const shown = ordered.slice(0, MEME_PROMPT_TOKENS);
  if (shown.length === 0) return row.topTokens.map((t) => ({ mint: t.mint, name: t.name, symbol: t.symbol, migrated: false, ...(t.marketCapUsd !== undefined ? { marketCapUsd: t.marketCapUsd } : {}) }));
  return shown.map((t) => {
    const description = store.study.getSnapshot(t.mint)?.description;
    const cap = caps.get(t.mint);
    return {
      mint: t.mint,
      name: t.name,
      symbol: t.symbol,
      migrated: t.migratedAt !== null,
      ...(cap !== undefined ? { marketCapUsd: cap } : {}),
      ...(description !== undefined && description !== "" ? { description } : {}),
    };
  });
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

/** The Meta as it stands, in the shape that is stored with each idea and never changed. */
export function buildSnapshot(args: { now: Date; row: MetaRow; run: MetaRun; hot: MetaHotEvent; roomLeft: { passed: boolean; text: string }; tokens: readonly MemePromptToken[]; news: readonly SnapshotNews[] }): MetaSnapshot {
  const { row, run, hot } = args;
  return {
    version: 1,
    capturedAt: args.now.toISOString(),
    meta: {
      key: row.key,
      label: row.label,
      rank: row.rank,
      firstSeenAt: row.firstSeenAt,
      counts: row.counts,
      topTokens: row.topTokens,
      ...(row.marketCapUsd !== undefined ? { marketCapUsd: row.marketCapUsd } : {}),
      ...(row.topMarketCapUsd !== undefined ? { topMarketCapUsd: row.topMarketCapUsd } : {}),
      ...(row.summary !== undefined ? { summary: row.summary } : {}),
    },
    run: { id: run.id, computedAt: run.computedAt, window: run.window, baseMigrationRate: run.baseMigrationRate, coverage: run.coverage },
    hot: { reason: hot.reason, raisedAt: hot.raisedAt, rank: hot.rank, creators: hot.creators },
    roomLeft: args.roomLeft,
    tokens: args.tokens.map((t) => ({ mint: t.mint, name: t.name, symbol: t.symbol, migrated: t.migrated, ...(t.marketCapUsd !== undefined ? { marketCapUsd: t.marketCapUsd } : {}) })),
    news: args.news.map((n) => ({ title: n.title, sourceLabel: n.sourceLabel, url: n.url, publishedAt: n.publishedAt })),
  };
}

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * The evidence links, built by code and never by the model: the Meta's top tokens (their DexScreener pages, the host the Meta ranking
 * already links) and the matching news that has a valid http(s) link. At most 3 and 5, distinct.
 */
export function evidenceFor(row: MetaRow, news: readonly SnapshotNews[]): string[] {
  const links: string[] = [];
  for (const t of row.topTokens.slice(0, 3)) if (BASE58_ADDRESS.test(t.mint)) links.push(`https://dexscreener.com/solana/${t.mint}`);
  for (const n of news.slice(0, MEME_PROMPT_NEWS)) {
    try {
      links.push(...normalizeEvidenceLinks([n.url]));
    } catch (e) {
      if (!(e instanceof InvalidEvidenceLinkError)) throw e;
    }
  }
  return normalizeEvidenceLinks(links);
}

/** How soon the Meta may be tried again after a try that ended this way. */
const gapMs = (outcome: MemeOutcome, config: MemeConfig): number => (outcome === "failed" ? config.failedRetryMinutes * 60_000 : MEME_WINDOW_MS);

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

  const run = store.latestMetas("24h", 200);
  if (!run) return out;
  const rows = new Map(run.rows.map((r) => [r.key, r]));
  // The live events, newest per Meta. An event is live for the Hot now cool-down; its Meta must still be in the newest ranking.
  const events: MetaHotEvent[] = [];
  for (const e of store.hotMetaEvents(new Date(clock().getTime() - metaConfig.hotCooldownHours * HOUR_MS).toISOString())) if (!events.some((x) => x.key === e.key)) events.push(e);

  let transientInARow = 0;
  let tried = 0;

  /** Whether another meme-ideas run may start: the daily cap and the research budget. A refusal is recorded with its reason once per event. */
  const mayRun = (event: MetaHotEvent): { ok: true } | { ok: false; stoppedBy: "daily-cap" | "research-cap"; detail: string } => {
    const spent = store.memeIdeasSpendSince(new Date(clock().getTime() - DAY_MS).toISOString(), caps);
    if (spent.runs >= maxRunsPerDay) {
      const detail = `daily cap of ${maxRunsPerDay} meme-ideas runs reached (${spent.runs} runs, $${spent.chargedUsd.toFixed(4)} in 24 h)`;
      store.meme.record({ key: event.key, eventAt: event.raisedAt, at: clock().toISOString(), outcome: "daily-cap", detail, runs: 0 });
      return { ok: false, stoppedBy: "daily-cap", detail };
    }
    const usage = researchUsage(store, clock(), research, caps);
    if (usage.exhausted) {
      const detail = `research budget reached ($${usage.usedUsd.toFixed(4)} of $${usage.budgetUsd.toFixed(2)} in 24 h, judge, propose, summaries and meme ideas together)`;
      store.meme.record({ key: event.key, eventAt: event.raisedAt, at: clock().toISOString(), outcome: "research-cap", detail, runs: 0 });
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

  for (const event of events) {
    if (opts.signal?.aborted) return { ...out, stoppedBy: "interrupted" };
    const row = rows.get(event.key);
    if (!row) continue;
    const now = clock();
    const last = store.meme.lastTry(event.key);
    if ((last && now.getTime() - Date.parse(last.at) < gapMs(last.outcome, config)) || store.hasMemeSince(event.key, new Date(now.getTime() - MEME_WINDOW_MS).toISOString())) {
      out.skipped++;
      continue;
    }
    if (tried >= config.maxPerPass) break;

    const gate = mayRun(event);
    if (!gate.ok) {
      log(`[worker] meme ideas: ${gate.detail}; "${cleanLine(row.label, 60)}" waits`);
      return { ...out, stoppedBy: gate.stoppedBy };
    }
    tried++;

    // The Meta's context, read once per try.
    const group = groupOf(store, row, run.computedAt, metaConfig);
    const tokens = shownTokens(store, row, group);
    const existing: ExistingToken[] = group.length > 0 ? group.map((t) => ({ name: t.name, symbol: t.symbol })) : row.topTokens.map((t) => ({ name: t.name, symbol: t.symbol }));
    const news: SnapshotNews[] = (newsForKeys(store, [row.key], now, metaConfig).get(row.key) ?? []).map((n) => ({ title: n.title, sourceLabel: n.sourceLabel, url: n.url, publishedAt: n.publishedAt }));
    const roomLeft = roomLeftOf(run, row.key);
    const legitimacy = store.getRubric().dimensions.find((d) => d.key === "legitimacy")?.description ?? "";
    const promptFor = (retryCopies?: readonly string[]) =>
      memeIdeasPromptFor({ label: row.label, rank: row.rank, counts: row.counts, firstSeenAt: row.firstSeenAt, hotReason: event.reason, tokens, avoid: avoidLabels(existing), news, roomLeft: roomLeft.text, legitimacy, ...(retryCopies ? { retryCopies } : {}) });

    const record = (outcome: MemeOutcome, detail: string, runs: number) => store.meme.record({ key: event.key, eventAt: event.raisedAt, at: clock().toISOString(), outcome, detail, runs });

    /** The answer's check: the schema and the Meta's own tokens (`parseMemeOutput`), then DexScreener's. */
    const check = async (output: string): Promise<MemeParse> => {
      const parsed = parseMemeOutput(output, existing);
      if (!parsed.ok) return parsed;
      const listed = await dexCopies(parsed.ideas, opts.dex, log);
      return listed.length > 0 ? { ok: false, problem: "a name or ticker copies a token DexScreener lists", copies: listed } : parsed;
    };

    const first = await ask(promptFor(), row.label);
    if (first.kind === "stop") return { ...out, stoppedBy: first.stoppedBy };
    if (first.kind === "failed") {
      out.failed++;
      // A run that was too dear is not a sign of an outage and is not tried again at once: it waits out the 6 h like a refusal.
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
    if (!parsed.ok) log(`[worker] meme ideas: "${cleanLine(row.label, 60)}" refused: ${parsed.problem}. Output not stored: ${JSON.stringify(first.result.output.trim().slice(0, 200))}`);

    // A copied name goes back exactly once, with the copied names listed; the retry is one more run under the same caps.
    if (!parsed.ok && parsed.copies !== undefined) {
      const retryGate = mayRun(event);
      if (!retryGate.ok) {
        log(`[worker] meme ideas: "${cleanLine(row.label, 60)}" copies existing names but ${retryGate.detail}; nothing stored`);
      } else {
        const second = await ask(promptFor(parsed.copies), row.label);
        if (second.kind === "stop") {
          record("name-copy", "interrupted before the retry", runIds.length);
          return { ...out, stoppedBy: second.stoppedBy };
        }
        if (second.kind === "ok") {
          runIds.push(second.runId);
          parsed = await check(second.result.output);
          finish(second, parsed.ok);
          if (!parsed.ok) log(`[worker] meme ideas: "${cleanLine(row.label, 60)}" retry refused: ${parsed.problem}. Output not stored: ${JSON.stringify(second.result.output.trim().slice(0, 200))}`);
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
    const snapshot = buildSnapshot({ now, row, run, hot: event, roomLeft, tokens, news });
    let made: Proposal[];
    try {
      made = store.createMemeProposals(
        {
          metaKey: row.key,
          metaLabel: row.label,
          snapshot,
          reason: `Hot now: ${event.reason}`,
          summary: summaryLine(row, event),
          evidenceLinks: evidenceFor(row, news),
          ideas,
        },
        { now, attachRunId: runIds },
      );
    } catch (e) {
      if (e instanceof MemeTrioExistsError) {
        record("exists", "the Meta already had a trio in the last 6 h", runIds.length);
        log(`[worker] meme ideas: "${cleanLine(row.label, 60)}" already has a trio; answer dropped`);
        continue;
      }
      out.failed++;
      record("failed", "the ideas could not be stored", runIds.length);
      log(`[worker] meme ideas: "${cleanLine(row.label, 60)}" not stored: ${e instanceof Error ? e.message : String(e)}`);
      if (++transientInARow >= config.maxConsecutiveFailures) return { ...out, stoppedBy: "backoff" };
      continue;
    }
    out.stored++;
    record("stored", `${made.length} ideas`, runIds.length);
    log(`[worker] meme ideas: ${made.length} ideas for "${cleanLine(row.label, 60)}" (proposals ${made.map((p) => p.id).join(", ")})`);
  }
  return out;
}

/** The list line of an idea: the Meta, its numbers and why it is hot, written by code from the stored row (text still creator-derived: cleaned and cut). */
export function summaryLine(row: MetaRow, event: Pick<MetaHotEvent, "reason">): string {
  const c = row.counts["24h"];
  return `Meta ${cleanLine(row.label, 60)}: ${c.creators} creators, ${c.tokens} tokens in 24 h, rank ${row.rank}. Hot now: ${cleanLine(event.reason, 100)}.`;
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
