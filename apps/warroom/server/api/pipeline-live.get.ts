import { PIPELINE, resolvePipelineLive } from "@argus/core";

/**
 * The live numbers on the "How it works" graph, for the rolling 24 hours: a count per edge and Claude spend per node. Read-only.
 * Est. usage (`spendUsd`, subscription runs) and real API dollars (`apiUsd`) are separate fields and never added, as in `GET /api/research`.
 * A brain task no node owns is reported under `other`, never dropped and never an error. The buildability gate used to count Narratives
 * that passed is the stored Rubric's, as on the graph itself.
 */
export default defineEventHandler(() => {
  const store = useStore();
  return resolvePipelineLive(PIPELINE, store.pipelineLive(new Date(), store.getRubric().gateMinScore));
});
