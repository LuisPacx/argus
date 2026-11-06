import { withResume } from "../../utils/resume.ts";
import { withScore } from "../../utils/score.ts";

export default defineEventHandler((event) => {
  const store = useStore();
  const proposal = store.getProposal(Number(getRouterParam(event, "id")));
  if (!proposal) throw createError({ statusCode: 404, statusMessage: "Proposal not found" });
  return withScore(store, withResume(proposal, useDataDir(), useBuildRoot()));
});
