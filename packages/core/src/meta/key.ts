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
  return normaliseText(text, MAX_KEY_CHARS);
}

/** `normaliseKey` with another length cut: a headline is matched against keys, so it keeps far more than a key's 64 characters (ticket 03 of missed ideas). */
export function normaliseText(text: string, maxChars: number): string {
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
      if (count + (gap ? 2 : 1) > maxChars) break;
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

/** The roman numerals `aliasKey` converts: two or more letters, `ii` to `xx`. The single letters `i`, `v` and `x` are never numerals here (`gta v`, `mix`). */
const ROMAN_NUMERALS: ReadonlyMap<string, number> = new Map([
  ["ii", 2], ["iii", 3], ["iv", 4], ["vi", 6], ["vii", 7], ["viii", 8], ["ix", 9],
  ["xi", 11], ["xii", 12], ["xiii", 13], ["xiv", 14], ["xv", 15], ["xvi", 16], ["xvii", 17], ["xviii", 18], ["xix", 19], ["xx", 20],
]);
const LONGEST_NUMERAL = 5;
/** The letters a roman numeral is written in: a suffix that follows one of them is part of a longer run (`starxxi`), not a numeral of its own. */
const NUMERAL_LETTERS = "ivx";
/** A numeral only counts after a base of at least this many characters, so `taxi`, `mix` and `vivi` stay as they are. */
const MIN_ALIAS_BASE_CHARS = 3;

/** True when `text` has at least `n` characters (code points); reads only its first `4 * n` code units, so a megabyte costs the same as a short name. */
function hasChars(text: string, n: number): boolean {
  return Array.from(text.slice(0, n * 4)).length >= n;
}

/**
 * The strict alias form of a key (ADR 0015, decision 4): spaces removed, then a trailing roman numeral `ii` to `xx` after a base of at least
 * three characters replaced by its digits. `gta 6`, `gta6`, `gta vi` and `gtavi` all give `gta6`; `gta 5`, `gta v` and `gta iv` do not meet
 * it; `taxi`, `wifi`, `mix`, `vivi`, `civic` and `xi` keep their own form. Pure and linear: one pass to remove the spaces and a lookup of at
 * most five suffixes in a fixed table, no pattern built from the text. A numeral that follows another numeral letter (`starxxi`) is part of a
 * longer run, not a numeral.
 */
export function aliasKey(key: string): string {
  const joined = key.replaceAll(" ", "");
  for (let len = Math.min(LONGEST_NUMERAL, joined.length); len >= 2; len--) {
    const n = ROMAN_NUMERALS.get(joined.slice(joined.length - len));
    if (n === undefined) continue;
    const base = joined.slice(0, joined.length - len);
    if (NUMERAL_LETTERS.includes(base.slice(-1)) && base !== "") continue;
    if (hasChars(base, MIN_ALIAS_BASE_CHARS)) return `${base}${n}`;
  }
  return joined;
}

/** The distinct keys of a token: its name's, then its ticker's. Zero, one or two. */
export function subjectKey(name: string, symbol: string): string[] {
  const keys: string[] = [];
  for (const k of [normaliseKey(name), normaliseKey(symbol)]) if (k !== "" && !keys.includes(k)) keys.push(k);
  return keys;
}
