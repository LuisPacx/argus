import { describe, expect, it } from "vitest";
import { groupTokens, isGenericKey, type GroupableToken } from "./group.ts";

let n = 0;
const tok = (name: string, symbol: string): GroupableToken => ({ mint: `mint${n++}`, name, symbol });
const many = (count: number, name: string, symbol: string): GroupableToken[] => Array.from({ length: count }, () => tok(name, symbol));

/** The 11-11 shapes: two same-name clone clusters, the Misu pair meeting through the ticker, and 40 unrelated names. */
function fixture(): GroupableToken[] {
  return [
    ...many(11, "DeepSeek", "DEEPSEEK"),
    ...many(11, "IShowSpeed", "SPEED"),
    tok("米苏", "MISU"),
    tok("Misu", "Misu"),
    ...Array.from({ length: 40 }, (_, i) => tok(`Unrelated Thing ${i}`, `UT${i}`)),
  ];
}

describe("groupTokens", () => {
  it("groups clone clusters by name, joins the Misu pair through the ticker, and leaves 40 unrelated tokens apart", () => {
    const groups = groupTokens(fixture());
    const sizes = groups.map((g) => [g.label, g.tokens.length]);
    expect(sizes.slice(0, 3)).toEqual([["DeepSeek", 11], ["IShowSpeed", 11], expect.arrayContaining([expect.stringMatching(/^(米苏|Misu)$/), 2])]);
    expect(groups).toHaveLength(2 + 1 + 40);
    expect(groups.filter((g) => g.tokens.length === 1)).toHaveLength(40);
  });

  it("merges through the ticker even when the names differ", () => {
    const groups = groupTokens([tok("woohao", "NIHAO"), tok("NIHAO", "NIHAO"), tok("Ni Hao Cat", "nihao"), tok("咪好", "MIHAO")]);
    expect(groups.map((g) => g.tokens.length)).toEqual([3, 1]);
  });

  it("the label is the group's most frequent name, and the key is the same whichever order the tokens arrive in", () => {
    const base = [...many(3, "Deep Seek", "DS"), ...many(5, "DeepSeek", "DS"), tok("deepseek r1", "DS")];
    const a = groupTokens(base);
    const b = groupTokens([...base].reverse());
    expect(a).toHaveLength(1);
    expect(a[0]!.label).toBe("DeepSeek");
    expect(b[0]!.key).toBe(a[0]!.key);
    expect(b[0]!.label).toBe("DeepSeek");
  });

  it("a generic key ($BTC, coin, ai, the, a single character) does not merge unrelated tokens", () => {
    const tokens = [
      tok("Bitcoin Cash Maxi", "BTC"),
      tok("Bridge To Cash", "$BTC"),
      tok("Alpha Coin", "coin"),
      tok("Beta Coin", "COIN"),
      tok("Gamma", "ai"),
      tok("Delta", "AI"),
      tok("the", "ZZZ1"),
      tok("The", "ZZZ2"),
      tok("X", "Q1"),
      tok("x", "Q2"),
      tok("Eth", "ETH"),
      tok("Ethereal", "eth"),
    ];
    const groups = groupTokens(tokens);
    expect(groups).toHaveLength(tokens.length);
    for (const k of ["btc", "coin", "ai", "the", "x", "eth", "token"]) expect(isGenericKey(k)).toBe(true);
    expect(isGenericKey("deepseek")).toBe(false);
  });

  it("a generic name does not stop the token's specific ticker from merging", () => {
    const groups = groupTokens([tok("Coin", "PEPEKING"), tok("Token", "PEPEKING"), tok("Pepe King", "PEPEKING")]);
    expect(groups).toHaveLength(1);
  });

  it("a key tied to more than maxPartners other keys is a hub and merges nothing", () => {
    const hub = Array.from({ length: 6 }, (_, i) => tok(`Name${i}`, "HUBKEY"));
    expect(groupTokens(hub, { maxPartners: 10 })).toHaveLength(1);
    expect(groupTokens(hub, { maxPartners: 3 })).toHaveLength(6);
  });

  it("tokens with no usable key stay single and never form one group together", () => {
    const groups = groupTokens([tok("", ""), tok("🚀", "$"), tok("", "")]);
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.tokens.length === 1)).toBe(true);
  });

  it("is linear: 20,000 tokens, a third sharing keys, group in well under a second", () => {
    const tokens = Array.from({ length: 20_000 }, (_, i) => tok(i % 3 === 0 ? "Same" + (i % 50) : `Name ${i}`, `T${i}`));
    const t0 = performance.now();
    const groups = groupTokens(tokens);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(groups.length).toBeGreaterThan(13_000);
  });
});
