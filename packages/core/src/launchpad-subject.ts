import { isGenericKey } from "./meta/group.ts";
import { normaliseKey } from "./meta/key.ts";
import { CREATE_TITLE_PREFIX, MIGRATE_TITLE_PREFIX } from "./sources/pumpportal.ts";
import { STOPWORDS } from "./stopwords.ts";

/**
 * What a launchpad Signal is about (viral sources ticket 01). A PumpPortal Signal's title is a fixed template around the token the
 * creator named (`<template> <name> ($<ticker>)`, see `CREATE_TITLE_PREFIX`), so the template is the same for every token and says nothing;
 * the name and ticker are the subject. This reads them back from the stored title and id (no new column), and builds the keys the
 * clusterer matches on.
 *
 * Names and tickers are written by token creators and are untrusted. Nothing here builds a RegExp from them: the strings are cut with
 * fixed-string searches, and the one pattern that runs on a headline is a literal with no nested repetition (linear).
 */
export const LAUNCHPAD_SOURCE_ID = "pumpportal:events";
const CREATE_PREFIX = CREATE_TITLE_PREFIX;
const MIGRATE_PREFIX = MIGRATE_TITLE_PREFIX;

export interface TokenTitle {
  /** The text after the template: `<name> ($<ticker>)`, or just the name when there is no ticker. */
  label: string;
  name: string;
  symbol: string;
}

/** Splits `<name> ($<ticker>)` at its last ` ($`. A title without a trailing ticker is all name. */
export function parseTokenTitle(text: string): TokenTitle {
  const open = text.lastIndexOf(" ($");
  if (open > 0 && text.endsWith(")")) return { label: text, name: text.slice(0, open), symbol: text.slice(open + 3, -1) };
  return { label: text, name: text, symbol: "" };
}

export interface LaunchpadSignal {
  kind: "create" | "migrate";
  mint: string;
  /** The title after the template. */
  label: string;
  name: string;
  symbol: string;
  /** False when the title names nothing but the mint (the token had no name and no ticker, or a bond carries none): such a Signal has no subject. */
  named: boolean;
}

/** The launchpad Signal's kind, mint and subject, or undefined for any other Signal (or a PumpPortal one in a shape this does not know). */
export function parseLaunchpadSignal(signal: { id: string; sourceId: string; title: string }): LaunchpadSignal | undefined {
  if (signal.sourceId !== LAUNCHPAD_SOURCE_ID) return undefined;
  const rest = signal.id.startsWith(`${LAUNCHPAD_SOURCE_ID}:`) ? signal.id.slice(LAUNCHPAD_SOURCE_ID.length + 1) : "";
  const colon = rest.indexOf(":");
  const kind = rest.slice(0, colon);
  const mint = rest.slice(colon + 1);
  if ((kind !== "create" && kind !== "migrate") || mint === "") return undefined;
  const prefix = kind === "create" ? CREATE_PREFIX : MIGRATE_PREFIX;
  if (!signal.title.startsWith(prefix)) return undefined;
  const label = signal.title.slice(prefix.length);
  // The Source writes the abbreviated mint when it has neither a name nor a ticker (always, for a bond).
  const named = label !== `${mint.slice(0, 4)}...${mint.slice(-4)}` && label.trim() !== "";
  const token = named ? parseTokenTitle(label) : { name: "", symbol: "" };
  return { kind, mint, label, name: token.name, symbol: token.symbol, named };
}

export type KeyRole = "name" | "ticker";

export interface LaunchpadKeys {
  name: string | undefined;
  ticker: string | undefined;
}

/**
 * The subject keys of a token (ticket 03's normaliser, `meta/key.ts`): the name's and the ticker's, each undefined when empty or too generic
 * to mean anything (`coin`, `meme`, `ai`, a single character; `meta/group.ts`). A token with no key here is a Narrative of its own.
 */
export function launchpadKeys(name: string, symbol: string): LaunchpadKeys {
  const n = normaliseKey(name);
  const t = normaliseKey(symbol);
  return { name: n !== "" && !isGenericKey(n) ? n : undefined, ticker: t !== "" && !isGenericKey(t) ? t : undefined };
}

