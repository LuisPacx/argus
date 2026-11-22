import { describe, expect, it } from "vitest";
import type { DexPair } from "../sources/dexscreener.ts";
import type { MigratedToken } from "../study/store.ts";
import { RESEARCH_CANDIDATES_MAX } from "./brief.ts";
import { matchLocal, mergeCandidates, termMatches } from "./widen.ts";

/** Valid base58 and ending in `pump`, so the bonded rule can read a graduation pool for it. */
const CA = (n: number) => `${String(n % 9 + 1).repeat(30)}${String(n).padStart(6, "7")}pump`;
const token = (n: number, name: string, over: Partial<MigratedToken> = {}): MigratedToken => ({ mint: CA(n), name, symbol: name.slice(0, 4).toUpperCase(), migratedAt: "2026-11-20T00:00:00.000Z", description: "", ...over });
const pair = (n: number, over: Partial<DexPair> = {}): DexPair => ({ chainId: "solana", tokenAddress: CA(n), name: `Coin ${n}`, symbol: `COIN${n}`, url: "", dexId: "pumpfun", liquidityUsd: 20_000, volume24hUsd: 1, priceChange24hPct: 0, marketCapUsd: 100_000, pairCreatedAt: 0, ...over });
const noMigration = () => null;

describe("termMatches", () => {
  it("is case-insensitive, and a term of 4 or more characters matches anywhere in the text", () => {
    expect(termMatches("xmas", "Merry-XMAS-Cat")).toBe(true);
    expect(termMatches("XMAS", "supertxmasdoge")).toBe(true);
    expect(termMatches("santa", "SANTA INU")).toBe(true);
    expect(termMatches("santa", "Sant a")).toBe(false);
  });

  it("collapses runs of whitespace on both sides", () => {
    expect(termMatches("santa  claus", "Santa   Claus Coin")).toBe(true);
  });

  it("a term under 4 characters matches only at the start of a word, or at the end of a word that has at least 4 more characters before it (a blend such as CATEMAS, not a name such as Thomas)", () => {
    expect(termMatches("mas", "CATEMAS")).toBe(true);
    expect(termMatches("mas", "BOSSMAS")).toBe(true);
    expect(termMatches("mas", "Bullmas")).toBe(true);
    expect(termMatches("mas", "Thomas")).toBe(false);
    expect(termMatches("mas", "Thomas Edison")).toBe(false);
    expect(termMatches("mas", "Xmas")).toBe(false);
    expect(termMatches("mas", "mas")).toBe(true);
    expect(termMatches("mas", "the MAS coin")).toBe(true);
    expect(termMatches("mas", "Masked")).toBe(true);
    expect(termMatches("gta", "GTA6")).toBe(true);
    expect(termMatches("gta", "Gta VI")).toBe(true);
    expect(termMatches("mas", "Gamasutra")).toBe(false);
    expect(termMatches("mas", "Eliasmasterson")).toBe(false);
  });

  it("an empty or blank term matches nothing", () => {
    expect(termMatches("", "anything")).toBe(false);
    expect(termMatches("   ", "anything")).toBe(false);
  });
});

describe("matchLocal", () => {
  const set = [token(1, "CATEMAS"), token(2, "BOSSMAS"), token(3, "Santa Inu"), token(4, "Thomas"), token(5, "Pepe")];

  it("finds CATEMAS, BOSSMAS and Santa Inu for xmas, santa and mas, each with the term it matched, and not Thomas or Pepe", () => {
    const found = matchLocal(["xmas", "santa", "mas"], set);
    expect(found.map((m) => [m.token.name, m.via])).toEqual([["CATEMAS", "mas"], ["BOSSMAS", "mas"], ["Santa Inu", "santa"]]);
  });

  it("the first term in the list that matches is the `via`, and the order of the tokens is kept", () => {
    expect(matchLocal(["mas", "santa"], [token(1, "Santa Mas"), token(2, "BOSSMAS")]).map((m) => [m.token.name, m.via])).toEqual([["Santa Mas", "mas"], ["BOSSMAS", "mas"]]);
    expect(matchLocal(["santa", "mas"], [token(1, "Santa Mas")]).map((m) => m.via)).toEqual(["santa"]);
  });

  it("covers the name, the ticker and the description, case-insensitively", () => {
    const found = matchLocal(["santa"], [token(1, "Plain", { symbol: "SANTA" }), token(2, "Plain", { description: "A dog in a Santa hat" }), token(3, "SaNtA Dog"), token(4, "Plain")]);
    expect(found.map((m) => m.token.mint)).toEqual([CA(1), CA(2), CA(3)]);
  });

  it("a term under 4 characters is looked for in the name and the ticker only, never the description; a longer term still reads the description", () => {
    const t = token(1, "Plain", { symbol: "PLN", description: "the master of massive things, a santa hat" });
    expect(matchLocal(["mas"], [t])).toEqual([]);
    expect(matchLocal(["mas"], [token(2, "CATEMAS", { description: "" }), token(3, "Plain", { symbol: "BOSSMAS" })]).map((m) => m.token.mint)).toEqual([CA(2), CA(3)]);
    expect(matchLocal(["santa", "mas"], [t]).map((m) => m.via)).toEqual(["santa"]);
  });

  it("a word is never read across two fields: the end of the name and the start of the ticker do not join", () => {
    expect(matchLocal(["santa"], [token(1, "San", { symbol: "TA" })])).toEqual([]);
  });

  it("ignores blank terms, finds nothing without terms, and each token is listed once", () => {
    expect(matchLocal([], set)).toEqual([]);
    expect(matchLocal(["", "  "], set)).toEqual([]);
    expect(matchLocal(["cate", "mas", "catemas"], [token(1, "CATEMAS")])).toHaveLength(1);
  });

  it("stays quick with 15 terms over a week of migrations (20,000 tokens with a long description each)", () => {
    const terms = ["xmas", "santa", "mas", "noel", "elf", "reindeer", "yule", "tinsel", "grinch", "snowman", "mistletoe", "santa claus", "ho ho", "carol", "sleigh"];
    const big = Array.from({ length: 20_000 }, (_v, i) => token(i, `Coin ${i} the ${i % 7 === 0 ? "Elf" : "Dog"}`, { description: `A coin about a very ordinary thing number ${i}. `.repeat(20) }));
    const started = performance.now();
    const found = matchLocal(terms, big);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(found).toHaveLength(Math.ceil(20_000 / 7));
    expect(new Set(found.map((m) => m.via))).toEqual(new Set(["elf"]));
  });
});

