import type { Datastore } from "./datastore.ts";

/**
 * The research share (architecture section 5 and invariant 3): judge and propose together may use about 30% of the daily
 * subscription, so Builds are not starved. The subscription's real limits are not published as numbers argus can read, so the
 * share is defined on the one figure argus does have, Est. usage (the API-equivalent `total_cost_usd` of each run):
 *
 *   research budget = ARGUS_DAILY_QUOTA_USD x ARGUS_RESEARCH_SHARE, over any rolling 24 hours
 *
 * `dailyQuotaUsd` is the Operator's estimate of how much Est. usage the plan allows per day; the default ($20) is a placeholder
 * until real usage is measured (architecture section 13). With the default share of 0.3 the budget is $6. "30% of the quota" is
 * therefore exactly as accurate as that estimate; changing the quota or the share is an explicit, reviewed config change, and
 * hitting the budget stops research until older runs age out of the 24 hours (caps are never silently raised).
 * A run that is already going may overshoot by up to its own `--max-budget-usd`.
 */
export interface ResearchBudgetConfig {
  /** Est. usage (API-equivalent $) the subscription is assumed to allow in 24 hours. */
  dailyQuotaUsd: number;
  /** The fraction of it that research (judge plus propose) may use, greater than 0 and at most 1. */
  share: number;
}

export const DEFAULT_RESEARCH_BUDGET_CONFIG: ResearchBudgetConfig = { dailyQuotaUsd: 20, share: 0.3 };

/** The rolling-24 h research budget in Est. usage dollars (rounded to a millionth so $20 x 0.3 is $6, not 5.999...). */
export function researchBudgetUsd(config: ResearchBudgetConfig): number {
  return Math.round(config.dailyQuotaUsd * config.share * 1e6) / 1e6;
}

/**
 * The config with ARGUS_DAILY_QUOTA_USD and ARGUS_RESEARCH_SHARE applied. Parsed first, validated after: a quota that is not a
 * positive finite number, or a share that is not in (0, 1], is an error and never a fallback (as for ARGUS_JUDGE_*). Unset or empty means the default.
 */
export function researchConfigFromEnv(env: Record<string, string | undefined>): ResearchBudgetConfig {
  const read = (name: string, fallback: number, valid: (v: number) => boolean, expected: string): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const v = Number(raw);
    if (!Number.isFinite(v) || !valid(v)) throw new Error(`${name} must be ${expected}, got "${raw}"`);
    return v;
  };
  return {
    dailyQuotaUsd: read("ARGUS_DAILY_QUOTA_USD", DEFAULT_RESEARCH_BUDGET_CONFIG.dailyQuotaUsd, (v) => v > 0, "a positive number"),
    share: read("ARGUS_RESEARCH_SHARE", DEFAULT_RESEARCH_BUDGET_CONFIG.share, (v) => v > 0 && v <= 1, "a number above 0 and at most 1"),
  };
}

export interface ResearchUsage {
  /** Est. usage of every judge and propose run started in the last 24 hours (refused and failed runs included). */
  usedUsd: number;
  runs: number;
  budgetUsd: number;
  quotaUsd: number;
  share: number;
  /** `usedUsd` as a fraction of the assumed daily quota (the "about 30%" figure the budget is held to). */
  usedShareOfQuota: number;
  /** True at or above the budget: research starts no new run until older ones age out of the 24 hours. */
  exhausted: boolean;
}

export function researchUsage(store: Pick<Datastore, "researchSpendSince">, now: Date, config: ResearchBudgetConfig): ResearchUsage {
  const spent = store.researchSpendSince(new Date(now.getTime() - 24 * 3_600_000).toISOString());
  const budgetUsd = researchBudgetUsd(config);
  return {
    usedUsd: spent.costUsd,
    runs: spent.runs,
    budgetUsd,
    quotaUsd: config.dailyQuotaUsd,
    share: config.share,
    usedShareOfQuota: spent.costUsd / config.dailyQuotaUsd,
    exhausted: spent.costUsd >= budgetUsd,
  };
}
