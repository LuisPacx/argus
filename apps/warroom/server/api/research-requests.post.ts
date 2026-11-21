import { parseResearchTopic, ResearchRequestRefusedError } from "@argus/core";

/** A body bigger than this (as JSON) is refused unread: the form sends one topic of at most 80 characters. */
const MAX_BODY_CHARS = 1024;
const STATUS_OF: Record<ResearchRequestRefusedError["code"], number> = { invalid: 400, pending: 429, "daily-cap": 429 };

/**
 * The Operator's topic (human researcher ticket 05): `{ topic }` becomes one pending request the worker turns into a Research brief. The server, not
 * the page, does the checks: the body is exactly that one key, the topic is text, flattened to one line and 1 to 80 characters, and one request waits at
 * a time (429) with at most 20 in 24 hours (429). Writes the request row and nothing else: no brief, no Proposal, no status (CODING_STANDARDS rule 1).
 * The topic is untrusted: it is shown as escaped text, and the worker fences it before any model reads it. Returns `{ id, status: "pending" }`.
 */
export default defineEventHandler(async (event) => {
  const bad = (statusMessage: string) => createError({ statusCode: 400, statusMessage });
  const body: unknown = await readBody<unknown>(event);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw bad("The body must be a JSON object with a topic");
  if (JSON.stringify(body).length > MAX_BODY_CHARS) throw bad("The request is too large");
  if (Object.keys(body).some((k) => k !== "topic")) throw bad("The body has keys other than topic");
  const parsed = parseResearchTopic((body as { topic?: unknown }).topic);
  if (!parsed.ok) throw bad(parsed.problem);
  try {
    const request = useStore().requestResearch(parsed.topic);
    return { id: request.id, status: request.status };
  } catch (e) {
    if (e instanceof ResearchRequestRefusedError) throw createError({ statusCode: STATUS_OF[e.code], statusMessage: e.message });
    throw e;
  }
});
