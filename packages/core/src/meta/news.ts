import type { Datastore } from "../datastore.ts";
import { META_RULE, type MetaConfig } from "./config.ts";
import { isGenericKey } from "./group.ts";
import { normaliseText } from "./key.ts";
import type { ContextHeadline } from "./store.ts";

/**
 * The news that matches a Meta (missed ideas ticket 03, docs/adr/0011): context-class Signals (RSS, Trends, GitHub) whose title names the
 * Meta's subject key. News is context for the Operator and for the summary prompt and is never a trigger: nothing here raises an alert or
 * makes a Narrative. Headlines are third-party text and are untrusted.
 *
 * Matching is a word-for-word comparison of the normalised headline (`normaliseText`) against the key's words: no RegExp is built from
 * either, so a hostile headline or key costs the same as a long one (the headline is read up to `HEADLINE_CHARS` characters, the key is at
 * most 64).
 */

/** Most characters of a normalised headline read for matching. */
const HEADLINE_CHARS = 1_000;

export type MetaNewsItem = ContextHeadline;

/** A headline word equals a key word, allowing a plural or a possessive whose apostrophe the normaliser dropped (`jensens` for `jensen`). */
const sameWord = (word: string | undefined, key: string): boolean => word === key || word === `${key}s`;

/**
 * True when the headline names the key: the key's words appear next to each other in the headline, or the key without spaces is one headline
 * word or two adjacent ones joined (`gta6` for "GTA 6"). A key that is generic (`isGenericKey`) or shorter than `minKeyChars` characters
 * with its spaces removed never matches: a common word names no subject.
 */
export function headlineNamesKey(title: string, key: string, minKeyChars: number = META_RULE.newsMinKeyChars): boolean {
  const joined = key.replaceAll(" ", "");
  if (key === "" || isGenericKey(key) || [...joined].length < minKeyChars) return false;
  const words = normaliseText(title, HEADLINE_CHARS).split(" ");
  const keyWords = key.split(" ");
  for (let i = 0; i < words.length; i++) {
    if (keyWords.every((k, j) => sameWord(words[i + j], k))) return true;
    if (sameWord(words[i], joined)) return true;
    const next = words[i + 1];
    if (next !== undefined && words[i] !== undefined && sameWord(words[i] + next, joined)) return true;
  }
  return false;
}

/** The headlines (given newest first) that name `key`, the same title once, at most `config.newsMaxItems`. */
export function matchingNews(headlines: readonly ContextHeadline[], key: string, config: Pick<MetaConfig, "newsMaxItems" | "newsMinKeyChars"> = META_RULE): MetaNewsItem[] {
  const out: MetaNewsItem[] = [];
  const seen = new Set<string>();
  for (const h of headlines) {
    if (out.length >= config.newsMaxItems) break;
    if (!headlineNamesKey(h.title, key, config.newsMinKeyChars)) continue;
    const same = normaliseText(h.title, HEADLINE_CHARS);
    if (seen.has(same)) continue; // one story carried by several feeds is one line
    seen.add(same);
    out.push(h);
  }
  return out;
}

/** The matching news of each key, from one read of the last `config.newsWindowHours` of context headlines before `now`. */
export function newsForKeys(store: Pick<Datastore, "contextHeadlines">, keys: readonly string[], now: Date, config: MetaConfig = META_RULE): Map<string, MetaNewsItem[]> {
  const since = new Date(now.getTime() - config.newsWindowHours * 3_600_000).toISOString();
  const headlines = keys.length === 0 ? [] : store.contextHeadlines(since, now.toISOString());
  return new Map(keys.map((k) => [k, matchingNews(headlines, k, config)]));
}
