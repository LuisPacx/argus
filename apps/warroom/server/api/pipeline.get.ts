import { PIPELINE, resolvePipeline } from "@argus/core";

/**
 * The pipeline graph the "How it works" page draws: nodes, edges and gates with every rule's value read from the code's own constants
 * (`packages/core/src/pipeline-graph.ts`). The buildability gate is the stored Rubric's value with its version, because the Rubric is
 * editable data and the code's number is only its seed (architecture section 7). A rule an `ARGUS_*` variable can override shows the
 * value that variable gives, read from this process's environment (the worker is assumed to share it, as `GET /api/research` does; the
 * War Room has no way to ask the worker), with the code's default beside it when they differ. Read-only; no function reaches the client.
 */
export default defineEventHandler(() => {
  const { version, gateMinScore } = useStore().getRubric();
  return resolvePipeline(PIPELINE, { rubric: { version, gateMinScore }, env: process.env });
});
