import { BrainError, type Brain } from "../brain.ts";
import type { Datastore } from "../datastore.ts";
import { DEFAULT_RESEARCH_BUDGET_CONFIG, researchRunCaps, researchUsage, type ResearchBudgetConfig } from "../research-budget.ts";
import type { LaunchedToken } from "../study/store.ts";
import type { MetaConfig } from "./config.ts";
import { groupTokens } from "./group.ts";
import { newsForKeys } from "./news.ts";
import type { CurrentMeta } from "./store.ts";
import { currentSummaryFresh, META_SUMMARY_MAX_TOKENS, metaInputHash, metaSummaryPromptFor, metaSummaryShownText, parseMetaSummary, type MetaSummarySubject, type MetaSummaryToken } from "./summary.ts";

/**
 * The Meta summary pass (ticket 03, slice 5; meta redesign ticket 03): after each ranking refresh, writes the one-line summary of the
 * Metas and the Watching subjects (at most 6 in all, Metas first, ADR 0014) with the Brain task `meta-summary`, within a hard cost bound,
 * and stores it by group key. The launch themes below them get the numbers line only and no call. It follows the judge pass:
 * - an `in-flight` brain_runs row exists before the child is spawned, and the run's cost is recorded the moment it returns;
 * - an answer that does not fit (`parseMetaSummary`) is refused and logged, nothing is stored, and the templated line stands in;
 * - a rate limit, a budget stop or a shutdown ends the pass at once without error; three transient failures in a row end it too.
 * A stored line is reused while the Meta's input hash holds (`metaInputHash`), and a changed input, or a refused try, waits at least
 * `minAgeMinutes` after the last attempt before the next call. Nothing here ranks, groups or writes a Proposal.
 */

export interface MetaSummaryConfig {
  /** Most subjects considered, and most Brain calls, in one pass (one ranking refresh): the Metas then the Watching subjects. */
  maxPerPass: number;
  /** Most `meta-summary` runs started in any rolling 24 hours, refused and failed ones included. */
  maxRunsPerDay: number;
  /** Most the task may spend in any rolling 24 hours (Est. usage). A run in progress may overshoot by up to its own budget. */
  maxDailyUsd: number;
  /** A Meta is not called for again until this long after the last attempt for it. */
  minAgeMinutes: number;
  /** This many transient failures in a row end the pass. */
  maxConsecutiveFailures: number;
}

export const DEFAULT_META_SUMMARY_CONFIG: MetaSummaryConfig = { maxPerPass: 6, maxRunsPerDay: 40, maxDailyUsd: 0.25, minAgeMinutes: 60, maxConsecutiveFailures: 3 };

