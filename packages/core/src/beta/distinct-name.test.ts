import { describe, expect, it } from "vitest";
import { checkDistinctName, distinctOrRetryOnce, withinOneEdit } from "./distinct-name.ts";

const GROUP = [
  { name: "GTA VI", symbol: "GTA6" },
  { name: "Grand Theft Auto 6", symbol: "GTAVI" },
  { name: "Rockstar Vice", symbol: "VICE" },
];

describe("checkDistinctName (slice 2)", () => {
  it("accepts a name that shares only a word with the group", () => {
    expect(checkDistinctName({ name: "Vice City Rising", ticker: "VCR" }, GROUP)).toEqual({ ok: true });
  });

  it("rejects an exact name and an exact ticker, naming the token it copies", () => {
    const exact = checkDistinctName({ name: "Rockstar Vice", ticker: "NEWT" }, GROUP);
    expect(exact).toMatchObject({ ok: false, reason: "the name is the same as an existing token's", offending: ["Rockstar Vice"] });
    const ticker = checkDistinctName({ name: "Fresh Name", ticker: "GTA6" }, GROUP);
    expect(ticker).toMatchObject({ ok: false, reason: "the ticker is the same as an existing token's", offending: ["GTA VI"] });
  });

  it("is not fooled by case, $, punctuation, emoji, zero-width characters or full-width forms", () => {
    for (const name of ["gta vi", "$GTA VI", "G.T.A. V.I.", "GTA 🔥 VI", "G​TA V‍I", "ＧＴＡ ＶＩ", "  GTA   VI  "]) {
      expect(checkDistinctName({ name, ticker: "ZZZZ" }, GROUP), name).toMatchObject({ ok: false });
    }
    expect(checkDistinctName({ name: "Fresh", ticker: "$gta-6" }, GROUP)).toMatchObject({ ok: false });
  });

  it("rejects a name one edit away from an existing token, but not two", () => {
    expect(checkDistinctName({ name: "Rockstar Vise", ticker: "ZZZZ" }, GROUP)).toMatchObject({ ok: false, offending: ["Rockstar Vice"] });
    expect(checkDistinctName({ name: "Rockstar Vices", ticker: "ZZZZ" }, GROUP)).toMatchObject({ ok: false });
    expect(checkDistinctName({ name: "Rockstar Vxxe", ticker: "ZZZZ" }, GROUP)).toEqual({ ok: true });
  });

  it("does not let a one-edit match on a very short key reject unrelated names", () => {
    const shortGroup = [{ name: "Cat", symbol: "CAT" }, { name: "Go", symbol: "GO" }];
    expect(checkDistinctName({ name: "Car Club", ticker: "CLUB" }, shortGroup)).toEqual({ ok: true });
    expect(checkDistinctName({ name: "Cart", ticker: "CRT" }, shortGroup)).toEqual({ ok: true });
    expect(checkDistinctName({ name: "cat", ticker: "CRT" }, shortGroup)).toMatchObject({ ok: false });
  });

  it("rejects a name with no letters or digits left", () => {
    expect(checkDistinctName({ name: "🔥🔥🔥", ticker: "FIRE" }, GROUP)).toMatchObject({ ok: false, reason: expect.stringContaining("no letters") });
  });

  it("handles 10,000-character names, RegExp metacharacters and a large group in linear time", () => {
    const big = Array.from({ length: 2_000 }, (_, i) => ({ name: `Token ${i} ${"x".repeat(60)}`, symbol: `T${i}` }));
    const hostile = ["a".repeat(10_000), "(a+)+$".repeat(2_000), "[".repeat(10_000), ".*".repeat(5_000), "\\".repeat(10_000), "🔥".repeat(10_000)];
    const t0 = performance.now();
    for (const name of hostile) checkDistinctName({ name, ticker: name }, big);
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(checkDistinctName({ name: "(a+)+$", ticker: "ZZ" }, [{ name: "(a+)+$", symbol: "Q" }])).toMatchObject({ ok: false, offending: ["(a+)+$"] });
  });

  it("builds no RegExp from a token name", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./distinct-name.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/new\s+RegExp|\bRegExp\(/);
  });
});

describe("withinOneEdit", () => {
  it.each([
    ["abc", "abc", true],
    ["abc", "abd", true],
    ["abc", "ab", true],
    ["ab", "abc", true],
    ["abc", "xbc", true],
    ["abc", "xyc", false],
    ["abc", "a", false],
    ["abcd", "badc", false],
    ["", "a", true],
    ["", "ab", false],
  ])("%s ~ %s is %s", (a, b, expected) => {
    expect(withinOneEdit(a, b)).toBe(expected);
  });
});

describe("distinctOrRetryOnce (slice 2): a rejected output is not repaired by the model", () => {
  const ok = { name: "Vice City Rising", ticker: "VCR" };
  const copy = { name: "rockstar vice", ticker: "NEWT" };

  it("accepts a first answer that is distinct, and asks once", async () => {
    const asked: Array<string[] | undefined> = [];
    const r = await distinctOrRetryOnce(async (avoid) => (asked.push(avoid), ok), GROUP);
    expect(r).toMatchObject({ ok: true, value: ok, attempts: 1 });
    expect(asked).toEqual([undefined]);
  });

  it("goes back once with the offending names listed, and takes a distinct second answer", async () => {
    const asked: Array<string[] | undefined> = [];
    const answers = [copy, ok];
    const r = await distinctOrRetryOnce(async (avoid) => (asked.push(avoid), answers.shift()!), GROUP);
    expect(r).toMatchObject({ ok: true, value: ok, attempts: 2 });
    expect(asked).toEqual([undefined, ["Rockstar Vice"]]);
  });

  it("fails closed after the second copy and never asks a third time", async () => {
    let calls = 0;
    const r = await distinctOrRetryOnce(async () => (calls++, copy), GROUP);
    expect(r).toMatchObject({ ok: false, attempts: 2 });
    expect(calls).toBe(2);
  });

  it("lets a failure of the asking itself (a rate limit, a refusal) propagate instead of retrying", async () => {
    let calls = 0;
    await expect(distinctOrRetryOnce(async () => { calls++; throw new Error("rate limited"); }, GROUP)).rejects.toThrow("rate limited");
    expect(calls).toBe(1);
  });
});
