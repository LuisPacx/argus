import { describe, expect, it } from "vitest";
import { groupTokens, isGenericKey, nameGroup, tokenKeys, type GroupableToken } from "./group.ts";

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

  it("spelling aliases are one clone cluster: gta 6, gta6, gta vi and gtavi; gta 5, gta v and gta iv stay apart", () => {
    const groups = groupTokens([tok("GTA 6", "X1"), tok("Game", "GTA6"), tok("GTA VI", "X2"), tok("Game Two", "GTAVI")]);
    expect(groups).toHaveLength(1);
    const apart = groupTokens([tok("GTA 6", "A1"), tok("GTA 5", "A2"), tok("GTA V", "A3"), tok("GTA IV", "A4")]);
    expect(apart).toHaveLength(4);
    // a word that only looks like a numeral stays what it is
    expect(groupTokens([tok("Taxi", "TA1"), tok("Tax 1", "TA2"), tok("Wifi", "WI1"), tok("Mix", "MX1")])).toHaveLength(4);
  });

  /** One creator minted `Lucia From GTA 6 ($LUCIA)` 44 times; twenty creators each launched one GTA 6 / GTA VI token (the 2026-11-16 shape). */
  const gtaGroup = (): Array<GroupableToken & { creator: string }> => [
    ...Array.from({ length: 44 }, () => ({ ...tok("Lucia From GTA 6", "LUCIA"), creator: "luciaMaker" })),
    ...Array.from({ length: 12 }, (_, i) => ({ ...tok("GTA 6", "GTA6"), creator: `six${i}` })),
    ...Array.from({ length: 8 }, (_, i) => ({ ...tok("GTA VI", "GTA6"), creator: `vi${i}` })),
  ];

  it("names a group by the creators who used the name, not the token count: the 44-token Lucia creator does not name the GTA group", () => {
    // Without the theme merge the Lucia tokens are their own cluster; the creator vote names each cluster by who used it.
    const groups = groupTokens(gtaGroup());
    const gta = groups.find((g) => g.tokens.some((t) => t.name === "GTA 6"))!;
    expect(gta).toMatchObject({ key: "gta6", label: "GTA 6" }); // 12 creators say "GTA 6", 8 say "GTA VI"
    expect(gta.tokens).toHaveLength(20);
    const lucia = groups.find((g) => g.tokens.some((t) => t.name.startsWith("Lucia")))!;
    expect(lucia).toMatchObject({ label: "Lucia From GTA 6" });
  });

  it("spelling aliases vote as one key: creators of gta 6, gta6 and gta vi outvote the creators of plain gta, and the key is the most used spelling of the winner", () => {
    const by = (n: number, prefix: string, name: string, symbol = ""): Array<GroupableToken & { creator: string }> => Array.from({ length: n }, (_, i) => ({ ...tok(name, symbol), creator: `${prefix}${i}` }));
    const tokens = [...by(10, "plain", "GTA"), ...by(5, "sp", "GTA 6"), ...by(6, "nos", "GTA6"), ...by(4, "rom", "GTA VI"), ...by(2, "both", "GTA VI", "GTA6")];
    // 17 creators wrote some spelling of GTA 6 (the two with both spellings count once); 10 wrote plain GTA
    // key: gta6 has 8 creators, gta vi 6, gta 6 5; label: the most used name of that form (GTA6 and GTA VI tie on 6 creators and 6 tokens: the smaller string), not plain GTA
    expect(nameGroup(tokens, tokenKeys)).toMatchObject({ key: "gta6", label: "GTA VI" });
    expect(nameGroup([...tokens].reverse(), tokenKeys).key).toBe("gta6");
    // with fewer GTA 6 creators than plain GTA creators, plain GTA wins
    expect(nameGroup([...by(10, "plain", "GTA"), ...by(4, "sp", "GTA 6"), ...by(3, "nos", "GTA6")], tokenKeys).key).toBe("gta");
  });

  it("a creator counts once per key and name, however many tokens carry it", () => {
    // One creator, 5 tokens "Alpha"; two creators, 1 token each "Beta": Beta has more creators, Alpha more tokens, and the cluster joins them by a shared ticker.
    const tokens = [...Array.from({ length: 5 }, () => ({ ...tok("Alpha", "SAME"), creator: "one" })), { ...tok("Beta", "SAME"), creator: "two" }, { ...tok("Beta", "SAME"), creator: "three" }];
    expect(groupTokens(tokens)[0]).toMatchObject({ label: "Beta" });
  });

  it("a tie in creators goes to more tokens, then the smaller string, and never to input order", () => {
    const a = { ...tok("Alpha", "SAME"), creator: "x" };
    const a2 = { ...tok("Alpha", "SAME"), creator: "x" };
    const b = { ...tok("Beta", "SAME"), creator: "y" };
    // one creator each: Alpha has 2 tokens, Beta 1 -> Alpha
    expect(groupTokens([a, a2, b])[0]!.label).toBe("Alpha");
    expect(groupTokens([b, a2, a])[0]!.label).toBe("Alpha");
    // equal creators and tokens -> the smaller string
    const c = { ...tok("Zed", "SAME2"), creator: "p" };
    const d = { ...tok("Abc", "SAME2"), creator: "q" };
    expect(groupTokens([c, d])[0]!.label).toBe("Abc");
    expect(groupTokens([d, c])[0]!.label).toBe("Abc");
  });

  it("a token with no creator counts as one creator of its own", () => {
    const g = groupTokens([...Array.from({ length: 3 }, () => ({ ...tok("Solo", "SOLO"), creator: "" })), { ...tok("Duo", "SOLO"), creator: "z" }]);
    expect(g[0]!.label).toBe("Solo"); // three creator-less tokens are three voters
  });

  it("hostile names finish quickly: 10,000-character names and RegExp metacharacters are grouped and named under 2 s, with no pattern built from them", () => {
    const evil = ["(a+)+$", "[a-z]*.*\\", "x".repeat(10_000) + " vi", "y".repeat(10_000), "((((((((((", ".*+?^${}()|[]\\ vi"];
    const tokens = Array.from({ length: 300 }, (_, i) => ({ ...tok(evil[i % evil.length]!, evil[(i + 1) % evil.length]!), creator: `c${i % 17}` }));
    const t0 = performance.now();
    const groups = groupTokens(tokens);
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(groups.flatMap((g) => g.tokens)).toHaveLength(300);
    for (const g of groups) expect([...g.label].length).toBeLessThanOrEqual(60);
  });

  it("is linear: 20,000 tokens, a third sharing keys, group in well under a second", () => {
    const tokens = Array.from({ length: 20_000 }, (_, i) => tok(i % 3 === 0 ? "Same" + (i % 50) : `Name ${i}`, `T${i}`));
    const t0 = performance.now();
    const groups = groupTokens(tokens);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(groups.length).toBeGreaterThan(13_000);
  });
});
