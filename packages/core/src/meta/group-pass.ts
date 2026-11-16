import { BrainError, type Brain } from "../brain.ts";
import type { Datastore } from "../datastore.ts";
import { DEFAULT_RESEARCH_BUDGET_CONFIG, researchRunCaps, researchUsage, type ResearchBudgetConfig } from "../research-budget.ts";
import { metaGroupPromptFor, parseMetaGroups, reuseAnswer, type GroupAnswer, type GroupInput } from "./grouping.ts";

/**
 * The AI grouping step of the Meta tick (meta redesign ticket 06, ADR 0015, decision 4): groups the trending tokens and the top launch themes
 * into named subjects with the Brain task `meta-group`, inside a hard cost bound. `recomputeMetas` calls it once a tick, before its write
 * transaction, and builds the subjects from what it hands back; with no answer the tick groups by rules. It follows the summary pass:
 * - an `in-flight` brain_runs row exists before the child is spawned, and the run's cost is recorded the moment it returns;
 * - an answer that does not fit (`parseMetaGroups`) is refused and logged, nothing is stored, and the tick uses rules;
 * - a rate limit, a timeout, a budget stop or an error uses rules for this tick and is not retried in it; three in a row skip the next two ticks.
 * Before any call, in this order: off or no Brain; the API-fallback hold; reuse of the last answer while the items' identities are unchanged
 * and it is under 60 minutes old (what keeps 96 ticks a day inside the cap); the failure back-off; the daily cap; the shared research budget.
 * The step never throws into the tick and prints one line a tick.
 */

export interface MetaGroupConfig {
  /** `ARGUS_META_GROUP_AI=0` turns the step off: every tick groups by rules. */
  enabled: boolean;
  /** Most the task may spend in any rolling 24 hours (Est. usage, a run with no reported cost charged at the route cap). A run in progress may overshoot by up to its own budget. */
  maxDailyUsd: number;
  /** An answer is reused for this long while the items' identities are unchanged. */
  reuseMinutes: number;
  /** This many failures in a row skip the next `skipTicks` ticks' calls. */
  maxConsecutiveFailures: number;
  skipTicks: number;
}

export const DEFAULT_META_GROUP_CONFIG: MetaGroupConfig = { enabled: true, maxDailyUsd: 1, reuseMinutes: 60, maxConsecutiveFailures: 3, skipTicks: 2 };

/** The config with ARGUS_META_GROUP_AI (`0` or `1`) and ARGUS_META_GROUP_MAX_DAILY_USD (a positive number) applied. Junk is an error, as for ARGUS_META_SUMMARY_MAX_DAILY_USD. */
export function metaGroupConfigFromEnv(env: Record<string, string | undefined> = process.env): MetaGroupConfig {
  const flag = env.ARGUS_META_GROUP_AI;
  if (flag !== undefined && flag !== "" && flag !== "0" && flag !== "1") throw new Error(`ARGUS_META_GROUP_AI must be 0 or 1, got "${flag}"`);
  const raw = env.ARGUS_META_GROUP_MAX_DAILY_USD;
  let maxDailyUsd = DEFAULT_META_GROUP_CONFIG.maxDailyUsd;
  if (raw !== undefined && raw !== "") {
    maxDailyUsd = Number(raw);
    if (!Number.isFinite(maxDailyUsd) || maxDailyUsd <= 0) throw new Error(`ARGUS_META_GROUP_MAX_DAILY_USD must be a positive number, got "${raw}"`);
  }
  return { ...DEFAULT_META_GROUP_CONFIG, enabled: flag !== "0", maxDailyUsd };
}

const DAY_MS = 24 * 3_600_000;
const MINUTE_MS = 60_000;

export interface GroupStepOptions {
  config?: Partial<MetaGroupConfig>;
  research?: ResearchBudgetConfig;
  log?: (line: string) => void;
  /** The worker's shutdown signal; the tick's own bound arrives on each call's input. */
  signal?: AbortSignal;
}

/**
 * The grouping step for `recomputeMetas({ group })`. Without a Brain (or with the step off) every tick groups by rules. The failure count is
 * the step's own memory, so one step is made per worker.
 */
