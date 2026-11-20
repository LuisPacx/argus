import { recordPicks } from "@argus/core";

/** A body bigger than this (as JSON) is refused unread: the form sends at most 2000 characters of addresses and a reason and a topic. */
const MAX_BODY_CHARS = 4096;

/**
 * The Operator's Picks (human researcher ticket 03): `{ text, reason?, topic? }` is one or more contract addresses with an optional reason and topic.
 * Each address is looked up on DexScreener on its own and recorded with a snapshot of the coin; a malformed, unknown or priceless address, a repeat
 * inside 24 hours and a DexScreener failure each give that line a plain message and record nothing for it, and the other lines go on. The reason
 * and topic are cleaned (one line, cut to the limit) by `recordPicks`. No model is called. Returns `{ lines: [{ text, ok, message?, pickId? }], skipped }`.
 */
export default defineEventHandler(async (event) => {
  const bad = (statusMessage: string) => createError({ statusCode: 400, statusMessage });
  const body: unknown = await readBody<unknown>(event);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw bad("The body must be a JSON object with text, reason and topic");
  if (JSON.stringify(body).length > MAX_BODY_CHARS) throw bad("The request is too large");
  if (Object.keys(body).some((k) => k !== "text" && k !== "reason" && k !== "topic")) throw bad("The body has keys other than text, reason and topic");
  const { text, reason, topic } = body as { text?: unknown; reason?: unknown; topic?: unknown };
  if (typeof text !== "string" || text.trim() === "") throw bad("Paste at least one contract address");
  if ((reason !== undefined && typeof reason !== "string") || (topic !== undefined && typeof topic !== "string")) throw bad("The reason and the topic must be text");
  const { lines, skipped } = await recordPicks(useStore(), useDexClient(), { text, reason, topic });
  return { lines: lines.map((l) => (l.ok ? { text: l.text, ok: true, pickId: l.pick.id } : { text: l.text, ok: false, message: l.message })), skipped };
});
