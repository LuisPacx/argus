import { MAX_VERDICT_NOTE_CHARS, RUBRIC_KEYS, SCORE_TAGS, VERDICTS, VERDICT_TAGS, type RubricKey, type VerdictTag } from "@argus/core";

const KEYS = ["verdict", "tags", "dimensions", "note"];
const bad = (statusMessage: string) => createError({ statusCode: 400, statusMessage });

/** A list of known values, each once, in the order given; anything else is a 400 naming `what`. */
function pickAll<T extends string>(value: unknown, allowed: readonly T[], what: string): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw bad(`${what} must be a list`);
  const out: T[] = [];
  for (const item of value) {
    const known = allowed.find((a) => a === item);
    if (known === undefined) throw bad(`Unknown ${what.replace(/s$/, "")}`);
    if (!out.includes(known)) out.push(known);
  }
  return out;
}

/**
 * The Operator's Verdict on a Narrative (War Room ticket 19): `{ verdict, tags?, dimensions?, note? }`, like the Proposal command route: the
 * server does every check. The body has only those keys; `dimensions` (Rubric keys) are allowed only with a score tag; the note is trimmed
 * and at most `MAX_VERDICT_NOTE_CHARS`. The Score id and Rubric version are read by the store, never from the body. Writes the verdict row
 * and nothing else (CODING_STANDARDS rule 1). Returns the stored verdict.
 */
export default defineEventHandler(async (event) => {
  const narrativeId = Number(getRouterParam(event, "id"));
  if (!useStore().getNarrative(narrativeId)) throw createError({ statusCode: 404, statusMessage: "Narrative not found" });
  const body: unknown = await readBody<unknown>(event);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw bad("The body must be a JSON object with a verdict");
  if (Object.keys(body).some((k) => !KEYS.includes(k))) throw bad(`The body has keys other than ${KEYS.join(", ")}`);
  const { verdict: rawVerdict, tags: rawTags, dimensions: rawDimensions, note: rawNote } = body as Record<string, unknown>;
  const verdict = VERDICTS.find((v) => v === rawVerdict);
  if (verdict === undefined) throw bad("Unknown verdict");
  const tags: VerdictTag[] = pickAll(rawTags, VERDICT_TAGS, "tags");
  const dimensions: RubricKey[] = pickAll(rawDimensions, RUBRIC_KEYS, "dimensions");
  if (dimensions.length > 0 && !tags.some((t) => SCORE_TAGS.includes(t))) throw bad("Dimensions go with the score-too-high or score-too-low tag");
  if (rawNote !== undefined && typeof rawNote !== "string") throw bad("The note must be text");
  const note = (rawNote ?? "").trim();
  if ([...note].length > MAX_VERDICT_NOTE_CHARS) throw bad(`The note is over ${MAX_VERDICT_NOTE_CHARS} characters`);
  return useStore().addNarrativeVerdict({ narrativeId, verdict, tags, dimensions, note });
});
