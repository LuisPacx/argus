import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GeckoTerminalClient, type GeckoPool } from "../sources/geckoterminal.ts";
import type { DexPair } from "../sources/dexscreener.ts";
import { JupiterTokensClient, type JupiterToken } from "../sources/jupiter.ts";
import { META_RULE } from "./config.ts";
import { fakeTestFailures, isStockToken, STOCK_NAME_MARKERS, STOCK_TAGS, topDownCandidates, verifyAgainstDex } from "./topdown.ts";

const config = { topDownMinLiquidityUsd: META_RULE.topDownMinLiquidityUsd, topDownMaxCapLiquidityRatio: META_RULE.topDownMaxCapLiquidityRatio, topDownMinVolumeUsd: META_RULE.topDownMinVolumeUsd };
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "../fixtures", name), "utf8");
const GTA6 = "4kjruqGHDsSqkMdFfCjV7Vb62HPFhtXyWc2t6JpQzDnz";
const FAKE_GTA = "EcLbZ6Zc".padEnd(44, "f"); // the fake "GTA VI": $12.07B on $48.3M of liquidity and $2.28 of 24 h volume
const TTWO = "TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo";

const mintOf = (n: number) => `Mint${String(n).padStart(4, "0")}`.padEnd(40, "x");
/** A Jupiter token that passes everything unless `over` says otherwise. */
const jup = (n: number, over: Partial<JupiterToken> = {}): JupiterToken => ({ mint: mintOf(n), name: `Alpha Coin ${n}`, symbol: `AL${n}`, marketCapUsd: 1_000_000, liquidityUsd: 100_000, volume24hUsd: 100_000, tags: [], ...over });
const pool = (n: number, over: Partial<GeckoPool> = {}): GeckoPool => ({ mint: mintOf(n), name: `Alpha Coin ${n}`, symbol: `AL${n}`, marketCapUsd: 1_000_000, liquidityUsd: 100_000, volume24hUsd: 100_000, ...over });
const run = (jupiter: JupiterToken[], gecko: GeckoPool[] = []) => topDownCandidates({ jupiter, gecko, config });
const reasonOf = (r: ReturnType<typeof run>, mint: string) => r.dropped.find((d) => d.mint === mint)?.reason;

