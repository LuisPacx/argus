import { PIPELINE, resolvePipeline } from "@argus/core";

/**
 * The pipeline graph the "How it works" page draws: nodes, edges and gates with every rule's value read from the code's own constants
 * (`packages/core/src/pipeline-graph.ts`). The buildability gate is the stored Rubric's value with its version, because the Rubric is
 * editable data and the code's number is only its seed (architecture section 7). Read-only; no function reaches the client.
 */
export default defineEventHandler(() => {
  const { version, gateMinScore } = useStore().getRubric();
  return resolvePipeline(PIPELINE, { rubric: { version, gateMinScore } });
});
