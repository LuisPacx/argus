import { describe, expect, it } from "vitest";
import { termMatches } from "./term-match.ts";

describe("termMatches (shared rule)", () => {
  it("matches a short stem as a whole word, a word start, or a blend end, not Thomas or Xmas", () => {
    expect(termMatches("mas", "CATEMAS")).toBe(true);
    expect(termMatches("mas", "Bullmas")).toBe(true);
    expect(termMatches("mas", "Thomas")).toBe(false);
    expect(termMatches("mas", "Xmas")).toBe(false);
    expect(termMatches("mas", "mas")).toBe(true);
    expect(termMatches("mas", "Masked")).toBe(true);
  });

  it("matches a term of 4 or more characters anywhere, case-insensitively, whitespace collapsed", () => {
    expect(termMatches("xmas", "supertxmasdoge")).toBe(true);
    expect(termMatches("santa  claus", "SANTA \t Claus Coin")).toBe(true);
    expect(termMatches("santa", "Sant a")).toBe(false);
  });

  it("matches full-width and compatibility forms to plain spellings", () => {
    expect(termMatches("santa", "ＳＡＮＴＡ")).toBe(true);
    expect(termMatches("ＳＡＮＴＡ", "santa inu")).toBe(true);
    expect(termMatches("mas", "ＣＡＴＥＭＡＳ")).toBe(true);
    expect(termMatches("ﬁsh", "big fish")).toBe(true);
  });

  it("matches a decomposed accent to its composed form in both directions", () => {
    const composed = "café coin";
    const decomposed = "café coin";
    expect(termMatches("café", decomposed)).toBe(true);
    expect(termMatches("café", composed)).toBe(true);
  });

  it("returns false for an empty term", () => {
    expect(termMatches("  ", "anything")).toBe(false);
  });

  it("stays linear on a long input with a short term", () => {
    const text = "a".repeat(2_000_000) + " mas";
    const start = performance.now();
    expect(termMatches("mas", text)).toBe(true);
    expect(termMatches("mas", "b".repeat(2_000_000))).toBe(false);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
