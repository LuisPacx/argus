import { DomainError, RubricConflictError } from "@argus/core";

/** Saves the Rubric as a new version if it is still the version the editor loaded (`baseVersion`); otherwise 409. */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ baseVersion?: unknown; dimensions?: unknown; gateMinScore?: unknown }>(event);
  if (typeof body?.baseVersion !== "number") {
    throw createError({ statusCode: 400, statusMessage: "baseVersion is required" });
  }
  try {
    return useStore().saveRubric({
      baseVersion: body.baseVersion,
      dimensions: body.dimensions as never,
      gateMinScore: body.gateMinScore as never,
    });
  } catch (e) {
    if (e instanceof RubricConflictError) throw createError({ statusCode: 409, statusMessage: e.message });
    if (e instanceof DomainError) throw createError({ statusCode: 400, statusMessage: e.message });
    throw e;
  }
});