/**
 * Which claimed key to try, in order: a name that is another token's name, a ticker that is another's ticker, then across (a name that
 * is someone's ticker, a ticker that is someone's name). Same-kind matches first, so `Jensen Huang ($TRUMP)` joins the Jensen Narrative
 * by its name before it joins a Trump Narrative by its ticker.
 */
export function claimOrder(keys: LaunchpadKeys): Array<{ role: KeyRole; key: string }> {
  const out: Array<{ role: KeyRole; key: string }> = [];
  if (keys.name !== undefined) out.push({ role: "name", key: keys.name });
  if (keys.ticker !== undefined) out.push({ role: "ticker", key: keys.ticker });
  if (keys.name !== undefined) out.push({ role: "ticker", key: keys.name });
  if (keys.ticker !== undefined) out.push({ role: "name", key: keys.ticker });
  return out;
}

const WORD = /[\p{L}\p{Nd}]+(?:['’][\p{L}]+)?/gu;
const UPPER = /^\p{Lu}/u;
const POSSESSIVE = /['’]s$/i;
const MAX_TITLE_UNITS = 400;
const MIN_SINGLE_KEY_CHARS = 4;
/** More than this share of a headline's content words capitalised makes it Title Case. */
const TITLE_CASE_SHARE = 0.6;
const MIN_MULTI_KEY_CHARS = 7;

/**
 * The phrases of a non-launchpad headline that could name a launchpad token: every run of one to three words, as a subject key. Two kinds
 * only, chosen for precision on the 3-day DB copy (docs/adr/0007, amendment of 2026-11-14):
 *   - a phrase of two or three words, at least two of them neither stopwords nor generic keys (`coin`, `ai`, `meme`: so `AI coin` is not one),
 *     at least 7 characters (`colette kress`, `david walliams`);
 *   - a single word of at least 4 characters that is written with a capital inside a headline that is neither Title Case nor all lower case
 *     (and is not the headline's first word) and is not a common word. "Common" is the embedder's call (`Embedder.isCommonWord`): the semantic model's own
 *     vocabulary holds `moon`, `zero`, `poland` and `party` as one piece each and splits `misu`, `melania`, `mexc` and `eisenkot`. With no
 *     such test (the lexical embedder) no single word is offered.
 */
export function crossSourceForms(title: string, isCommonWord?: (word: string) => boolean): string[] {
  const words: Array<{ key: string; capital: boolean }> = [];
  for (const m of title.slice(0, MAX_TITLE_UNITS).matchAll(WORD)) {
    const key = normaliseKey(m[0].replace(POSSESSIVE, ""));
    if (key !== "") words.push({ key, capital: UPPER.test(m[0]) });
  }
  // A capital means something only in a headline that is not Title Case (most of its content words capitalised: Wired, Decrypt, Hacker News)
  // and not all lower case (a Trends query, a repository name): in those a capital proves nothing, so no single word is offered.
  const cased = title !== title.toLowerCase();
  const content = words.filter((w) => !STOPWORDS.has(w.key) && [...w.key].length >= 3);
  const titleCase = content.length >= 4 && content.filter((w) => w.capital).length / content.length > TITLE_CASE_SHARE;
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const first = words[i] as (typeof words)[number];
    if (
      isCommonWord !== undefined &&
      cased &&
      !titleCase &&
      first.capital &&
      i > 0 &&
      [...first.key].length >= MIN_SINGLE_KEY_CHARS &&
      !STOPWORDS.has(first.key) &&
      !isGenericKey(first.key) &&
      !isCommonWord(first.key)
    ) {
      out.push(first.key);
    }
    for (let len = 2; len <= 3 && i + len <= words.length; len++) {
      const parts = words.slice(i, i + len).map((w) => w.key);
      const phrase = parts.join(" ");
      if (parts.filter((p) => !STOPWORDS.has(p) && !isGenericKey(p)).length < 2 || [...phrase].length < MIN_MULTI_KEY_CHARS || isGenericKey(phrase)) continue;
      out.push(phrase);
    }
  }
  return [...new Set(out)];
}
