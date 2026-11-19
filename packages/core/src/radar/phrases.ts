import { normaliseKey } from "../meta/key.ts";
import { STOPWORDS } from "../stopwords.ts";
import { cleanTerm } from "./clean.ts";
import { RADAR_CONFIG } from "./config.ts";
import { radarKey } from "./key.ts";

/**
 * Headline phrases, counted by code (spec section 5.1; ticket 02). A headline is cut into word sequences of 1 to 4 words with stop words dropped,
 * each keyed through `radarKey`, so "GTA VI" in one feed and "GTA 6" in another are one key. A phrase counts once per feed, and one that 3 or more
 * distinct feeds carry within 3 hours is a candidate. The model never extracts terms from headlines. Nothing here builds a RegExp from the text:
 * the patterns are fixed literals, the headline is cut first (300 characters, 40 words), so the cost of a hostile headline is that of a long one.
 */

const SPACES = /\s+/u;
/** "Anthropic's" and "Anthropic’s" are the word "anthropic". */
const POSSESSIVE = /['’]s$/iu;
const HAS_LETTER = /\p{L}/u;

export interface HeadlinePhrase {
  /** `radarKey(term)`; never empty. */
  key: string;
  /** The words of the phrase, lower case, one space between. */
  term: string;
}

/** The content words of a headline: folded by `normaliseKey` (the one normaliser: lower case, letters and digits only), stop words and one-letter words dropped, at most 40. */
function contentWords(title: string): string[] {
  const flat = cleanTerm(title, RADAR_CONFIG.newsTitleChars);
  const words: string[] = [];
  for (const raw of flat.split(SPACES)) {
    const w = normaliseKey(raw.replace(POSSESSIVE, "")).replaceAll(" ", "").slice(0, RADAR_CONFIG.headlineWordChars);
    if (w === "" || STOPWORDS.has(w)) continue;
    if (w.length < 2 && !/\p{Nd}/u.test(w)) continue;
    words.push(w);
    if (words.length >= RADAR_CONFIG.headlineWordsMax) break;
  }
  return words;
}

/**
 * Every phrase of a headline, once per key. A phrase needs at least one word of 3 letters or more, so a run of numbers or of short words is not a
 * phrase. At most `4 * 40` phrases from one headline, however long it is.
 */
export function headlinePhrases(title: unknown): HeadlinePhrase[] {
  if (typeof title !== "string") return [];
  const words = contentWords(title);
  const substantial = words.map((w) => w.length >= 3 && HAS_LETTER.test(w));
  const out = new Map<string, HeadlinePhrase>();
  for (let n = 1; n <= RADAR_CONFIG.phraseWordsMax; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      if (!substantial.slice(i, i + n).some(Boolean)) continue;
      const term = words.slice(i, i + n).join(" ");
      const key = radarKey(term);
      if (key !== "" && !out.has(key)) out.set(key, { key, term });
    }
  }
  return [...out.values()];
}

/** One feed's carrying of a phrase. `title` and `url` are already cleaned (`cleanTerm`, `safeUrl`). */
export interface PhraseEntry {
  feed: string;
  /** The item's own date (epoch ms). */
  at: number;
  title: string;
  url: string;
  term: string;
}

/**
 * The 3-hour window of phrases, in memory. A feed serves its last items again on every poll, so after a restart the next poll rebuilds the window;
 * nothing here needs to survive one. A phrase counts once per feed (the earliest item wins). The window is bounded: past `phraseKeysMax` keys a new
 * phrase is not counted until old ones age out.
 */
export class PhraseCounter {
  private readonly byKey = new Map<string, Map<string, PhraseEntry>>();

  get size(): number {
    return this.byKey.size;
  }

  /** Counts a headline for a feed. Returns the keys that were new for this feed (the others were already counted). */
  add(feed: string, title: string, url: string, atMs: number): string[] {
    const fresh: string[] = [];
    for (const p of headlinePhrases(title)) {
      let feeds = this.byKey.get(p.key);
      if (!feeds) {
        if (this.byKey.size >= RADAR_CONFIG.phraseKeysMax) continue;
        feeds = new Map();
        this.byKey.set(p.key, feeds);
      }
      const have = feeds.get(feed);
      if (have && have.at <= atMs) continue;
      feeds.set(feed, { feed, at: atMs, title, url, term: p.term });
      if (!have) fresh.push(p.key);
    }
    return fresh;
  }

  /** Drops what has left the window. */
  expire(nowMs: number): void {
    const from = nowMs - RADAR_CONFIG.agreementWindowMs;
    for (const [key, feeds] of this.byKey) {
      for (const [feed, e] of feeds) if (e.at < from) feeds.delete(feed);
      if (feeds.size === 0) this.byKey.delete(key);
    }
  }

  /** The feeds carrying a key inside the window, oldest first. */
  entries(key: string, nowMs: number): PhraseEntry[] {
    const from = nowMs - RADAR_CONFIG.agreementWindowMs;
    const to = nowMs + RADAR_CONFIG.itemFutureSlackMs;
    return [...(this.byKey.get(key)?.values() ?? [])].filter((e) => e.at >= from && e.at <= to).sort((a, b) => a.at - b.at);
  }

  /** The keys carried by `min` or more distinct feeds inside the window (default: the candidate rule, 3). */
  agreed(nowMs: number, min: number = RADAR_CONFIG.phraseFeedsMin): string[] {
    const from = nowMs - RADAR_CONFIG.agreementWindowMs;
    const to = nowMs + RADAR_CONFIG.itemFutureSlackMs;
    const out: string[] = [];
    for (const [key, feeds] of this.byKey) {
      let n = 0;
      for (const e of feeds.values()) if (e.at >= from && e.at <= to) n++;
      if (n >= min) out.push(key);
    }
    return out;
  }
}
