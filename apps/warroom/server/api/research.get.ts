import { MAX_NEW_PROPOSALS_PER_DAY, proposeConfigFromEnv, researchConfigFromEnv, researchUsage } from "@argus/core";

/**
 * How much of the day's research allowance is used: the shared judge-plus-propose budget in Est. usage (the figure the worker holds
 * itself to, from the same ARGUS_* variables) and the new-Proposal count against its daily cap. Rolling 24 hours, read-only.
 */
export default defineEventHandler(() => {
  const now = new Date();
  const store = useStore();
  let usage;
  let cap: number;
  try {
    usage = researchUsage(store, now, researchConfigFromEnv(process.env));
    cap = Math.min(proposeConfigFromEnv(process.env).maxNewPerDay, MAX_NEW_PROPOSALS_PER_DAY);
  } catch (e) {
    throw createError({ statusCode: 500, statusMessage: e instanceof Error ? e.message : "Research settings are invalid" });
  }
  const today = store.researchProposalsSince(new Date(now.getTime() - 24 * 3_600_000).toISOString());
  return { ...usage, newProposals: today, newProposalsCap: cap, windowHours: 24 };
});