describe("topDownCandidates: the two lists of 2026-11-16 (trimmed real fixtures)", () => {
  async function real() {
    const jupiter = await new JupiterTokensClient({ fetchText: async () => fixture("jupiter-toptrending-1h.json") }).topTrending();
    const gecko = await new GeckoTerminalClient({ fetchText: async () => fixture("geckoterminal-trending-pools.json") }).trendingPools();
    return { jupiter, gecko };
  }

  it("the real GTA VI (cap about $7.3M, liquidity $271k, volume over $1M, on both lists) is one candidate with both sources and both ranks", async () => {
    const { jupiter, gecko } = await real();
    const out = topDownCandidates({ jupiter, gecko, config });
    const gta = out.candidates.filter((c) => c.mint === GTA6);
    expect(gta).toHaveLength(1);
    expect(gta[0]).toMatchObject({ name: "GTA VI", symbol: "GTA6", sources: ["jupiter", "geckoterminal"], ranks: { jupiter: 1, geckoterminal: 3 }, createdAt: "2026-08-06T13:35:52.000Z" });
    expect(gta[0]!.marketCapUsd).toBeCloseTo(7_344_795.91, 1); // Jupiter's figure, not GeckoTerminal's FDV
    expect(gta[0]!.liquidityUsd).toBeCloseTo(271_310.39, 1); // the token-level figure, not the one pool's $65k
    expect(gta[0]!.volume24hUsd).toBeGreaterThan(1_000_000);
  });

  it("drops the TTWO stock token and the xStock as stock tokens, though both pass the three tests", async () => {
    const { jupiter, gecko } = await real();
    const out = topDownCandidates({ jupiter, gecko, config });
    expect(out.dropped.find((d) => d.mint === TTWO)).toMatchObject({ symbol: "TTWO", reason: "stock token", sources: ["jupiter"] });
    expect(out.dropped.find((d) => d.symbol === "NVDAx")?.reason).toBe("stock token");
    expect(fakeTestFailures({ marketCapUsd: 4_821_459, liquidityUsd: 3_357_509, volume24hUsd: 54_465_394 }, config)).toEqual([]);
    expect(out.candidates.map((c) => c.symbol)).not.toContain("TTWO");
  });

  it("keeps the others in market cap order, highest first, and gives every dropped token a reason", async () => {
    const { jupiter, gecko } = await real();
    const out = topDownCandidates({ jupiter, gecko, config });
    // The $926k "GTA 6 Coin" ($58k liquidity, $14k of volume) is dropped below; Rocco's pool is quoted in the stock token, but Rocco is a memecoin.
    expect(out.candidates.map((c) => c.symbol)).toEqual(["ZEC", "mihao", "GTA6", "GATO", "Rocco"]);
    const caps = out.candidates.map((c) => c.marketCapUsd);
    expect(caps).toEqual(caps.toSorted((a, b) => b - a));
    expect(reasonOf(out, "EaxAUcXxNnVwcqm2BBocbows7D1XVY2Q63V38NEypump")).toMatch(/^fake: 24 h volume \$14,521 under \$50,000$/);
    expect(out.dropped.every((d) => d.reason !== "")).toBe(true);
  });

  it("a pool quoted in the stock token is judged on the base token's own figures: Rocco ($1.16M cap, $115k liquidity, $363k volume) is a Gecko-only candidate", async () => {
    const { jupiter, gecko } = await real();
    const rocco = topDownCandidates({ jupiter, gecko, config }).candidates.find((c) => c.symbol === "Rocco");
    expect(rocco).toMatchObject({ sources: ["geckoterminal"], ranks: { geckoterminal: 4 }, marketCapUsd: 1_163_250.8779399 });
  });
});

