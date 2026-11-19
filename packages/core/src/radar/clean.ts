import { cleanLine } from "../meme/ideas.ts";
import { stripHtml } from "../sources/rss.ts";
import { RADAR_CONFIG } from "./config.ts";

/**
 * The only two ways third-party text reaches the radar's storage and a search (spec section 3, untrusted text).
 * `cleanTerm` is for storage and display; `searchWords` is for a DexScreener query (and, in stage B, an X query). Nothing here builds a RegExp
 * from the text: the patterns are fixed literals, and the input is cut first so their cost does not depend on a hostile length.
 */

const ANGLE_BRACKETS = /[<>]/g;
const WORD_CHARS = /[^\p{L}\p{M}\p{Nd}\s]/gu;
const SPACES = /\s+/u;

/** One flat line of at most `max` characters (default 300), markup removed, control and invisible characters turned to spaces. A non-string is "". */
export function cleanTerm(text: unknown, max: number = RADAR_CONFIG.termChars): string {
  if (typeof text !== "string") return "";
  const cut = text.slice(0, RADAR_CONFIG.inputUnits);
  return cleanLine(stripHtml(cut).replace(ANGLE_BRACKETS, " "), max);
}

/**
 * The words a search may carry: letters, digits and spaces only (any other mark becomes a space, so `from:elonmusk` is two words and `"a" OR (b)`
 * cannot keep its quotes or brackets), 1 to 6 words, each cut to 40 characters. Null means refuse: nothing is left to search.
 */
export function searchWords(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const flat = text.slice(0, RADAR_CONFIG.inputUnits).replace(WORD_CHARS, " ");
  const words = flat
    .split(SPACES)
    .filter((w) => w !== "")
    .slice(0, RADAR_CONFIG.searchWordsMax)
    .map((w) => w.slice(0, RADAR_CONFIG.searchWordChars));
  return words.length === 0 ? null : words.join(" ");
}
