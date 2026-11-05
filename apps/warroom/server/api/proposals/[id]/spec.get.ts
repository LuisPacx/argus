import { readFileSync } from "node:fs";

/** The Proposal's current spec.md and its stored hash (send the hash back when saving). */
export default defineEventHandler((event) => {
  const p = useStore().getProposal(Number(getRouterParam(event, "id")));
  if (!p) throw createError({ statusCode: 404, statusMessage: "Proposal not found" });
  if (!p.specPath || !p.specHash) throw createError({ statusCode: 404, statusMessage: "No Spec yet" });
  try {
    return { content: readFileSync(p.specPath, "utf8"), hash: p.specHash };
  } catch {
    throw createError({ statusCode: 404, statusMessage: "spec.md is missing on disk" });
  }
});