describe("mergeCandidates", () => {
  const merge = (literal: DexPair[], extras: { pair: DexPair; via: string }[], migratedAt: (ca: string) => string | null = noMigration) => mergeCandidates({ topic: "christmas", literal, extras, migratedAt });

  it("keeps a literal hit that is not bonded, and drops an extra that is not bonded", () => {
    const out = merge([pair(1)], [{ pair: pair(2), via: "xmas" }]);
    expect(out.map((c) => [c.pair.tokenAddress, c.bonded, c.via])).toEqual([[CA(1), false, "christmas"]]);
  });

  it("keeps an extra with a local migration, and an extra on a graduation venue with at least $5K liquidity, not one with less", () => {
    const extras = [
      { pair: pair(2), via: "xmas" },
      { pair: pair(3, { dexId: "pumpswap", liquidityUsd: 5_000 }), via: "santa" },
      { pair: pair(4, { dexId: "pumpswap", liquidityUsd: 4_999 }), via: "santa" },
      { pair: pair(5, { dexId: "orca", liquidityUsd: 90_000 }), via: "santa" },
      { pair: { ...pair(6, { dexId: "pumpswap", liquidityUsd: 90_000 }), tokenAddress: `${"6".repeat(40)}` }, via: "santa" },
    ];
    const out = merge([], extras, (ca) => (ca === CA(2) ? "2026-11-20T00:00:00.000Z" : null));
    expect(out.map((c) => [c.pair.tokenAddress, c.bonded, c.via]).sort()).toEqual([[CA(2), true, "xmas"], [CA(3), true, "santa"]].sort());
  });

  it("a literal hit that a graduation pool or a migration shows as bonded is marked bonded", () => {
    const out = merge([pair(1, { dexId: "raydium", liquidityUsd: 9_000 }), pair(2), pair(3)], [], (ca) => (ca === CA(3) ? "2026-11-20T00:00:00.000Z" : null));
    expect(out.map((c) => [c.pair.tokenAddress, c.bonded])).toEqual([[CA(3), true], [CA(1), true], [CA(2), false]]); // equal caps: the deeper pool first
  });

  it("orders bonded first, then market cap (unknown last), then liquidity", () => {
    const m = () => "2026-11-20T00:00:00.000Z";
    const lits = [
      pair(1, { marketCapUsd: 900_000 }), // literal, not bonded: after every bonded coin
      pair(2, { marketCapUsd: undefined, liquidityUsd: 1 }),
    ];
    const extras = [
      { pair: pair(3, { marketCapUsd: 50_000, liquidityUsd: 1_000 }), via: "a" },
      { pair: pair(4, { marketCapUsd: 50_000, liquidityUsd: 8_000 }), via: "a" },
      { pair: pair(5, { marketCapUsd: 70_000 }), via: "a" },
      { pair: pair(6, { marketCapUsd: undefined, fdvUsd: undefined, liquidityUsd: 99_000 }), via: "a" },
    ];
    const out = mergeCandidates({ topic: "t", literal: lits, extras, migratedAt: (ca) => (lits.some((l) => l.tokenAddress === ca) ? null : m()) });
    expect(out.map((c) => c.pair.tokenAddress)).toEqual([CA(5), CA(4), CA(3), CA(6), CA(1), CA(2)]);
    expect(out.map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6"]);
  });

  it("is capped at 25, keeps the best, and one coin appears once, with its deepest pair and the literal `via` when both sources found it", () => {
    const bonded = () => "2026-11-20T00:00:00.000Z";
    const extras = Array.from({ length: 40 }, (_v, i) => ({ pair: pair(100 + i, { marketCapUsd: 1_000 * (i + 1) }), via: "xmas" }));
    const out = mergeCandidates({ topic: "christmas", literal: [pair(1, { marketCapUsd: 5 })], extras, migratedAt: bonded });
    expect(RESEARCH_CANDIDATES_MAX).toBe(25);
    expect(out).toHaveLength(25);
    expect(out[0]!.pair.marketCapUsd).toBe(40_000);
    expect(new Set(out.map((c) => c.pair.tokenAddress)).size).toBe(25);

    const both = mergeCandidates({
      topic: "christmas",
      literal: [pair(1, { marketCapUsd: 10, liquidityUsd: 100 }), pair(1, { marketCapUsd: 20, liquidityUsd: 900 })],
      extras: [{ pair: pair(1, { marketCapUsd: 999, liquidityUsd: 5 }), via: "xmas" }],
      migratedAt: noMigration,
    });
    expect(both).toHaveLength(1);
    expect(both[0]).toMatchObject({ via: "christmas", pair: { liquidityUsd: 900 } });
  });

  it("reserves slots for the best literal hits: 3 literal hits and 40 bonded extras leave all 3 literal hits in the 25, shown after the bonded coins", () => {
    const extras = Array.from({ length: 40 }, (_v, i) => ({ pair: pair(100 + i, { marketCapUsd: 1_000_000 + i }), via: "xmas" }));
    const lits = [pair(1, { marketCapUsd: 5 }), pair(2, { marketCapUsd: 7 }), pair(3, { marketCapUsd: 6 })];
    const out = mergeCandidates({ topic: "christmas", literal: lits, extras, migratedAt: (ca) => (lits.some((l) => l.tokenAddress === ca) ? null : "2026-11-20T00:00:00.000Z") });
    expect(out).toHaveLength(25);
    expect(out.slice(0, 22).every((c) => c.bonded === true && c.via === "xmas")).toBe(true);
    expect(out.slice(22).map((c) => c.pair.tokenAddress)).toEqual([CA(2), CA(3), CA(1)]);
  });

  it("reserves at most 5 literal slots, the 5 biggest caps; the rest of the 25 go to the best of everything else", () => {
    const lits = Array.from({ length: 8 }, (_v, i) => pair(1 + i, { marketCapUsd: 10 * (i + 1) }));
    const extras = Array.from({ length: 40 }, (_v, i) => ({ pair: pair(100 + i, { marketCapUsd: 1_000_000 + i }), via: "xmas" }));
    const out = mergeCandidates({ topic: "t", literal: lits, extras, migratedAt: (ca) => (lits.some((l) => l.tokenAddress === ca) ? null : "2026-11-20T00:00:00.000Z") });
    const literalKept = out.filter((c) => c.via === "t").map((c) => c.pair.tokenAddress);
    expect(out).toHaveLength(25);
    expect(literalKept).toEqual([CA(8), CA(7), CA(6), CA(5), CA(4)]);
    expect(out.filter((c) => c.via === "xmas")).toHaveLength(20);
  });

  it("says `unknown` (null), not `not bonded`, when there is no basis: not a launchpad mint, or a pair that names no venue", () => {
    const plain = (n: number, over: Partial<DexPair> = {}) => pair(n, { tokenAddress: `${String(n)}`.repeat(40), ...over });
    const out = merge([plain(1), plain(2, { dexId: undefined }), pair(3, { dexId: undefined }), pair(4)], []);
    const state = (ca: string) => out.find((c) => c.pair.tokenAddress === ca)!.bonded;
    expect(state("1".repeat(40))).toBeNull();
    expect(state("2".repeat(40))).toBeNull();
    expect(state(CA(3))).toBeNull();
    expect(state(CA(4))).toBe(false);
  });

  it("only offers Solana coins with a price and a plain address, and caps the literal hits at 15 before the extras join", () => {
    const lits = [pair(1, { chainId: "base" }), pair(2, { unpriced: true }), ...Array.from({ length: 20 }, (_v, i) => pair(10 + i, { marketCapUsd: 1_000 * (i + 1) }))];
    const out = merge(lits, []);
    expect(out).toHaveLength(15);
    expect(out.some((c) => c.pair.chainId !== "solana" || c.pair.unpriced === true)).toBe(false);
  });

  it("an extra that groups several pairs of one coin is judged on all of them (a graduation pool beside the curve pair)", () => {
    const out = merge([], [
      { pair: pair(2, { dexId: "pumpfun", liquidityUsd: 100 }), via: "xmas" },
      { pair: pair(2, { dexId: "pumpswap", liquidityUsd: 12_000 }), via: "xmas" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ bonded: true, via: "xmas", pair: { dexId: "pumpswap" } });
  });
});
