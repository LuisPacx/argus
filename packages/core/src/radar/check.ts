import { isLiveToken, LIVE_TOKEN_MIN_LIQUIDITY_USD } from "../meme/live-token.ts";
import { normaliseKey } from "../meta/key.ts";
import { metaMoney } from "../meta/summary.ts";
import type { DexPair, DexScreenerClient } from "../sources/dexscreener.ts";
import { cleanTerm, searchWords } from "./clean.ts";
import { RADAR_CONFIG } from "./config.ts";
import { radarKey } from "./key.ts";
import type { CheckResult, Lookalike, TracedToken } from "./types.ts";

/**
 * The untokenized check (spec section 5.5, ticket 01): is there a live token on Solana under this Trend's name, and how many creators have
 * launched copies locally. The live-token test is imported from `meme/live-token.ts`, not copied; its numbers are not repeated here (a test reads
 * this file to check). Everything compared is third-party text: no RegExp is built from it, and the names are matched as words and as keys.
 *
 * A pair with no creation time is kept, never dropped: dropping it could read a live coin as absent and call the Trend untokenized.
 * A search that throws is `not traced`; it is never untokenized.
 */

const HOUR_MS = 3_600_000;

/** One stored create, as the local index reads it. */
export interface LocalCreate {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
}

/**
 * The last 48 hours of stored creates, indexed once per tick by their normalised names (`radarKey` and the words of `normaliseKey`). Matching reads
 * the index only: no pattern is built from a name or a phrase.
 */
export class LocalCreateIndex {
  private readonly creators: string[] = [];
  private readonly nameWords: string[][] = [];
  private readonly byKey = new Map<string, number[]>();
  private readonly byWord = new Map<string, number[]>();

  static build(creates: Iterable<LocalCreate>): LocalCreateIndex {
    const index = new LocalCreateIndex();
    for (const c of creates) index.add(c);
    return index;
  }

  get size(): number {
    return this.creators.length;
  }

  private add(c: LocalCreate): void {
    const at = this.creators.length;
    const words = normaliseKey(c.name).split(" ").filter((w) => w !== "");
    this.creators.push(c.creator);
    this.nameWords.push(words);
    const push = (map: Map<string, number[]>, k: string) => {
      if (k === "") return;
      const list = map.get(k);
      if (list) {
        if (list[list.length - 1] !== at) list.push(at);
      } else map.set(k, [at]);
    };
    push(this.byKey, radarKey(c.name));
    push(this.byKey, radarKey(c.symbol));
    for (const w of words) push(this.byWord, w);
  }

  /** The creates under any of the phrases (the name has every word of the phrase, or the name or ticker is the phrase squashed together), and their distinct creators. */
  match(phrases: readonly string[]): { creates: number; creators: number } {
    const hit = new Set<number>();
    for (const phrase of phrases) {
      const key = radarKey(phrase);
      const words = normaliseKey(phrase).split(" ").filter((w) => w !== "");
      for (const i of this.byKey.get(key) ?? []) hit.add(i);
      const first = words[0];
      if (first === undefined) continue;
      for (const i of this.byWord.get(first) ?? []) {
        const have = this.nameWords[i] as string[];
        if (words.every((w) => have.includes(w))) hit.add(i);
      }
    }
    const creators = new Set<string>();
    for (const i of hit) {
      const c = this.creators[i] as string;
      if (c !== "") creators.add(c);
    }
    return { creates: hit.size, creators: creators.size };
  }
}

/** The phrases searched for a Trend that has none of its own yet: its label's words (no model has named it in ticket 01). */
export function defaultPhrases(label: string): string[] {
  const words = searchWords(normaliseKey(label));
  return words === null ? [] : [words];
}

/** Whether a DexScreener pair carries the phrase: every word of the phrase is in its normalised name, or its name or ticker is the phrase squashed together. */
export function pairMatches(pair: Pick<DexPair, "name" | "symbol">, phrase: string): boolean {
  const key = radarKey(phrase);
  if (key === "") return false;
  if (radarKey(pair.name) === key || radarKey(pair.symbol) === key) return true;
  const words = normaliseKey(phrase).split(" ").filter((w) => w !== "");
  const have = normaliseKey(pair.name).split(" ");
  return words.length > 0 && words.every((w) => have.includes(w));
}

