import { describe, expect, it } from "vitest";
import { cleanTerm, searchWords } from "./clean.ts";

const HOSTILE = ["<img src=x onerror=1>", "from:elonmusk", '"a" OR (b)', "a\u0000b\u0007c\r\nd\te", "x".repeat(100_000), "<<<<<<<<<<<<<<<<<<<<".repeat(5_000)];

describe("cleanTerm (what reaches storage)", () => {
  it("removes markup and flattens", () => {
    expect(cleanTerm("<img src=x onerror=1>")).toBe("");
    expect(cleanTerm("big <b>news</b> today")).toBe("big news today");
    expect(cleanTerm("a\u0000b\u0007c\r\nd\te")).toBe("a b c d e");
    expect(cleanTerm("line one\nline two three")).toBe("line one line two three");
    expect(cleanTerm("‮evil‬ text")).not.toMatch(/[‮‬]/);
  });

  it("keeps operators as plain stored text and removes stray angle brackets", () => {
    expect(cleanTerm("from:elonmusk")).toBe("from:elonmusk");
    expect(cleanTerm('"a" OR (b)')).toBe('"a" OR (b)');
    expect(cleanTerm("1 < 2 > 0")).not.toMatch(/[<>]/);
  });

  it("cuts 100,000 characters to one short line", () => {
    const out = cleanTerm("x".repeat(100_000));
    expect(out.length).toBeLessThanOrEqual(301);
    expect(out.endsWith("…")).toBe(true);
    expect(cleanTerm("y".repeat(50), 10)).toBe(`${"y".repeat(10)}…`);
  });

  it("a hostile megabyte of brackets costs the same as a short term", () => {
    const started = performance.now();
    cleanTerm("<".repeat(1_000_000));
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("a non-string is empty", () => {
    for (const v of [undefined, null, 5, {}, ["a"]]) expect(cleanTerm(v)).toBe("");
  });

  it.each(HOSTILE)("never leaves a newline, control character or angle bracket (%#)", (text) => {
    const out = cleanTerm(text);
    expect([...out].filter((c) => c === "<" || c === ">" || (c.codePointAt(0) ?? 0) < 32)).toEqual([]);
    expect(out.length).toBeLessThanOrEqual(301);
  });
});

describe("searchWords (what reaches a search)", () => {
  it("keeps letters, digits and spaces only", () => {
    expect(searchWords("GTA 6")).toBe("GTA 6");
    expect(searchWords("from:elonmusk")).toBe("from elonmusk");
    expect(searchWords('"a" OR (b)')).toBe("a OR b");
    expect(searchWords("<img src=x onerror=1>")).toBe("img src x onerror 1");
    expect(searchWords("café 米苏 déjà-vu")).toBe("café 米苏 déjà vu");
    expect(searchWords("url:https://x.com/a?q=1&r=2#h")).toBe("url https x com a q");
  });

  it("is 1 to 6 words, each cut to 40 characters", () => {
    expect(searchWords("one two three four five six seven eight")).toBe("one two three four five six");
    expect(searchWords(`${"w".repeat(100)} b`)).toBe(`${"w".repeat(40)} b`);
    expect(searchWords("x".repeat(100_000))).toBe("x".repeat(40));
  });

  it("refuses when nothing is left", () => {
    for (const v of ["", "   ", "!!! ???", '"" () ::', "🔥🔥", undefined, null, 5]) expect(searchWords(v)).toBeNull();
  });

  it.each(HOSTILE)("the answer is only letters, digits and single spaces (%#)", (text) => {
    const out = searchWords(text);
    if (out === null) return;
    expect(out).toMatch(/^[\p{L}\p{M}\p{Nd}]+(?: [\p{L}\p{M}\p{Nd}]+){0,5}$/u);
  });
});