describe("topDownCandidates: the fake filter", () => {
  it("drops the fake GTA VI ($12.07B on $48.3M with $2.28 of volume) with a reason that names the cap-to-liquidity ratio", () => {
    const out = run([jup(1, { mint: FAKE_GTA, name: "GTA VI", symbol: "GTA6", marketCapUsd: 12_070_000_000, liquidityUsd: 48_300_000, volume24hUsd: 2.28 })]);
    expect(out.candidates).toEqual([]);
    const reason = reasonOf(out, FAKE_GTA)!;
    expect(reason).toMatch(/^fake: /);
    expect(reason).toContain("cap 250x liquidity");
    expect(reason).toContain("24 h volume $2 under $50,000");
  });

  const edge = (over: Partial<JupiterToken>) => run([jup(1, over)]);

  it("each test fails alone on a token that passes the other two, and passes exactly at its limit", () => {
    // liquidity: $49,999 drops, $50,000 passes
    expect(reasonOf(edge({ liquidityUsd: 49_999, marketCapUsd: 1_000_000 }), mintOf(1))).toBe("fake: liquidity $49,999 under $50,000");
    expect(edge({ liquidityUsd: 50_000, marketCapUsd: 5_000_000 }).candidates).toHaveLength(1);
    // ratio: 101 drops, 100 passes (liquidity and volume fine)
    expect(reasonOf(edge({ liquidityUsd: 100_000, marketCapUsd: 10_100_000 }), mintOf(1))).toBe("fake: cap 101x liquidity (over 100x)");
    expect(edge({ liquidityUsd: 100_000, marketCapUsd: 10_000_000 }).candidates).toHaveLength(1);
    // volume: $49,999 drops, $50,000 passes
    expect(reasonOf(edge({ volume24hUsd: 49_999 }), mintOf(1))).toBe("fake: 24 h volume $49,999 under $50,000");
    expect(edge({ volume24hUsd: 50_000 }).candidates).toHaveLength(1);
  });

  it("a missing liquidity, market cap or volume fails; it never passes by being absent", () => {
    const { liquidityUsd: _l, ...noLiq } = jup(1);
    const { marketCapUsd: _m, ...noCap } = jup(1);
    const { volume24hUsd: _v, ...noVol } = jup(1);
    expect(reasonOf(run([noLiq]), mintOf(1))).toContain("liquidity missing");
    expect(reasonOf(run([noCap]), mintOf(1))).toContain("market cap missing");
    expect(reasonOf(run([noVol]), mintOf(1))).toContain("24 h volume missing");
    for (const zero of [{ liquidityUsd: 0 }, { marketCapUsd: 0 }, { volume24hUsd: 0 }]) expect(edge(zero).candidates, JSON.stringify(zero)).toEqual([]);
    expect(run([noLiq, { ...noCap, mint: mintOf(2) }, { ...noVol, mint: mintOf(3) }]).dropped).toHaveLength(3);
  });

  it("the thresholds are the config's: a stricter config drops what the defaults keep", () => {
    const strict = { ...config, topDownMinLiquidityUsd: 200_000 };
    expect(topDownCandidates({ jupiter: [jup(1)], gecko: [], config: strict }).candidates).toEqual([]);
    expect(topDownCandidates({ jupiter: [jup(1)], gecko: [], config }).candidates).toHaveLength(1);
  });

  it("drops quote tokens (SOL, the dollar coins) and tokens with a generic key", () => {
    const out = run([
      jup(1, { mint: "So11111111111111111111111111111111111111112", name: "Wrapped SOL", symbol: "SOL", marketCapUsd: 70_000_000_000, liquidityUsd: 900_000_000, volume24hUsd: 5_000_000_000 }),
      jup(2, { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", name: "USD Coin", symbol: "USDC" }),
      jup(3, { name: "Cat", symbol: "CAT" }),
      jup(4, { name: "Coin", symbol: "$" }),
      jup(5, { name: "🐸", symbol: "🐸" }),
      jup(6, { name: "Cat", symbol: "CATBUS" }), // one usable key is enough
    ]);
    expect(out.dropped.map((d) => [d.symbol, d.reason])).toEqual(
      expect.arrayContaining([["SOL", "quote token"], ["USDC", "quote token"], ["CAT", "generic name"], ["$", "generic name"], ["🐸", "generic name"]]),
    );
    expect(out.candidates.map((c) => c.symbol)).toEqual(["CATBUS"]);
  });
});

describe("topDownCandidates: the merge per token", () => {
  it("three pools of one mint are one candidate with the summed liquidity and volume, the best rank, and the larger market cap", () => {
    const out = run([], [pool(1, { liquidityUsd: 20_000, volume24hUsd: 20_000, marketCapUsd: 900_000 }), pool(2), pool(1, { liquidityUsd: 20_000, volume24hUsd: 20_000, marketCapUsd: 1_100_000 }), pool(1, { liquidityUsd: 20_000, volume24hUsd: 20_000, marketCapUsd: 1_000_000 })]);
    const c = out.candidates.find((x) => x.mint === mintOf(1))!;
    expect(out.candidates.filter((x) => x.mint === mintOf(1))).toHaveLength(1);
    expect(c).toMatchObject({ liquidityUsd: 60_000, volume24hUsd: 60_000, marketCapUsd: 1_100_000, sources: ["geckoterminal"], ranks: { geckoterminal: 1 } });
    // alone, each of the three pools would have been under $50,000 of liquidity
    expect(run([], [pool(1, { liquidityUsd: 20_000 })]).candidates).toEqual([]);
  });

  it("takes Jupiter's token-level figures first, and the pools' only where Jupiter gave none", () => {
    const out = run([jup(1, { marketCapUsd: 2_000_000, liquidityUsd: 300_000, volume24hUsd: 400_000 }), jup(2, { fdvUsd: 3_000_000 })], [pool(1, { marketCapUsd: 9_000_000, liquidityUsd: 1_000, volume24hUsd: 1_000 }), pool(2, { marketCapUsd: 4_000_000, liquidityUsd: 70_000, volume24hUsd: 80_000 })]);
    expect(out.candidates.find((c) => c.mint === mintOf(1))).toMatchObject({ marketCapUsd: 2_000_000, liquidityUsd: 300_000, volume24hUsd: 400_000, sources: ["jupiter", "geckoterminal"] });
    // no Jupiter market cap: the pools' figure comes before Jupiter's FDV
    const { marketCapUsd: _m, ...noCap } = jup(2, { fdvUsd: 3_000_000 });
    expect(run([noCap], [pool(2, { marketCapUsd: 4_000_000 })]).candidates[0]!.marketCapUsd).toBe(4_000_000);
    expect(run([noCap]).candidates).toHaveLength(1); // only Jupiter's FDV is left
    expect(run([noCap]).candidates[0]!.marketCapUsd).toBe(3_000_000);
  });

  it("a mint twice on one list keeps its first place; Jupiter's name and ticker win; a Gecko-only token keeps Gecko's", () => {
    const out = run([jup(1, { name: "First" }), jup(1, { name: "Second" })], [pool(1, { name: "Pool name" }), pool(2, { name: "Only here", symbol: "ONLY" })]);
    expect(out.candidates.find((c) => c.mint === mintOf(1))).toMatchObject({ name: "First", ranks: { jupiter: 1, geckoterminal: 1 } });
    expect(out.candidates.find((c) => c.mint === mintOf(2))).toMatchObject({ name: "Only here", symbol: "ONLY", sources: ["geckoterminal"], ranks: { geckoterminal: 2 } });
  });

  it("orders by market cap, highest first, and ties by mint, whatever the input order", () => {
    const tokens = [jup(3, { marketCapUsd: 2_000_000 }), jup(1, { marketCapUsd: 5_000_000 }), jup(2, { marketCapUsd: 2_000_000 }), jup(9, { marketCapUsd: 9_000_000 })];
    expect(run(tokens).candidates.map((c) => c.mint)).toEqual([mintOf(9), mintOf(1), mintOf(2), mintOf(3)]);
    expect(run([...tokens].reverse()).candidates.map((c) => c.mint)).toEqual([mintOf(9), mintOf(1), mintOf(2), mintOf(3)]);
  });

  it("returns nothing for two empty lists", () => {
    expect(run([], [])).toEqual({ candidates: [], dropped: [] });
  });
});

describe("isStockToken: what marks a tokenized stock, from the live answers of 2026-11-16", () => {
  it("is a literal list: the Jupiter tags stocks, xstocks, equities and rwa, and the names Backpack Securities and xStock", () => {
    expect(STOCK_TAGS).toEqual(["stocks", "xstocks", "equities", "rwa"]);
    expect(STOCK_NAME_MARKERS).toEqual(["backpack securities", "xstock"]);
  });

  it("recognises the Take-Two, SK Hynix and xStock tokens, by tag or by name", () => {
    expect(isStockToken({ name: "Take-Two Interactive Software - Backpack Securities", symbol: "TTWO", tags: ["stocks", "rwa", "backpack", "token-2022", "verified"] })).toBe(true);
    expect(isStockToken({ name: "SK Hynix - Backpack Securities", symbol: "SKHY", tags: ["backpack", "token-2022", "verified", "stocks", "rwa"] })).toBe(true);
    expect(isStockToken({ name: "NVIDIA xStock", symbol: "NVDAx", tags: ["stocks", "rwa", "equities", "xstocks"] })).toBe(true);
    expect(isStockToken({ name: "Take-Two Interactive Software - Backpack Securities", symbol: "TTWO" })).toBe(true); // GeckoTerminal has no tags: the name is enough
    expect(isStockToken({ name: "McDonald's xStock", symbol: "MCDx" })).toBe(true);
    expect(isStockToken({ name: "Some Name", symbol: "X", tags: ["Stocks"] })).toBe(true);
  });

  it("does not mark memecoins, the GTA VI token or tokens that only share a word", () => {
    expect(isStockToken({ name: "GTA VI", symbol: "GTA6", tags: ["unknown"] })).toBe(false);
    expect(isStockToken({ name: "Zcash", symbol: "ZEC", tags: ["moonshot-verified", "verified"] })).toBe(false);
    expect(isStockToken({ name: "Stock Market Pepe", symbol: "SMP", tags: ["meme", "community", "launchpad"] })).toBe(false);
    expect(isStockToken({ name: "Backpack", symbol: "BP", tags: ["verified", "defi"] })).toBe(false);
    expect(isStockToken({ name: "x".repeat(100_000), symbol: "X" })).toBe(false);
  });
});

describe("verifyAgainstDex: DexScreener's own figures", () => {
  const dexPair = (liquidityUsd: number, marketCapUsd: number | undefined, volume24hUsd: number, over: Partial<DexPair> = {}): DexPair => ({
    chainId: "solana", tokenAddress: GTA6, name: "GTA VI", symbol: "GTA6", url: "", liquidityUsd, volume24hUsd, priceChange24hPct: 0, ...(marketCapUsd !== undefined ? { marketCapUsd } : {}), ...over,
  });

  it("takes the market cap of the deepest pair, never the largest over pairs, and sums liquidity and volume over the pairs", () => {
    const v = verifyAgainstDex([dexPair(1_000, 12_000_000, 500), dexPair(300_000, 7_050_000, 400_000), dexPair(20_000, 7_100_000, 10_000)], config);
    expect(v).toMatchObject({ ok: true, marketCapUsd: 7_050_000, liquidityUsd: 321_000, volume24hUsd: 410_500 });
  });

  it("fails each test with its reason, and a token with no pair or no market cap", () => {
    expect(verifyAgainstDex([], config)).toMatchObject({ ok: false, reason: "no DexScreener pair" });
    expect(verifyAgainstDex([dexPair(300_000, 7_000_000, 20)], config).reason).toBe("24 h volume $20 under $50,000");
    expect(verifyAgainstDex([dexPair(40_000, 7_000_000, 900_000)], config).reason).toContain("liquidity $40,000 under $50,000");
    expect(verifyAgainstDex([dexPair(48_300_000, 12_070_000_000, 2)], config).reason).toContain("cap 250x liquidity");
    expect(verifyAgainstDex([dexPair(300_000, undefined, 900_000)], config).reason).toBe("market cap missing");
    expect(verifyAgainstDex([dexPair(300_000, undefined, 900_000, { fdvUsd: 7_000_000 })], config)).toMatchObject({ ok: true, marketCapUsd: 7_000_000 });
  });

  it("the ratio test reads the larger of DexScreener's liquidity and the list's (live replay 2026-11-16: GTA VI is $7.67M on one $62k pair, but $271k on Jupiter's list)", () => {
    const gta = [dexPair(62_331, 7_670_054, 746_088)];
    expect(verifyAgainstDex(gta, config).reason).toBe("cap 123x liquidity (over 100x)"); // the strict reading refuses the real token
    expect(verifyAgainstDex(gta, config, 271_310)).toMatchObject({ ok: true, marketCapUsd: 7_670_054, liquidityUsd: 62_331 });
    expect(verifyAgainstDex(gta, config, 62_000).ok).toBe(false); // a list that shows no more liquidity does not help
    // the minimums stay DexScreener's own: a deep list figure does not make up for a thin DexScreener pair or no volume
    expect(verifyAgainstDex([dexPair(40_000, 2_000_000, 900_000)], config, 5_000_000).reason).toBe("liquidity $40,000 under $50,000");
    expect(verifyAgainstDex([dexPair(300_000, 7_000_000, 20)], config, 5_000_000).reason).toBe("24 h volume $20 under $50,000");
  });
});
