import { radarKey } from "../radar/key.ts";
import type { Candidate, ReadResult } from "../radar/readers/google-trends.ts";
import type { DexPair } from "../sources/dexscreener.ts";

/** Fixtures for the trend radar's tests (trend radar ticket 01). Test code only; the worker never imports this. */

export const T0 = new Date("2026-11-19T12:00:00.000Z");
/** The time `n` minutes after T0. */
export const at = (n: number): Date => new Date(T0.getTime() + n * 60_000);

/** A Solana pair with a live market by default: $20,000 of liquidity, a $60,000 market cap, created 3 hours before T0. */
export function aPair(over: Partial<DexPair> & { name: string }): DexPair {
  return {
    chainId: "solana",
    tokenAddress: `${over.name.replaceAll(" ", "")}Addr`.padEnd(32, "x"),
    symbol: over.name.replaceAll(" ", "").slice(0, 8).toUpperCase(),
    url: `https://dexscreener.com/solana/${over.name.replaceAll(" ", "-").toLowerCase()}`,
    liquidityUsd: 20_000,
    volume24hUsd: 1_000,
    priceChange24hPct: 0,
    pairCreatedAt: T0.getTime() - 3 * 3_600_000,
    marketCapUsd: 60_000,
    ...over,
  };
}

export function aCandidate(term: string, trafficMin: number, over: Partial<Candidate> = {}): Candidate {
  return { sourceId: "radar:google:US", key: radarKey(term), term, trafficText: `${trafficMin}+`, trafficMin, newsTitle: "", newsUrl: "", at: T0.toISOString(), ...over };
}

export function anOkRead(candidates: Candidate[], sourceId = "radar:google:US"): ReadResult {
  return { sourceId, status: "ok", reason: "", candidates, fetched: true, waitUntil: null };
}
