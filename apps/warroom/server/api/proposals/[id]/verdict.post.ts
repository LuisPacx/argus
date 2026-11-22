import { parseIdeaVerdictBody } from "@argus/core";

/**
 * The Operator's Idea verdict on a meme Proposal (War Room ticket 21): `{ verdict, tags?, note? }`. The server does every check (404 for an
 * unknown Proposal, 400 for any other kind, 400 for a bad body, see `parseIdeaVerdictBody`). The Proposal's kind and Playbook version are read
 * by the store; a `playbookVersion` or `kind` in the body is ignored. Writes the verdict row and nothing else (CODING_STANDARDS rule 1). Returns
 * the stored verdict.
 */
export default defineEventHandler(async (event) => {
  const store = useStore();
  const proposal = store.getProposal(Number(getRouterParam(event, "id")));
  if (!proposal) throw createError({ statusCode: 404, statusMessage: "Proposal not found" });
  if (proposal.kind !== "meme") throw createError({ statusCode: 400, statusMessage: "Only a meme idea gets an Idea verdict" });
  const parsed = parseIdeaVerdictBody(await readBody<unknown>(event));
  if (!parsed.ok) throw createError({ statusCode: 400, statusMessage: parsed.message });
  return store.addProposalVerdict({ proposalId: proposal.id, ...parsed.value });
});