export function createGroupStep(store: Datastore, brain: Brain | undefined, opts: GroupStepOptions = {}): (input: GroupInput) => Promise<GroupAnswer | undefined> {
  const config: MetaGroupConfig = { ...DEFAULT_META_GROUP_CONFIG, ...opts.config };
  const research = opts.research ?? DEFAULT_RESEARCH_BUDGET_CONFIG;
  const log = opts.log ?? console.log;
  let failures = 0;
  let skip = 0;
  const rules = (why: string): undefined => {
    log(`[worker] meta group: rules (${why})`);
    return undefined;
  };
  const fail = (why: string): undefined => {
    if (++failures >= config.maxConsecutiveFailures) {
      failures = 0;
      skip = config.skipTicks;
    }
    return rules(why);
  };

  return async (input) => {
    if (!config.enabled || !brain) return rules("off");
    // The API fallback is holding the research tasks on the API: spawning claude here would probe the rate limit and extend the hold.
    if (brain.routeFor("judge").backend === "api") return rules("api-fallback hold");
    const now = input.now;
    const nowMs = now.getTime();

    // Reuse: the same items (by identity) as the last good answer, made less than `reuseMinutes` ago. No call, no cost.
    const stored = store.meta.latestGrouping(now.toISOString());
    if (stored && stored.inputHash === input.inputHash) {
      const age = nowMs - Date.parse(stored.computedAt);
      if (age >= 0 && age < config.reuseMinutes * MINUTE_MS) {
        const subjects = reuseAnswer(stored.answer, input.items);
        log(`[worker] meta group: ai (reused, $0.0000, ${subjects.length} subjects)`);
        return { subjects, inputHash: input.inputHash, computedAt: stored.computedAt, reused: true, costUsd: 0, brainRunId: stored.brainRunId };
      }
    }

    if (skip > 0) {
      skip--;
      return rules("backing off after failures");
    }

    const caps = researchRunCaps(brain);
    const spent = store.metaGroupSpendSince(new Date(nowMs - DAY_MS).toISOString(), caps);
    if (spent.chargedUsd >= config.maxDailyUsd) return rules(`daily cap reached: $${spent.chargedUsd.toFixed(4)} of $${config.maxDailyUsd.toFixed(2)} in 24 h, ${spent.runs} runs`);
    const usage = researchUsage(store, now, research, caps);
    if (usage.exhausted) return rules(`research budget reached: $${usage.usedUsd.toFixed(4)} of $${usage.budgetUsd.toFixed(2)} in 24 h`);

    const prompt = metaGroupPromptFor(input.items);
    const runId = store.startBrainRun({ proposalId: 0, task: "meta-group", ...brain.routeFor("meta-group") }, now);
    const signal = opts.signal ? AbortSignal.any([input.signal, opts.signal]) : input.signal;
    let result;
    try {
      result = await brain.run<string>("meta-group", { prompt }, { signal, onBackend: (r) => store.setBrainRunBackend(runId, r.backend, r.model) });
    } catch (e) {
      const brainError = e instanceof BrainError ? e : undefined;
      const kind = brainError?.kind ?? "failed";
      store.finishBrainRun(runId, { sessionId: brainError?.sessionId ?? null, totalCostUsd: brainError?.totalCostUsd ?? 0, exitStatus: kind, backend: brainError?.backend, model: brainError?.model });
      return fail(kind === "failed" ? `failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}` : kind === "rate-limited" ? "rate-limited" : kind);
    }
    if (result.dryRun) {
      store.discardBrainRun(runId);
      return rules("dry run");
    }
    const parsed = parseMetaGroups(result.output, input.items);
    store.finishBrainRun(runId, { sessionId: result.sessionId ?? null, totalCostUsd: result.totalCostUsd, exitStatus: parsed.ok ? "success" : "invalid-output", backend: result.backend, model: result.model });
    // The spend is recorded. Nothing below calls the brain again.
    if (!parsed.ok) {
      log(`[worker] meta group: output not stored: ${JSON.stringify(result.output.trim().slice(0, 200))}`);
      return fail(`refused: ${parsed.problem}`);
    }
    failures = 0;
    log(`[worker] meta group: ai (called, $${result.totalCostUsd.toFixed(4)}, ${parsed.subjects.length} subjects)`);
    return { subjects: parsed.subjects, inputHash: input.inputHash, computedAt: now.toISOString(), reused: false, costUsd: result.totalCostUsd, brainRunId: runId, raw: result.output };
  };
}
