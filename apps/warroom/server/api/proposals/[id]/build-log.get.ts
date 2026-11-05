import { closeSync, openSync, readSync, statSync } from "node:fs";
import { buildLogPathFor } from "@argus/core";

const MAX_CHUNK_BYTES = 256 * 1024;

/** How many leading bytes of `buf` are whole UTF-8 characters (a read can end mid-character). */
function completeUtf8Length(buf: Buffer): number {
  let i = buf.length - 1;
  let back = 0;
  while (i >= 0 && back < 3 && (buf[i]! & 0xc0) === 0x80) {
    i--;
    back++;
  }
  if (i < 0) return buf.length;
  const lead = buf[i]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return buf.length - i < need ? i : buf.length;
}

/**
 * The Build log from byte `offset` on (the details view polls this while a Build runs). Returns the new text, the offset
 * to ask for next, and the file's size. An offset past the end means the log was replaced, so it restarts from the top.
 */
export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, "id"));
  if (!useStore().getProposal(id)) throw createError({ statusCode: 404, statusMessage: "Proposal not found" });
  const asked = Number(getQuery(event).offset);
  let offset = Number.isInteger(asked) && asked > 0 ? asked : 0;
  const path = buildLogPathFor(useDataDir(), id);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { content: "", offset: 0, size: 0 };
  }
  if (offset > size) offset = 0;
  const buf = Buffer.alloc(Math.min(MAX_CHUNK_BYTES, size - offset));
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, offset);
  } finally {
    closeSync(fd);
  }
  const whole = buf.subarray(0, completeUtf8Length(buf));
  return { content: whole.toString("utf8"), offset: offset + whole.length, size };
});
