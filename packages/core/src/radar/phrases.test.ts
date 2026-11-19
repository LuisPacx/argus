import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { at } from "../testing/radar.ts";
import { headlinePhrases, PhraseCounter } from "./phrases.ts";

/** Headline phrase counting (spec 5.1, ticket 02): plain code, no model, no RegExp from text. */
const keys = (title: string) => headlinePhrases(title).map((p) => p.key);
const feeds = (counter: PhraseCounter, key: string, now: Date) => counter.entries(key, now.getTime()).map((e) => e.feed);

describe("the phrases of a headline", () => {
  it("are 1 to 4 words with the stop words dropped, each keyed once", () => {
    const p = headlinePhrases("The Rise of the Zelda Movie");
    expect(p.map((x) => x.term)).toEqual(expect.arrayContaining(["rise", "zelda", "movie", "rise zelda", "zelda movie", "rise zelda movie"]));
    expect(p.every((x) => x.term.split(" ").length <= 4)).toBe(true);
    expect(headlinePhrases("Zelda zelda ZELDA").filter((x) => x.term === "zelda")).toHaveLength(1);
    expect(headlinePhrases("alpha bravo charlie delta echo foxtrot").map((x) => x.term)).not.toContain("alpha bravo charlie delta echo");
  });

  it("'GTA VI' in one feed and 'GTA 6' in another are one key", () => {
    expect(keys("GTA VI trailer is here")).toContain("gta6");
    expect(keys("GTA 6 gets a release date")).toContain("gta6");
    expect(keys("#GTA6 everywhere")).toContain("gta6");
  });

  it("a phrase of stop words only, numbers only or one-letter words is not a phrase", () => {
    expect(headlinePhrases("the and of to in")).toEqual([]);
    expect(headlinePhrases("2026 2027 12")).toEqual([]);
    expect(headlinePhrases("a b c d")).toEqual([]);
    expect(headlinePhrases("")).toEqual([]);
    expect(headlinePhrases(null)).toEqual([]);
    expect(headlinePhrases(42)).toEqual([]);
    expect(headlinePhrases("🔥🔥 !!! ???")).toEqual([]);
  });

  it("a possessive is the word: Anthropic's is anthropic", () => {
    expect(keys("Why Anthropic's IPO matters")).toEqual(expect.arrayContaining(["anthropic", "anthropicipo"]));
    expect(keys("Why Anthropic’s IPO matters")).toContain("anthropic");
  });

  it("20,000 characters of headline are cut and cost the same as a long one", () => {
    const hostile = `${"word ".repeat(4_000)}${"x".repeat(20_000)}`;
    const t0 = performance.now();
    const p = headlinePhrases(hostile);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(p.length).toBeLessThanOrEqual(4 * 40);
    const counter = new PhraseCounter();
    const t1 = performance.now();
    for (let i = 0; i < 50; i++) counter.add(`radar:f${i}`, hostile, "", at(0).getTime());
    expect(performance.now() - t1).toBeLessThan(1_000);
  });

  it("builds no RegExp from the text (a source check) and defines no folding of its own", () => {
    const src = readFileSync(new URL("./phrases.ts", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
      .join("\n");
    expect(src).not.toMatch(/new RegExp|RegExp\(/);
    expect(src).not.toMatch(/toLowerCase|toUpperCase|\.normalize\(/);
  });
});

describe("the counter", () => {
  const T = at(0).getTime();
  const NOW = at(30);

  it("a phrase in 3 distinct feeds inside 3 hours is a candidate", () => {
    const c = new PhraseCounter();
    c.add("radar:a", "Anthropic IPO filing", "", at(0).getTime());
    c.add("radar:b", "Anthropic IPO is coming", "", at(20).getTime());
    expect(c.agreed(NOW.getTime())).not.toContain("anthropicipo");
    c.add("radar:c", "Report: Anthropic IPO", "", at(25).getTime());
    expect(c.agreed(NOW.getTime())).toContain("anthropicipo");
    expect(feeds(c, "anthropicipo", NOW)).toEqual(["radar:a", "radar:b", "radar:c"]);
  });

  it("the same phrase 5 times in one feed counts once", () => {
    const c = new PhraseCounter();
    for (let i = 0; i < 5; i++) c.add("radar:a", `Anthropic IPO, take ${i}`, "", T + i * 60_000);
    expect(feeds(c, "anthropicipo", NOW)).toEqual(["radar:a"]);
    expect(c.agreed(NOW.getTime())).not.toContain("anthropicipo");
  });

  it("3 feeds spread over 5 hours are not a candidate at any time", () => {
    const c = new PhraseCounter();
    const published = [0, 150, 300];
    for (let m = 0; m <= 340; m += 10) {
      const now = at(m).getTime();
      c.expire(now);
      published.forEach((p, i) => {
        if (m >= p) c.add(`radar:f${i}`, "Anthropic IPO filing", "", at(p).getTime());
      });
      expect(c.agreed(now), `at ${m}`).not.toContain("anthropicipo");
    }
  });

  it("a feed's older item falls out of the window and a new one counts again", () => {
    const c = new PhraseCounter();
    c.add("radar:a", "Zelda movie", "", at(0).getTime());
    c.expire(at(181).getTime());
    expect(c.size).toBe(0);
    expect(c.add("radar:a", "Zelda movie", "", at(181).getTime())).toEqual(expect.arrayContaining(["zeldamovie"]));
  });

  it("add reports only the keys that are new for that feed", () => {
    const c = new PhraseCounter();
    expect(c.add("radar:a", "Zelda movie", "", T)).toEqual(expect.arrayContaining(["zelda", "movie", "zeldamovie"]));
    expect(c.add("radar:a", "Zelda movie", "", T)).toEqual([]);
    expect(c.add("radar:b", "Zelda movie", "", T)).toHaveLength(3);
  });
});
