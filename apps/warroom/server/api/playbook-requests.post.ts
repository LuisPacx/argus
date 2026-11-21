import { PlaybookRequestRefusedError } from "@argus/core";

const STATUS_OF: Record<PlaybookRequestRefusedError["code"], number> = { "too-few": 409, pending: 429, "daily-cap": 429 };

/**
 * The Operator's "Rebuild playbook" button (human researcher ticket 09): one pending request the worker turns into a new Playbook version. The body is
 * an empty JSON object, nothing else. The server does the checks before anything can run: fewer than 10 finished Picks is refused (409) with the reason,
 * a second press while one waits is refused (429), and at most 8 a day (429). Writes the request row and nothing else: no version, no model call
 * (CODING_STANDARDS rule 1). Returns `{ id, status: "pending" }`.
 */
export default defineEventHandler(async (event) => {
  const bad = (statusMessage: string) => createError({ statusCode: 400, statusMessage });
  const body: unknown = await readBody<unknown>(event);
  if (body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0)) throw bad("The body must be empty");
  try {
    const request = useStore().requestPlaybook();
    return { id: request.id, status: request.status };
  } catch (e) {
    if (e instanceof PlaybookRequestRefusedError) throw createError({ statusCode: STATUS_OF[e.code], statusMessage: e.message });
    throw e;
  }
});
