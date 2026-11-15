import { describe, expect, it } from "vitest";
import { trendingCandidate, trendingCandidates } from "./candidates.ts";

const JENSEN = "B2YpPJensen111111111111111111111111111pump";
const row = (over: Partial<Parameters<typeof trendingCandidate>[0]> = {}) => ({
  id: `dexscreener:trending:solana:${JENSEN}`,
  title: "Jensen Huang ($JENSEN)",
  summary: "Boosted on DexScreener. liquidity $5,000, market cap $96,000.",
  publishedAt: "2026-11-14T10:00:00.000Z",
  ...over,
});

describe("trendingCandidate", () => {
  it("reads the mint from the id, the name and ticker from the title and the stored cap from the summary", () => {
    expect(trendingCandidate(row())).toEqual({ mint: JENSEN, name: "Jensen Huang", symbol: "JENSEN", storedCapUsd: 96_000, createdAt: "2026-11-14T10:00:00.000Z" });
  });

  it("a title with no ticker is a name alone; a summary with no figure adds none; an unset publish time adds no createdAt", () => {
    const c = trendingCandidate(row({ title: "Stand with Jensen", summary: "Boosted on DexScreener.", publishedAt: "1970-01-01T00:00:00.000Z" }));
    expect(c).toEqual({ mint: JENSEN, name: "Stand with Jensen", symbol: "" });
  });

  it("refuses another Source's Signal, another chain, an unsafe mint and an unnamed token", () => {
    expect(trendingCandidate(row({ id: `dexscreener:trending:ethereum:${JENSEN}` }))).toBeUndefined();
    expect(trendingCandidate(row({ id: `rss:x:${JENSEN}` }))).toBeUndefined();
    expect(trendingCandidate(row({ id: "dexscreener:trending:solana:../../etc" }))).toBeUndefined();
    expect(trendingCandidate(row({ title: " " }))).toBeUndefined();
  });

  it("cleans a hostile name (control characters, length) like every creator-written label", () => {
    const c = trendingCandidate(row({ title: `Bad\u0000‮${"x".repeat(500)} ($T\n)` }));
    expect(c!.name.length).toBeLessThanOrEqual(60);
    expect(c!.name.includes("\u0000") || c!.name.includes("‮")).toBe(false);
    expect(c!.symbol).toBe("T");
  });
});

describe("trendingCandidates", () => {
  it("keeps the first of a repeated mint and the given order", () => {
    const other = "Other11111111111111111111111111111111111pump";
    const out = trendingCandidates([row(), row({ title: "Second ($TWO)" }), row({ id: `dexscreener:trending:solana:${other}`, title: "Other ($OTH)" })]);
    expect(out.map((c) => [c.mint, c.symbol])).toEqual([[JENSEN, "JENSEN"], [other, "OTH"]]);
  });
});
