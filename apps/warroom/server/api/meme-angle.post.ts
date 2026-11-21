import { MemeAngleRefusedError, memeAngleConfigFromEnv, parseAngle } from "@argus/core";

/** A body bigger than this (as JSON) is refused unread: the form sends a Meta key and at most 600 characters. */
const MAX_BODY_CHARS = 4096;
const MAX_KEY_CHARS = 200;
const STATUS_OF: Record<MemeAngleRefusedError["code"], number> = { "unknown-meta": 400, invalid: 400, duplicate: 409, "daily-cap": 429, pending: 429 };

/**
 * The Operator's angle on a Meta (meta redesign ticket 11): `{ metaKey, angle }` becomes one pending request the worker runs. The server, not the
 * page, does the checks: the body is exactly those two keys, the angle is cleaned (one line, 1 to 600 characters, the first http(s) link split
 * out and replaced by its host), the Meta key is a Meta or Watching subject of the newest run, the same angle is not asked twice in 24 h (409),
 * and the daily cap and the one waiting request are answered with 429 and the reason in words. Writes the request row and nothing else: no
 * Proposal, no status (CODING_STANDARDS rule 1). Returns `{ id, status: "pending", sourceUrl, urlDropped }`.
 */
export default defineEventHandler(async (event) => {
  const bad = (statusMessage: string) => createError({ statusCode: 400, statusMessage });
  const body: unknown = await readBody<unknown>(event);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw bad("The body must be a JSON object with metaKey and angle");
  if (JSON.stringify(body).length > MAX_BODY_CHARS) throw bad("The request is too large");
  const extra = Object.keys(body).filter((k) => k !== "metaKey" && k !== "angle");
  if (extra.length > 0) throw bad("The body has keys other than metaKey and angle");
  const { metaKey, angle } = body as { metaKey?: unknown; angle?: unknown };
  if (typeof metaKey !== "string" || metaKey === "" || metaKey.length > MAX_KEY_CHARS) throw bad("metaKey is required");
  // No `angle` key at all is the "Make ideas" button (human researcher ticket 02): a request with no text. An angle that is present must still be text.
  const parsed = angle === undefined ? ({ ok: true, angle: "", sourceUrl: null, urlDropped: false } as const) : parseAngle(angle);
  if (!parsed.ok) throw bad(parsed.problem.charAt(0).toUpperCase() + parsed.problem.slice(1));
  try {
    const request = useStore().requestMemeAngle({ metaKey, angle: parsed.angle, sourceUrl: parsed.sourceUrl, urlDropped: parsed.urlDropped }, { maxPerDay: memeAngleConfigFromEnv(process.env).maxPerDay });
    return { id: request.id, status: request.status, sourceUrl: request.sourceUrl, urlDropped: request.urlDropped };
  } catch (e) {
    if (e instanceof MemeAngleRefusedError) throw createError({ statusCode: STATUS_OF[e.code], statusMessage: e.message });
    throw e;
  }
});
