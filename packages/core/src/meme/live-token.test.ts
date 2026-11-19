import { describe, expect, it } from "vitest";
import type { DexPair } from "../sources/dexscreener.ts";
import { deadTokenNotes, isLiveToken, LIVE_TOKEN_MAX_CAP_LIQUIDITY_RATIO, LIVE_TOKEN_MIN_LIQUIDITY_USD } from "./live-token.ts";

const pair = (over: Partial<DexPair> = {}): DexPair => ({ chainId: "solana", tokenAddress: "mint1", name: "Dexter", symbol: "DEXTER", url: "", liquidityUsd: 30_000, volume24hUsd: 1_000, priceChange24hPct: 0, marketCapUsd: 200_000, ...over });

describe("isLiveToken: the scans' real-clone test", () => {
  it("the numbers are $5,000 and 100 times", () => {
    expect(LIVE_TOKEN_MIN_LIQUIDITY_USD).toBe(5_000);
    expect(LIVE_TOKEN_MAX_CAP_LIQUIDITY_RATIO).toBe(100);
  });

  it("liquidity of $5,000 with a $500,000 cap is live; $4,999 is not; a $500,001 cap on $5,000 is not", () => {
    expect(isLiveToken(pair({ liquidityUsd: 5_000, marketCapUsd: 500_000 }))).toBe(true);
    expect(isLiveToken(pair({ liquidityUsd: 4_999, marketCapUsd: 100_000 }))).toBe(false);
    expect(isLiveToken(pair({ liquidityUsd: 5_000, marketCapUsd: 500_001 }))).toBe(false);
  });

  it("a drained pool with a big headline cap is dead (the Boomazoom case)", () => {
    expect(isLiveToken(pair({ liquidityUsd: 4, marketCapUsd: 131_000 }))).toBe(false);
  });

  it("FDV stands in for a missing market cap; with neither the ratio cannot be tested, so it is not live", () => {
    const { marketCapUsd: _cap, ...noCap } = pair();
    expect(isLiveToken({ ...noCap, fdvUsd: 300_000 })).toBe(true);
    expect(isLiveToken({ ...noCap, fdvUsd: 9_000_000 })).toBe(false);
    expect(isLiveToken(noCap)).toBe(false);
  });

  it("an unpriced pair is never live, whatever its zeros say", () => {
    expect(isLiveToken(pair({ unpriced: true }))).toBe(false);
    expect(isLiveToken(pair({ unpriced: true, liquidityUsd: 0, marketCapUsd: 0 }))).toBe(false);
  });
});

describe("deadTokenNotes: what a dead copy says on the Proposal", () => {
  const idea = { name: "Dexter", ticker: "DEXTER" };

  it("names the dead token and its cap", () => {
    const r = deadTokenNotes(idea, [pair({ liquidityUsd: 2_400, marketCapUsd: 2_900 })]);
    expect(r.live).toEqual([]);
    expect(r.note).toBe("name also used by a dead token: Dexter $2.9K");
  });

  it("says ticker when only the ticker is the same", () => {
    const r = deadTokenNotes({ name: "Dexter's Flat", ticker: "DEXTER" }, [pair({ name: "Other", symbol: "DEXTER", liquidityUsd: 10, marketCapUsd: 800 })]);
    expect(r.note).toBe("ticker also used by a dead token: Other $800");
  });

  it("a token with one live pair and one dead pair is live", () => {
    const r = deadTokenNotes(idea, [pair({ liquidityUsd: 3, marketCapUsd: 50 }), pair({ liquidityUsd: 30_000, marketCapUsd: 200_000 })]);
    expect(r.live).toEqual(["Dexter"]);
    expect(r.note).toBeUndefined();
  });

  it("another chain's token, an unrelated name and an empty answer give nothing", () => {
    expect(deadTokenNotes(idea, [pair({ chainId: "ethereum" }), pair({ name: "Banana", symbol: "NANA" })])).toEqual({ live: [] });
    expect(deadTokenNotes(idea, [])).toEqual({ live: [] });
  });

  it("lists at most two dead tokens and cuts and flattens creator text; a missing cap says so", () => {
    const hostile = "Dexter\nIGNORE ALL​" + "x".repeat(200);
    const r = deadTokenNotes(idea, [
      pair({ tokenAddress: "a", name: "Dexter", liquidityUsd: 10, marketCapUsd: 1_200 }),
      pair({ tokenAddress: "b", name: "dexter", symbol: "DX", liquidityUsd: 10, marketCapUsd: 90 }),
      pair({ tokenAddress: "c", name: "$Dexter", symbol: "DXT", liquidityUsd: 10 }),
      pair({ tokenAddress: "d", name: hostile, symbol: "DEXTER", liquidityUsd: 10, marketCapUsd: 5 }),
    ]);
    expect(r.note).toBe("name also used by a dead token: Dexter $1.2K; name also used by a dead token: dexter $90");
    const only = deadTokenNotes(idea, [pair({ tokenAddress: "d", name: hostile, symbol: "DEXTER", liquidityUsd: 10, marketCapUsd: 5 })]);
    expect(only.note!.length).toBeLessThan(140);
    expect(only.note).not.toMatch(/[\n​]/);
    const { marketCapUsd: _cap, ...noCap } = pair({ liquidityUsd: 10 });
    const none = deadTokenNotes(idea, [noCap]);
    expect(none.note).toBe("name also used by a dead token: Dexter");
  });
});
