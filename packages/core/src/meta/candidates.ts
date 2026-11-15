import { marketCapFromSummary } from "../sources/dexscreener.ts";
import { cleanLabel } from "./group.ts";

/**
 * Leader candidates from the `dexscreener:trending` Signals (Meta redesign ticket 01): tokens of any age that DexScreener's boost feed
 * named. A Signal is stored once (`INSERT OR IGNORE`), so it says "this token was trending when first seen", never its market cap now:
 * the figure on it only orders the lookups. Names are written by token creators and are cleaned and cut like every other label.
 */

export const TRENDING_SOURCE_ID = "dexscreener:trending";
const ID_PREFIX = `${TRENDING_SOURCE_ID}:solana:`;
const MINT = /^[A-Za-z0-9]{20,66}$/;

export interface TrendingCandidate {
  mint: string;
  name: string;
  symbol: string;
  /** The market cap on the Signal when it was first seen, if it had one. */
  storedCapUsd?: number;
  /** When the pair was created (the Signal's published time), when known. */
  createdAt?: string;
}

/** A stored `dexscreener:trending` Signal as the candidate reader needs it. */
export interface TrendingSignalRow {
  id: string;
  title: string;
  summary: string;
  publishedAt: string;
}

/** `Name ($SYMBOL)` back into its two parts; a title with no ticker is a name alone. */
function splitTitle(title: string): { name: string; symbol: string } {
  const at = title.lastIndexOf(" ($");
  if (at > 0 && title.endsWith(")")) return { name: cleanLabel(title.slice(0, at)), symbol: cleanLabel(title.slice(at + 3, -1)) };
  return { name: cleanLabel(title), symbol: "" };
}

/** One Signal as a candidate, or undefined when it is not a Solana trending Signal or its mint is not a plain address. */
export function trendingCandidate(row: TrendingSignalRow): TrendingCandidate | undefined {
  if (!row.id.startsWith(ID_PREFIX)) return undefined;
  const mint = row.id.slice(ID_PREFIX.length);
  if (!MINT.test(mint)) return undefined;
  const { name, symbol } = splitTitle(row.title);
  if (name === "" && symbol === "") return undefined;
  const cap = marketCapFromSummary(row.summary);
  const published = Date.parse(row.publishedAt);
  return {
    mint,
    name,
    symbol,
    ...(cap !== undefined ? { storedCapUsd: cap } : {}),
    ...(Number.isFinite(published) && published > 0 ? { createdAt: new Date(published).toISOString() } : {}),
  };
}

/** Distinct candidates of these Signals, in the order given. */
export function trendingCandidates(rows: readonly TrendingSignalRow[]): TrendingCandidate[] {
  const seen = new Set<string>();
  const out: TrendingCandidate[] = [];
  for (const row of rows) {
    const c = trendingCandidate(row);
    if (c && !seen.has(c.mint)) {
      seen.add(c.mint);
      out.push(c);
    }
  }
  return out;
}
