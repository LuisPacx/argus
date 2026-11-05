import { DomainError, SpecConflictError } from "@argus/core";

/** Saves the Spec if it is still the version the editor loaded (`baseHash`); otherwise 409. */
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));
  const body = await readBody<{ content?: unknown; baseHash?: unknown }>(event);
  if (typeof body?.content !== "string" || typeof body.baseHash !== "string") {
    throw createError({ statusCode: 400, statusMessage: "content and baseHash are required" });
  }
  try {
    return { hash: useStore().saveSpec(id, body.baseHash, body.content) };
  } catch (e) {
    if (e instanceof SpecConflictError) throw createError({ statusCode: 409, statusMessage: e.message });
    if (e instanceof DomainError) throw createError({ statusCode: 400, statusMessage: e.message });
    throw e;
  }
});
