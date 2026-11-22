/**
 * The shared text-matching rule (ADR 0018, christmas-fix ticket 01): used by research widen and by the Meta blend pass. Plain code, linear in the text, no
 * I/O, and no pattern is ever built from a term.
 */

/** A term shorter than this is a stem: it matches only at a word boundary (see `termMatches`). */
export const SHORT_TERM_CHARS = 4;
/** A stem found at the END of a word needs at least this many characters before it: "CATEMAS" is a blend, "Thomas" is a name. */
const BLEND_PREFIX_MIN = 4;

/** NFKC (full-width letters, compatibility forms, composed accents), lower-cased, whitespace runs collapsed. */
export const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Whether `term` is in `text`, case-insensitively, after Unicode NFKC normalisation, with runs of whitespace collapsed. A term of 4 or more characters
 * matches anywhere. A shorter term (a stem such as "mas") matches only a whole word, the start of a word ("GTA6"), or the end of a word that has at least
 * 4 characters before the stem ("CATEMAS", "Bullmas" but not "Thomas" or "Xmas"); never the middle of one. Words are runs of letters and digits.
 */
export function termMatches(term: string, text: string): boolean {
  return matchesField(norm(term), prepare(text, true));
}

/** A field normalised once, with its words split once (only when a short term will need them), however many terms are tried against it. */
export interface Field {
  text: string;
  words: string[];
}
export const prepare = (raw: string, withWords: boolean): Field => {
  const text = norm(raw);
  return { text, words: withWords ? text.split(/[^\p{L}\p{N}]+/u) : [] };
};

/** `t` is an already normalised term. */
export function matchesField(t: string, f: Field): boolean {
  if (t === "") return false;
  if (t.length >= SHORT_TERM_CHARS) return f.text.includes(t);
  for (const word of f.words) {
    if (word.startsWith(t)) return true;
    if (word.endsWith(t) && word.length - t.length >= BLEND_PREFIX_MIN) return true;
  }
  return false;
}
