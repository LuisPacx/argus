/**
 * The token subject key (ticket 03, slice 1): what "the same token name" means for Metas, and for any later code that must agree
 * with them (ticket 01's copycat rule imports this, it does not build a second normaliser).
 *
 * Names and tickers are written by token creators and are untrusted. Nothing here builds a RegExp from them: the only patterns are
 * fixed single-character literals applied to one code point at a time, so the cost is linear in the input whatever it holds.
 */

/** A key longer than this many code points is cut: two names that agree this far are the same subject for our purposes. */
export const MAX_KEY_CHARS = 64;
/** At most this much of a name or ticker is read, so a hostile megabyte costs the same as a long name. */
const MAX_INPUT_UNITS = 20_000;

const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;
const MARK = /\p{M}/u;
const WHITESPACE = /\s/u;
/** Format characters (Cf): zero-width space and joiners, bidi controls, the BOM. JavaScript's `\s` counts the BOM as whitespace. */
const FORMAT = /\p{Cf}/u;
/** Variation selectors ride on emoji; they are marks to Unicode but carry no letter. */
const isVariationSelector = (cp: number): boolean => (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);

/**
 * One normalised key: NFKC and lower case, then only letters and digits (any script, CJK kept as is) and single spaces between words.
 * `$`, punctuation, emoji, and zero-width and bidi controls (which are format characters) are dropped without leaving a gap;
 * real whitespace becomes one space. Combining marks stay only when they follow a kept character. Empty when nothing is left.
 */
export function normaliseKey(text: string): string {
  const s = text.slice(0, MAX_INPUT_UNITS).normalize("NFKC").toLowerCase();
  let out = "";
  let count = 0;
  let pendingSpace = false;
  let lastKept = false;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (FORMAT.test(ch)) continue; // zero-width, bidi and joiner characters vanish; they neither join nor separate words
    if (LETTER_OR_DIGIT.test(ch) || (lastKept && MARK.test(ch) && !isVariationSelector(cp))) {
      const gap = pendingSpace && out !== "";
      if (count + (gap ? 2 : 1) > MAX_KEY_CHARS) break;
      if (gap) out += " ";
      out += ch;
      count += gap ? 2 : 1;
      pendingSpace = false;
      lastKept = true;
    } else {
      lastKept = false;
      if (WHITESPACE.test(ch)) pendingSpace = true;
    }
  }
  return out;
}

/** The distinct keys of a token: its name's, then its ticker's. Zero, one or two. */
export function subjectKey(name: string, symbol: string): string[] {
  const keys: string[] = [];
  for (const k of [normaliseKey(name), normaliseKey(symbol)]) if (k !== "" && !keys.includes(k)) keys.push(k);
  return keys;
}
