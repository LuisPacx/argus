import { launchLinkFor } from "../../utils/launch.ts";
import { withResume } from "../../utils/resume.ts";
import { withScore } from "../../utils/score.ts";
import { withSignals } from "../../utils/signals.ts";

export default defineEventHandler((event) => {
  const store = useStore();
  const proposal = store.getProposal(Number(getRouterParam(event, "id")));
  if (!proposal) throw createError({ statusCode: 404, statusMessage: "Proposal not found" });
  // `brainRuns`: every run with the backend that served it (claude-code: Est. usage; api: real dollars).
  // `signals`: the Narrative's top Signals for the "Why this Proposal" panel.
  return withScore(store, withSignals(store, { ...withResume(proposal, useDataDir(), useBuildRoot()), launchUrl: launchLinkFor(proposal), brainRuns: store.brainRunsFor(proposal.id) }));
});
