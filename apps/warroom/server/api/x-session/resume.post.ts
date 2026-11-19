import { XSessionRefusedError } from "@argus/core";

/**
 * "Resume X jobs" (moment scanner ticket 01): one press is one insert-only request row, refused with 409 unless the X session is `stopped`.
 * The worker clears the state on its next tick; this route writes the request row and nothing else (CODING_STANDARDS rule 1). Takes no body.
 * Returns `{ id, status: "pending" }`.
 */
export default defineEventHandler(() => {
  try {
    const request = useStore().requestXSessionResume(new Date());
    return { id: request.id, status: request.status };
  } catch (e) {
    if (e instanceof XSessionRefusedError) throw createError({ statusCode: 409, statusMessage: e.message });
    throw e;
  }
});
