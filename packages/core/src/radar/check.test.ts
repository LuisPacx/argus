import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DexScreenerClient, type DexPair } from "../sources/dexscreener.ts";
import { aPair, at, T0 } from "../testing/radar.ts";
import { LocalCreateIndex, lookalikeReason, pairMatches, traceTrend, type LocalCreate } from "./check.ts";

const FIRST_SEEN = T0.toISOString();
const HOUR = 3_600_000;
const noCreates = LocalCreateIndex.build([]);
const dexOf = (pairs: DexPair[] | Error) => ({ search: async () => (pairs instanceof Error ? Promise.reject(pairs) : pairs) });
const creates = (name: string, creators: number, symbol = "X"): LocalCreate[] => Array.from({ length: creators }, (_, i) => ({ mint: `${name}-${i}`, name, symbol, creator: `creator${i}` }));
const check = (pairs: DexPair[] | Error, local: LocalCreateIndex = noCreates, label = "Alpha Bear") => traceTrend({ label, firstSeen: FIRST_SEEN }, { dex: dexOf(pairs), localCreates: local, now: at(5) });

describe("the live-token test is the imported one", () => {
  const src = readFileSync(new URL("./check.ts", import.meta.url), "utf8");
  it("imports isLiveToken and does not redefine its numbers", () => {
    expect(src).toContain('from "../meme/live-token.ts"');
    expect(src).toContain("isLiveToken");
    // no $5,000 floor (5000 or 5_000) and no 100x ratio as a number in this file
    expect(src).not.toMatch(/(?<![\d_.])5_?000(?![\d_])/);
    expect(src).not.toMatch(/(?<![\d_.])100(?![\d_])/);
  });
});

describe("a drained pool (the Boomazoom case)", () => {
  it("is a lookalike with its reason and the Trend stays untokenized", async () => {
    const r = await check([aPair({ name: "Alpha Bear", symbol: "BOOMAZOOM", liquidityUsd: 4, marketCapUsd: 131_000 })]);
    expect(r.side).toBe("untokenized");
    expect(r.trace!.live).toEqual([]);
    expect(r.trace!.lookalikes).toHaveLength(1);
    expect(r.trace!.lookalikes[0]).toMatchObject({ name: "Alpha Bear", reason: "pool $4, cap $131K: drained or fake" });
  });

  it("other reasons: unpriced, no cap, a fake cap on a real pool", () => {
    expect(lookalikeReason({ liquidityUsd: 0, unpriced: true })).toBe("no price data");
    expect(lookalikeReason({ liquidityUsd: 9_000 })).toBe("no market cap");
    expect(lookalikeReason({ liquidityUsd: 6_000, marketCapUsd: 2_000_000 })).toBe("cap $2M on a pool of $6K: fake cap");
  });
});