/** The config with ARGUS_META_SUMMARY_MAX_PER_DAY and ARGUS_META_SUMMARY_MAX_DAILY_USD applied. A value that is not a positive number is an error, as for ARGUS_JUDGE_*. */
export function metaSummaryConfigFromEnv(env: Record<string, string | undefined> = process.env): MetaSummaryConfig {
  const read = (name: string, fallback: number, whole: boolean): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const v = whole ? Math.floor(Number(raw)) : Number(raw);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be ${whole ? "a whole number, 1 or more" : "a positive number"}, got "${raw}"`);
    return v;
  };
  return {
    ...DEFAULT_META_SUMMARY_CONFIG,
    maxRunsPerDay: read("ARGUS_META_SUMMARY_MAX_PER_DAY", DEFAULT_META_SUMMARY_CONFIG.maxRunsPerDay, true),
    maxDailyUsd: read("ARGUS_META_SUMMARY_MAX_DAILY_USD", DEFAULT_META_SUMMARY_CONFIG.maxDailyUsd, false),
  };
}

export interface MetaSummaryResult {
  /** Brain runs started. */
  called: number;
  /** Lines stored. */
  accepted: number;
  /** Answers that did not fit; nothing was stored. */
  refused: number;
  /** Runs that failed (error, budget, timeout). */
  failed: number;
  stoppedBy?: "daily-cap" | "research-cap" | "rate-limited" | "interrupted" | "dry-run" | "backoff" | "api-hold";
}

const DAY_MS = 24 * 3_600_000;

/** The tokens of each group of the last 24 h before `computedAt`, by group key (one read and one grouping for the whole pass). */
function groupsAsOf(store: Datastore, computedAt: string): Map<string, LaunchedToken[]> {
  const to = Date.parse(computedAt);
  const tokens = store.study.createdBetween(new Date(to - DAY_MS).toISOString(), computedAt);
  return new Map(groupTokens(tokens).map((g) => [g.key, g.tokens]));
}

/** Up to 8 tokens for the prompt: the leader first (it may be of any age), then the Meta's top tokens, then migrated ones, then the earliest creates of the group. */
function tokensFor(store: Datastore, meta: CurrentMeta, group: LaunchedToken[] | undefined): MetaSummaryToken[] {
  const leader = meta.leader;
  const caps = new Map(meta.topTokens.flatMap((t) => (t.marketCapUsd !== undefined ? [[t.mint, t.marketCapUsd] as const] : [])));
  caps.set(leader.mint, leader.marketCapUsd);
  const first = new Map(meta.topTokens.map((t, i) => [t.mint, i + 1]));
  const ordered = [...(group ?? [])]
    .filter((t) => t.mint !== leader.mint)
    .sort(
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
  const lead: MetaSummaryToken = { name: leader.name, symbol: leader.symbol, migrated: (group ?? []).some((t) => t.mint === leader.mint && t.migratedAt !== null), marketCapUsd: leader.marketCapUsd, ...describe(leader.mint) };
  if (ordered.length === 0) return [lead, ...meta.topTokens.filter((t) => t.mint !== leader.mint).map((t) => ({ name: t.name, symbol: t.symbol, migrated: false, ...(t.marketCapUsd !== undefined ? { marketCapUsd: t.marketCapUsd } : {}) }))].slice(0, META_SUMMARY_MAX_TOKENS);
  return [lead, ...ordered.map((t) => ({ name: t.name, symbol: t.symbol, migrated: t.migratedAt !== null, ...(caps.has(t.mint) ? { marketCapUsd: caps.get(t.mint) as number } : {}), ...describe(t.mint) }))].slice(0, META_SUMMARY_MAX_TOKENS);
}

export async function summariseMetas(
  store: Datastore,
  brain: Brain,
  opts: { now?: Date; config?: Partial<MetaSummaryConfig>; research?: ResearchBudgetConfig; log?: (line: string) => void; signal?: AbortSignal; metaConfig?: MetaConfig } = {},
): Promise<MetaSummaryResult> {
  const config = { ...DEFAULT_META_SUMMARY_CONFIG, ...opts.config };
  const research = opts.research ?? DEFAULT_RESEARCH_BUDGET_CONFIG;
  const caps = researchRunCaps(brain);
  const log = opts.log ?? console.log;
  const clock = () => opts.now ?? new Date();
  const out: MetaSummaryResult = { called: 0, accepted: 0, refused: 0, failed: 0 };

  // The API fallback is holding the research tasks on the API: spawning claude here would probe the rate limit and extend the hold.
  if (brain.routeFor("judge").backend === "api") return { ...out, stoppedBy: "api-hold" };

  // The Metas, then the Watching subjects: at most `maxPerPass` in all. A launch theme below them is never summarised, stale line or not.
  const current = store.currentMetas();
  if (!current) return out;
  const subjects = [...current.metas.map((m) => ({ meta: m, kind: "meta" as const })), ...current.watching.map((m) => ({ meta: m, kind: "watching" as const }))].slice(0, config.maxPerPass);
  const saved = store.meta.summaries(subjects.map((s) => s.meta.key));
  let groups: Map<string, LaunchedToken[]> | undefined;
  let transientInARow = 0;

  for (const { meta, kind } of subjects) {
    if (opts.signal?.aborted) return { ...out, stoppedBy: "interrupted" };
    const row: MetaSummarySubject & { key: string } = { key: meta.key, label: meta.label, firstSeenAt: meta.enteredAt, counts: meta.counts, topTokens: meta.topTokens, leader: meta.leader, kind };
    const hash = metaInputHash(row);
    const rec = saved.get(row.key);
    // A stored line older than a day counts as missing (it is no longer shown), so it is rewritten.
    const stale = rec !== undefined && rec.summary !== null && !currentSummaryFresh(rec, clock().getTime());
    if (rec && rec.summary !== null && rec.inputHash === hash && !stale) continue; // nothing material moved: the line stands
    if (rec && clock().getTime() - Date.parse(rec.triedAt) < config.minAgeMinutes * 60_000) continue; // tried lately
    if (out.called >= config.maxPerPass) break;

    const spent = store.metaSummarySpendSince(new Date(clock().getTime() - DAY_MS).toISOString(), caps);
    if (spent.runs >= config.maxRunsPerDay || spent.chargedUsd >= config.maxDailyUsd) {
      log(`[worker] meta summary: daily cap reached (${spent.runs} runs, $${spent.chargedUsd.toFixed(4)} in 24 h); the templated line stands`);
      return { ...out, stoppedBy: "daily-cap" };
    }
    const usage = researchUsage(store, clock(), research, caps);
    if (usage.exhausted) {
      log(`[worker] meta summary: research budget reached ($${usage.usedUsd.toFixed(4)} of $${usage.budgetUsd.toFixed(2)} in 24 h); the templated line stands`);
      return { ...out, stoppedBy: "research-cap" };
    }

    groups ??= groupsAsOf(store, current.computedAt);
    // Ticket 03 of missed ideas: matching news is context for the line (ADR 0011). It is not part of the input hash: a new headline alone does not buy a call.
    const news = newsForKeys(store, [row.key], clock(), opts.metaConfig).get(row.key) ?? [];
    const shownTokens = tokensFor(store, meta, groups.get(row.key));
    const prompt = metaSummaryPromptFor(row, shownTokens, news);
    const runId = store.startBrainRun({ proposalId: 0, task: "meta-summary", ...brain.routeFor("meta-summary") }, clock());
    out.called++;
    let result;
    try {
      result = await brain.run<string>("meta-summary", { prompt }, { signal: opts.signal, onBackend: (r) => store.setBrainRunBackend(runId, r.backend, r.model) });
    } catch (e) {
      const brainError = e instanceof BrainError ? e : undefined;
      const kind = brainError?.kind ?? "failed";
      store.finishBrainRun(runId, { sessionId: brainError?.sessionId ?? null, totalCostUsd: brainError?.totalCostUsd ?? 0, exitStatus: kind, backend: brainError?.backend, model: brainError?.model });
      if (kind === "interrupted") return { ...out, stoppedBy: "interrupted" };
      if (kind === "rate-limited") {
        log("[worker] meta summary: rate-limited, stopping the pass; the templated line stands");
        return { ...out, stoppedBy: "rate-limited" };
      }
      log(`[worker] meta summary: "${row.label}" ${kind}: ${e instanceof Error ? e.message : String(e)}`);
      out.failed++;
      if (kind === "budget-exceeded") {
        // claude answered, the run was just too dear: not tried again for this input before the retry gap, and not a sign of an outage.
        transientInARow = 0;
        store.meta.markTried(row.key, hash, clock().toISOString());
      } else if (++transientInARow >= config.maxConsecutiveFailures) {
        log(`[worker] meta summary: ${transientInARow} consecutive failures (claude missing, auth or network trouble?); stopping the pass, the next refresh tries again`);
        return { ...out, stoppedBy: "backoff" };
      }
      continue;
    }
    transientInARow = 0;
    if (result.dryRun) {
      store.discardBrainRun(runId);
      out.called--;
      log("[worker] meta summary: dry-run, nothing spawned; stopping the pass");
      return { ...out, stoppedBy: "dry-run" };
    }
    // Figures the model was given as text (names, tickers, descriptions, matching headlines) may appear in its line; any other figure is refused.
    const parsed = parseMetaSummary(result.output, metaSummaryShownText(row, shownTokens, news));
    store.finishBrainRun(runId, { sessionId: result.sessionId ?? null, totalCostUsd: result.totalCostUsd, exitStatus: parsed.ok ? "success" : "invalid-output", backend: result.backend, model: result.model });
    // The spend is recorded. Nothing below calls the brain again.
    if (!parsed.ok) {
      log(`[worker] meta summary: "${row.label}" refused: ${parsed.problem}. Output not stored: ${JSON.stringify(result.output.trim().slice(0, 200))}`);
      store.meta.markTried(row.key, hash, clock().toISOString());
      out.refused++;
      continue;
    }
    store.meta.saveSummary(row.key, parsed.summary, hash, clock().toISOString(), { tokens: row.counts["24h"].tokens, creators: row.counts["24h"].creators });
    out.accepted++;
  }
  return out;
}
