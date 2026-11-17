import { DEFAULT_ROUTING, type Brain } from "./brain.ts";
import type { Datastore, RunCaps } from "./datastore.ts";

/**
 * The research share (architecture section 5 and invariant 3): judge and propose (and the Meta summary line and the meme ideas) together may use about 30% of the daily
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

/**
 * What a run that reported no cost is charged against the budget: its route's per-run cap, a ceiling on what it can have used. The
 * Brain reports its routes' caps; a Brain that does not falls back to the default routing's.
 */
export function researchRunCaps(brain: Pick<Brain, "routeFor" | "primaryRouteFor">): RunCaps {
  // The subscription's caps, even while the API fallback is serving: Est. usage is charged at the subscription's per-run cap.
  const route = (task: "judge" | "propose" | "meta-summary" | "meta-group" | "meme-ideas" | "spec") => (brain.primaryRouteFor ?? brain.routeFor).call(brain, task);
  return {
    // Spec drafts and revisions are no research (the research budget sums the five tasks below only) but count in the daily total, where
    // a draft that ended with no cost (the shutdown, a cancel) is charged at its cap (hardening ticket 10).
    spec: route("spec").maxBudgetUsd ?? DEFAULT_ROUTING.spec.maxBudgetUsd,
    "spec-revise": route("spec").maxBudgetUsd ?? DEFAULT_ROUTING.spec.maxBudgetUsd,
    judge: route("judge").maxBudgetUsd ?? DEFAULT_ROUTING.judge.maxBudgetUsd,
    propose: route("propose").maxBudgetUsd ?? DEFAULT_ROUTING.propose.maxBudgetUsd,
    // The Meta summary line counts in the research share too (viral sources ticket 03, slice 5).
    "meta-summary": route("meta-summary").maxBudgetUsd ?? DEFAULT_ROUTING["meta-summary"].maxBudgetUsd,
    // And the Meta grouping (meta redesign ticket 06, ADR 0015): its own $1.00 a day cap sits inside this budget.
    "meta-group": route("meta-group").maxBudgetUsd ?? DEFAULT_ROUTING["meta-group"].maxBudgetUsd,
    // So do the meme ideas (missed ideas ticket 06): their own run cap is taken from this budget, not added to it.
    "meme-ideas": route("meme-ideas").maxBudgetUsd ?? DEFAULT_ROUTING["meme-ideas"].maxBudgetUsd,
  };
}

export const DEFAULT_RESEARCH_RUN_CAPS: RunCaps = {
  spec: DEFAULT_ROUTING.spec.maxBudgetUsd,
  "spec-revise": DEFAULT_ROUTING.spec.maxBudgetUsd,
  judge: DEFAULT_ROUTING.judge.maxBudgetUsd,
  propose: DEFAULT_ROUTING.propose.maxBudgetUsd,
  "meta-summary": DEFAULT_ROUTING["meta-summary"].maxBudgetUsd,
  "meta-group": DEFAULT_ROUTING["meta-group"].maxBudgetUsd,
  "meme-ideas": DEFAULT_ROUTING["meme-ideas"].maxBudgetUsd,
};

export interface ResearchUsage {
  /**
   * What every judge and propose run started in the last 24 hours is charged against the budget (refused and failed runs included): the
   * Est. usage they reported, except that a run that ended with no reported cost (timed out, interrupted, left in flight by a dead
   * worker) is charged at its route's per-run cap, since it may have spent that much.
   */
  usedUsd: number;
  /** The Est. usage the runs actually reported, without those charges. */
  reportedUsd: number;
  /** What the cap charges added to `reportedUsd` (`usedUsd - reportedUsd`): estimated, not reported, and shown as such in the War Room. */
  estimatedUsd: number;
  /**
   * Everything the subscription ran in the same 24 hours counted toward the daily quota, not only the research share: research and Spec
   * runs as charged above, and every Build dollar (exact, or the estimate of a killed run; every attempt). Est. usage, not a charge.
   */
  dailyUsedUsd: number;
  /** `dailyUsedUsd` as a fraction of `quotaUsd`. */
  dailyUsedShareOfQuota: number;
  runs: number;
  budgetUsd: number;
  quotaUsd: number;
  share: number;
  /** `usedUsd` as a fraction of the assumed daily quota (the "about 30%" figure the budget is held to). */
  usedShareOfQuota: number;
  /** True at or above the budget: research starts no new run until older ones age out of the 24 hours. */
  exhausted: boolean;
}

export function researchUsage(
  store: Pick<Datastore, "researchSpendSince" | "dailySpendSince">,
  now: Date,
  config: ResearchBudgetConfig,
  caps: RunCaps = DEFAULT_RESEARCH_RUN_CAPS,
): ResearchUsage {
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const spent = store.researchSpendSince(since, caps);
  const daily = store.dailySpendSince(since, caps);
  const budgetUsd = researchBudgetUsd(config);
  return {
    usedUsd: spent.chargedUsd,
    reportedUsd: spent.costUsd,
    estimatedUsd: Math.max(0, spent.chargedUsd - spent.costUsd),
    dailyUsedUsd: daily.chargedUsd,
    dailyUsedShareOfQuota: daily.chargedUsd / config.dailyQuotaUsd,
    runs: spent.runs,
    budgetUsd,
    quotaUsd: config.dailyQuotaUsd,
    share: config.share,
    usedShareOfQuota: spent.chargedUsd / config.dailyQuotaUsd,
    exhausted: spent.chargedUsd >= budgetUsd,
  };
}