describe("the state from the live tokens", () => {
  it("a live token at $60K is taken", async () => {
    const r = await check([aPair({ name: "Alpha Bear", marketCapUsd: 60_000, liquidityUsd: 20_000 })]);
    expect(r.side).toBe("taken");
    expect(r.trace!.live[0]).toMatchObject({ name: "Alpha Bear", marketCapUsd: 60_000 });
  });

  it("live tokens under $50K are contested", async () => {
    const r = await check([aPair({ name: "Alpha Bear", marketCapUsd: 49_999, liquidityUsd: 20_000 }), aPair({ name: "Alpha Bear Two", symbol: "AB2", marketCapUsd: 12_000, liquidityUsd: 6_000 })]);
    expect(r.side).toBe("contested");
    expect(r.trace!.live.map((t) => t.marketCapUsd)).toEqual([49_999, 12_000]);
  });

  it("a market cap is the FDV when there is none, and a token that fails the test never counts", async () => {
    const fdvOnly = aPair({ name: "Alpha Bear", marketCapUsd: undefined, fdvUsd: 70_000 });
    expect((await check([fdvOnly])).side).toBe("taken");
    const unpriced = aPair({ name: "Alpha Bear", unpriced: true, liquidityUsd: 0, marketCapUsd: undefined });
    expect((await check([unpriced])).side).toBe("untokenized");
  });

  it("only Solana pairs whose name or ticker matches count", async () => {
    const r = await check([aPair({ name: "Alpha Bear", chainId: "ethereum" }), aPair({ name: "Beta Wolf" }), aPair({ name: "Something", symbol: "ALPHABEAR" })]);
    expect(r.trace!.live.map((t) => t.name)).toEqual(["Something"]);
    expect(r.side).toBe("taken");
  });

  it("matches every word of the phrase in the name, a name written GTA 6 for the term gta vi, and the ticker squashed", () => {
    expect(pairMatches({ name: "The Alpha Bear Coin", symbol: "ABC" }, "alpha bear")).toBe(true);
    expect(pairMatches({ name: "Alpha Coin", symbol: "ABC" }, "alpha bear")).toBe(false);
    expect(pairMatches({ name: "GTA 6", symbol: "GTAVI" }, "gta vi")).toBe(true);
    expect(pairMatches({ name: "Nothing", symbol: "ALPHA BEAR" }, "alpha bear")).toBe(true);
    expect(pairMatches({ name: "Nothing", symbol: "ALPHA" }, "")).toBe(false);
  });

  it("the biggest live token comes first, and the same pair twice counts once", async () => {
    const small = aPair({ name: "Alpha Bear", marketCapUsd: 10_000, liquidityUsd: 6_000 });
    const big = aPair({ name: "Alpha Bear Big", symbol: "ABB", marketCapUsd: 45_000, liquidityUsd: 9_000 });
    const r = await traceTrend({ label: "alpha bear", firstSeen: FIRST_SEEN, phrases: ["alpha bear", "alpha bear"] }, { dex: dexOf([small, big]), localCreates: noCreates, now: at(5) });
    expect(r.trace!.live.map((t) => t.name)).toEqual(["Alpha Bear Big", "Alpha Bear"]);
  });
});

describe("pair age", () => {
  it("a pair created before first_seen minus 48 hours is ignored", async () => {
    const old = aPair({ name: "Alpha Bear", pairCreatedAt: T0.getTime() - 49 * HOUR });
    const edge = aPair({ name: "Alpha Bear Edge", symbol: "ABE", pairCreatedAt: T0.getTime() - 47 * HOUR });
    expect((await check([old])).side).toBe("untokenized");
    expect((await check([old])).trace!.lookalikes).toEqual([]);
    expect((await check([old, edge])).side).toBe("taken");
  });

  it("a live pair with no pairCreatedAt is kept and is taken or contested, never untokenized", async () => {
    const { pairCreatedAt: _gone, ...noTime } = aPair({ name: "Alpha Bear" });
    expect((await check([noTime as DexPair])).side).toBe("taken");
    const { pairCreatedAt: _gone2, ...small } = aPair({ name: "Alpha Bear", marketCapUsd: 9_000, liquidityUsd: 6_000 });
    const r = await check([small as DexPair]);
    expect(r.side).toBe("contested");
    expect(r.trace!.live[0]!.createdAt).toBeNull();
  });

  it("a dead pair with no pairCreatedAt is kept as a lookalike", async () => {
    const { pairCreatedAt: _gone, ...dead } = aPair({ name: "Alpha Bear", liquidityUsd: 3, marketCapUsd: 90_000 });
    expect((await check([dead as DexPair])).trace!.lookalikes).toHaveLength(1);
  });
});