const capOf = (p: Pick<DexPair, "marketCapUsd" | "fdvUsd">): number | null => p.marketCapUsd ?? p.fdvUsd ?? null;

/** Why a pair that carries the name is not a live token ("pool $4, cap $131K: drained or fake"). */
export function lookalikeReason(p: Pick<DexPair, "liquidityUsd" | "marketCapUsd" | "fdvUsd" | "unpriced">): string {
  if (p.unpriced === true) return "no price data";
  const cap = capOf(p);
  if (cap === null) return "no market cap";
  if (p.liquidityUsd < LIVE_TOKEN_MIN_LIQUIDITY_USD) return `pool ${metaMoney(p.liquidityUsd)}, cap ${metaMoney(cap)}: drained or fake`;
  return `cap ${metaMoney(cap)} on a pool of ${metaMoney(p.liquidityUsd)}: fake cap`;
}

function traced(p: DexPair): TracedToken {
  return {
    name: cleanTerm(p.name, RADAR_CONFIG.tokenNameChars),
    symbol: cleanTerm(p.symbol, RADAR_CONFIG.tokenNameChars),
    url: p.url,
    marketCapUsd: capOf(p),
    liquidityUsd: p.liquidityUsd,
    createdAt: p.pairCreatedAt !== undefined && Number.isFinite(new Date(p.pairCreatedAt).getTime()) ? new Date(p.pairCreatedAt).toISOString() : null,
  };
}

export interface TraceTarget {
  label: string;
  /** When the Trend was first seen (ISO). */
  firstSeen: string;
  /** The cleaned phrases to search; the label's words when absent. */
  phrases?: readonly string[];
}

export interface TraceDeps {
  dex: Pick<DexScreenerClient, "search">;
  localCreates: LocalCreateIndex;
  now: Date;
}

/**
 * One check of one Trend. Precedence of the final state, first match wins: `not traced` (a search failed), `taken` (a live token at the taken cap
 * or more), `contested` (live tokens, all smaller), `tokenizing` (no live token and enough distinct local creators), `untokenized`.
 * A live token always outranks the local count; `tokenizing` outranks `untokenized`.
 */
export async function traceTrend(trend: TraceTarget, deps: TraceDeps): Promise<CheckResult> {
  const failed: CheckResult = { side: "not traced", trace: null, localCreates: null, localCreators: null };
  const phrases = (trend.phrases ?? defaultPhrases(trend.label)).filter((p) => p !== "");
  if (phrases.length === 0) return failed;
  const firstSeenMs = Date.parse(trend.firstSeen);
  const since = Number.isFinite(firstSeenMs) ? firstSeenMs - RADAR_CONFIG.pairLookbackHours * HOUR_MS : null;

  const seen = new Set<string>();
  const live: TracedToken[] = [];
  const lookalikes: Lookalike[] = [];
  for (const phrase of phrases) {
    let pairs: DexPair[];
    try {
      pairs = await deps.dex.search(phrase);
    } catch {
      return failed;
    }
    for (const p of pairs) {
      if (p.chainId !== "solana" || !pairMatches(p, phrase)) continue;
      // Too old to be a clone of this Trend. A pair with no creation time is never too old.
      if (p.pairCreatedAt !== undefined && since !== null && p.pairCreatedAt < since) continue;
      const id = `${p.tokenAddress}|${p.url}|${p.name}|${p.symbol}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (isLiveToken(p)) live.push(traced(p));
      else lookalikes.push({ ...traced(p), reason: lookalikeReason(p) });
    }
  }
  live.sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0));
  const local = deps.localCreates.match(phrases);

  let side: CheckResult["side"];
  const biggest = live[0];
  if (biggest !== undefined) side = (biggest.marketCapUsd ?? 0) >= RADAR_CONFIG.takenCapUsd ? "taken" : "contested";
  else side = local.creators >= RADAR_CONFIG.tokenizingMinCreators ? "tokenizing" : "untokenized";

  return {
    side,
    trace: { at: deps.now.toISOString(), phrases: [...phrases], live: live.slice(0, RADAR_CONFIG.traceLiveMax), lookalikes: lookalikes.slice(0, RADAR_CONFIG.traceLookalikesMax) },
    localCreates: local.creates,
    localCreators: local.creators,
  };
}
