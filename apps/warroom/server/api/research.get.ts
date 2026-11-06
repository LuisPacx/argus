import { API_DEFAULT_ROUTING, apiFallbackConfigFromEnv, MAX_NEW_PROPOSALS_PER_DAY, proposeConfigFromEnv, researchConfigFromEnv, researchUsage } from "@argus/core";

/**
 * How much of the day's research allowance is used: the shared judge-plus-propose budget in Est. usage (the figure the worker holds
 * itself to, from the same ARGUS_* variables) and the new-Proposal count against its daily cap. Rolling 24 hours, read-only.
 *
 * `api` is the other currency: REAL dollars the API fallback has spent in the same 24 hours, against its own daily cap. It is never
 * added to the Est. usage figures above, which count subscription runs only.
 */
export default defineEventHandler(() => {
  const now = new Date();
  const store = useStore();
  let usage;
  let cap: number;
  let apiConfig;
  try {
    usage = researchUsage(store, now, researchConfigFromEnv(process.env));
    cap = Math.min(proposeConfigFromEnv(process.env).maxNewPerDay, MAX_NEW_PROPOSALS_PER_DAY);
    apiConfig = apiFallbackConfigFromEnv(process.env);
  } catch (e) {
    throw createError({ statusCode: 500, statusMessage: e instanceof Error ? e.message : "Research settings are invalid" });
  }
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const today = store.researchProposalsSince(dayAgo);
  const apiSpent = store.apiSpendSince(dayAgo, { judge: API_DEFAULT_ROUTING.judge.maxBudgetUsd, propose: API_DEFAULT_ROUTING.propose.maxBudgetUsd });
  const api = { enabled: apiConfig.enabled, capUsd: apiConfig.dailyUsd, usedUsd: apiSpent.chargedUsd, runs: apiSpent.runs, exhausted: apiSpent.chargedUsd >= apiConfig.dailyUsd };
  return { ...usage, newProposals: today, newProposalsCap: cap, windowHours: 24, api };
});
