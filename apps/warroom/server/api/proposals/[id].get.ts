import { launchLinkFor } from "../../utils/launch.ts";
import { withBuildStatus } from "../../utils/build-status.ts";
import { withResume } from "../../utils/resume.ts";
import { withScore } from "../../utils/score.ts";
import { withSignals } from "../../utils/signals.ts";

export default defineEventHandler((event) => {
  const store = useStore();
  const proposal = store.getProposal(Number(getRouterParam(event, "id")));
  if (!proposal) throw createError({ statusCode: 404, statusMessage: "Proposal not found" });
  // `brainRuns`: every run with the backend that served it (claude-code: Est. usage; api: real dollars).
  // `signals`: the Narrative's top Signals for the "Why this Proposal" panel.
  // `buildRefusal`/`buildRunning`/`buildRetrySeconds`: why an approved Proposal's Build has not started (see utils/build-status.ts).
  return withBuildStatus(store, withScore(store, withSignals(store, { ...withResume(proposal, useDataDir(), useBuildRoot()), launchUrl: launchLinkFor(proposal), brainRuns: store.brainRunsFor(proposal.id) })));
});