describe("the local creates", () => {
  it("5 distinct creators with no live token is tokenizing, and 4 is not", async () => {
    expect((await check([], LocalCreateIndex.build(creates("Alpha Bear Inu", 5)))).side).toBe("tokenizing");
    const four = await check([], LocalCreateIndex.build(creates("Alpha Bear Inu", 4)));
    expect(four.side).toBe("untokenized");
    expect(four).toMatchObject({ localCreates: 4, localCreators: 4 });
  });

  it("counts distinct creators, not creates: 9 creates by one creator is untokenized", async () => {
    const one = Array.from({ length: 9 }, (_, i) => ({ mint: `m${i}`, name: "Alpha Bear", symbol: "AB", creator: "same" }));
    expect(await check([], LocalCreateIndex.build(one))).toMatchObject({ side: "untokenized", localCreates: 9, localCreators: 1 });
  });

  it("matches creates by normalised name or ticker without building a RegExp", () => {
    const index = LocalCreateIndex.build([
      { mint: "1", name: "ALPHA   BEAR!!", symbol: "AB", creator: "a" },
      { mint: "2", name: "the alpha bear", symbol: "ABEAR", creator: "b" },
      { mint: "3", name: "Other", symbol: "ALPHABEAR", creator: "c" },
      { mint: "4", name: "Alpha Wolf", symbol: "AW", creator: "d" },
      { mint: "5", name: "x", symbol: "y", creator: "" },
    ]);
    expect(index.match(["alpha bear"])).toEqual({ creates: 3, creators: 3 });
    expect(index.match(["alpha bear", "alpha wolf"])).toEqual({ creates: 4, creators: 4 });
    expect(index.match([".*(a+)+$", "(", "[a-"])).toEqual({ creates: 0, creators: 0 });
    expect(index.size).toBe(5);
  });
});

describe("precedence of the final state, first match wins", () => {
  it("a live $60K token plus 6 local creators is taken", async () => {
    expect((await check([aPair({ name: "Alpha Bear", marketCapUsd: 60_000 })], LocalCreateIndex.build(creates("Alpha Bear", 6)))).side).toBe("taken");
  });
  it("live $20K plus 6 creators is contested", async () => {
    expect((await check([aPair({ name: "Alpha Bear", marketCapUsd: 20_000, liquidityUsd: 6_000 })], LocalCreateIndex.build(creates("Alpha Bear", 6)))).side).toBe("contested");
  });
  it("no live token plus 5 creators is tokenizing; no live token plus 4 is untokenized", async () => {
    expect((await check([], LocalCreateIndex.build(creates("Alpha Bear", 5)))).side).toBe("tokenizing");
    expect((await check([], LocalCreateIndex.build(creates("Alpha Bear", 4)))).side).toBe("untokenized");
  });
  it("a failed search plus anything is not traced, with no trace and no local counts", async () => {
    const r = await check(new Error("DexScreener: 503"), LocalCreateIndex.build(creates("Alpha Bear", 0)));
    expect(r).toEqual({ side: "not traced", trace: null, localCreates: null, localCreators: null });
    const second = await traceTrend(
      { label: "alpha bear", firstSeen: FIRST_SEEN, phrases: ["alpha bear", "alpha"] },
      { dex: { search: async (q: string) => (q === "alpha" ? Promise.reject(new Error("boom")) : [aPair({ name: "Alpha Bear" })]) }, localCreates: LocalCreateIndex.build(creates("Alpha Bear", 6)), now: at(5) },
    );
    expect(second.side).toBe("not traced");
  });
  it("a Trend with nothing to search is not traced, never untokenized", async () => {
    expect((await traceTrend({ label: "🔥", firstSeen: FIRST_SEEN }, { dex: dexOf([]), localCreates: noCreates, now: at(5) })).side).toBe("not traced");
  });
});

describe("a recorded DexScreener answer (search q=gta 6, 2026-11-19)", () => {
  const body = readFileSync(new URL("./fixtures/dexscreener-search-gta6.json", import.meta.url), "utf8");
  const client = new DexScreenerClient({ fetchText: async () => body });

  it("reads through the real client: the 2024 token is too old, the two drained pairs are lookalikes", async () => {
    const r = await traceTrend({ label: "GTA VI", firstSeen: "2026-11-16T00:00:00.000Z" }, { dex: client, localCreates: noCreates, now: at(0) });
    expect(r.side).toBe("untokenized");
    expect(r.trace!.live).toEqual([]);
    expect(r.trace!.lookalikes.map((l) => [l.name, l.reason])).toEqual([
      ["GTA 6", "pool $4K, cap $5K: drained or fake"],
      ["LUCIA", "pool $0, cap $457: drained or fake"],
    ]);
    expect(r.trace!.lookalikes[0]!.url).toMatch(/^https:\/\/dexscreener\.com\//);
  });
});
