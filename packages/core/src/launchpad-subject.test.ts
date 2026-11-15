import { describe, expect, it } from "vitest";
import { claimOrder, crossSourceForms, launchpadKeys, parseLaunchpadSignal, parseTokenTitle } from "./launchpad-subject.ts";
import { CREATE_TITLE_PREFIX, MIGRATE_TITLE_PREFIX } from "./sources/pumpportal.ts";

const MINT = "9oD9pi7KfiXKGt3zq6w65HpwbCdax5KcpEZZQE5ipump";
/** A stored create Signal naming `token` (the text after the template). */
const create = (token: string, mint = MINT) => ({ id: `pumpportal:events:create:${mint}`, sourceId: "pumpportal:events", title: `${CREATE_TITLE_PREFIX}${token}` });

describe("parseLaunchpadSignal", () => {
  it("reads the kind, the mint and the token the creator named out of the stored title", () => {
    expect(parseLaunchpadSignal(create("米苏 ($MISU)"))).toEqual({ kind: "create", mint: MINT, label: "米苏 ($MISU)", name: "米苏", symbol: "MISU", named: true });
  });

  it("splits at the last ' ($', so a name that holds one keeps it", () => {
    expect(parseTokenTitle("Foo ($X) bar ($Y)")).toEqual({ label: "Foo ($X) bar ($Y)", name: "Foo ($X) bar", symbol: "Y" });
  });

  it("a title without a ticker is all name", () => {
    expect(parseLaunchpadSignal(create("Plain Name"))).toMatchObject({ name: "Plain Name", symbol: "", named: true });
  });

  it("a bond and a nameless create name nothing but the mint", () => {
    expect(parseLaunchpadSignal({ id: `pumpportal:events:migrate:${MINT}`, sourceId: "pumpportal:events", title: `${MIGRATE_TITLE_PREFIX}9oD9...pump` })).toMatchObject({ kind: "migrate", mint: MINT, named: false, name: "" });
    expect(parseLaunchpadSignal(create("9oD9...pump"))).toMatchObject({ named: false });
  });

  it("is undefined for any other Source, an unknown event or a title off the template", () => {
    expect(parseLaunchpadSignal({ id: "rss:x:1", sourceId: "rss:x", title: `${CREATE_TITLE_PREFIX}Foo ($F)` })).toBeUndefined();
    expect(parseLaunchpadSignal({ id: "pumpportal:events:burn:abc", sourceId: "pumpportal:events", title: `${CREATE_TITLE_PREFIX}Foo ($F)` })).toBeUndefined();
    expect(parseLaunchpadSignal({ ...create("x"), title: "A token appeared" })).toBeUndefined();
  });

  it("is safe on a hostile name: regexp metacharacters, a huge name, many ' ($' (fixed-string cuts, linear)", () => {
    const hostile = `(a+)+$ ${" ($".repeat(5_000)}`;
    const t0 = performance.now();
    const parsed = parseLaunchpadSignal(create(`${hostile} ($X)`));
    expect(parsed?.symbol).toBe("X");
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("launchpadKeys and claimOrder", () => {
  it("uses ticket 03's normaliser: case, $, punctuation and script do not matter", () => {
    expect(launchpadKeys("米苏", "$MISU")).toEqual({ name: "米苏", ticker: "misu" });
    expect(launchpadKeys("Misu", "Misu")).toEqual({ name: "misu", ticker: "misu" });
  });

  it("drops generic keys (coin, meme, ai, one character) so they never match", () => {
    expect(launchpadKeys("Coin", "MEME")).toEqual({ name: undefined, ticker: undefined });
    expect(launchpadKeys("AI", "A")).toEqual({ name: undefined, ticker: undefined });
  });

  it("tries a name against names first, then a ticker against tickers, then across", () => {
    expect(claimOrder({ name: "jensen huang", ticker: "trump" })).toEqual([
      { role: "name", key: "jensen huang" },
      { role: "ticker", key: "trump" },
      { role: "ticker", key: "jensen huang" },
      { role: "name", key: "trump" },
    ]);
    expect(claimOrder({ name: undefined, ticker: "misu" })).toEqual([
      { role: "ticker", key: "misu" },
      { role: "name", key: "misu" },
    ]);
  });
});

describe("crossSourceForms", () => {
  // The semantic model's vocabulary holds these as one piece each; `misu` and `eisenkot` are split (docs/adr/0007, amendment of 2026-11-14).
  const COMMON = new Set(["moon", "zero", "poland", "party", "trump", "judge", "federal", "halts", "building", "work", "arch", "chair"]);
  const isCommonWord = (w: string) => COMMON.has(w);

  it("offers a coined word written with a capital inside the headline, and no ordinary word", () => {
    expect(crossSourceForms("Sea lion Misu TikTok videos go viral in China", isCommonWord)).toContain("misu");
    expect(crossSourceForms("NASA is looking for astronauts to live and work on the Moon", isCommonWord)).not.toContain("moon");
    expect(crossSourceForms("Federal judge halts building work on Trump's triumphal arch", isCommonWord).filter((f) => !f.includes(" "))).toEqual([]);
  });

  it("offers no single word without a test for ordinary words (the lexical embedder), and none that starts the headline or is written in lower case in a cased one", () => {
    expect(crossSourceForms("Sea lion Misu TikTok videos go viral", undefined).filter((f) => !f.includes(" "))).toEqual([]);
    expect(crossSourceForms("Misu went viral", isCommonWord).filter((f) => !f.includes(" "))).toEqual([]);
    expect(crossSourceForms("Videos of the sea lion misu went viral", isCommonWord)).not.toContain("misu");
  });

  it("a lower-case headline (a Trends query) and a Title Case one show no capital that means anything, so offer no single word", () => {
    expect(crossSourceForms("misu sea lion", isCommonWord).filter((f) => !f.includes(" "))).toEqual([]);
    expect(crossSourceForms("Locating the Source of a Mysterious Beep Today", isCommonWord).filter((f) => !f.includes(" "))).toEqual([]);
    // the same words in a sentence do offer one (here `beep`, a coined word in the model's vocabulary, with a capital inside)
    expect(crossSourceForms("Engineers traced a Beep from the old server room", isCommonWord)).toContain("beep");
  });

  it("a lower-case headline still offers a phrase of two words", () => {
    expect(crossSourceForms("david walliams", isCommonWord)).toContain("david walliams");
  });

  it("offers phrases of two or three words, but never one built from generic words", () => {
    const forms = crossSourceForms("Big AI coin and Trump", isCommonWord);
    expect(forms.some((f) => f.includes(" "))).toBe(false);
    expect(crossSourceForms("Nvidia names Colette Kress interim CEO", isCommonWord)).toContain("colette kress");
  });

  it("is linear on a hostile headline", () => {
    const t0 = performance.now();
    crossSourceForms("a".repeat(100_000) + " " + "Xyzzy ".repeat(5_000), isCommonWord);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
