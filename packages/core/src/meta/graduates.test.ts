import { describe, expect, it } from "vitest";
import type { GraduatedToken } from "../study/store.ts";
import { assignGraduates } from "./graduates.ts";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const grad = (mint: string, name: string, symbol: string, creator: string, minutesAgo: number): GraduatedToken => ({ mint, name, symbol, creator, createdAt: null, migratedAt: ago(minutesAgo) });

const subjects = [
  { key: "santa", label: "Santa", tokens: [{ name: "Santa", symbol: "SANTA" }], memberKeys: ["santa", "xmas"] },
  { key: "moon", label: "Moon", tokens: [{ name: "Moon Cat", symbol: "MOON" }] },
  { key: "mooncat", label: "Moon Cat", tokens: [{ name: "Moon Cat", symbol: "MCAT" }] },
];
const base = { subjects, mintSubject: new Map<string, number>(), nameable: () => true, nowMs: NOW, minKeyChars: 4 };

describe("assignGraduates", () => {
  it("a graduate whose create is held by a subject joins it by mint, whatever its name", () => {
    const r = assignGraduates({ ...base, graduates: [grad("m1", "Totally Unrelated", "TU", "a", 10)], mintSubject: new Map([["m1", 1]]) });
    expect(r.grads.map((g) => g["24h"])).toEqual([0, 1, 0]);
  });

  it("a graduate with no create in the read joins the one subject its name or ticker forms name: a word, a ticker, a merged theme key", () => {
    const r = assignGraduates({ ...base, graduates: [grad("a", "Santa Inu", "SINU", "a", 10), grad("b", "Saint Nicholas", "SANTA", "b", 20), grad("c", "Merry", "XMAS", "c", 30)] });
    expect(r.grads[0]).toMatchObject({ "24h": 3, "6h": 3, creators24h: 3 });
    expect(r.graduates[0]!.map((g) => g.mint)).toEqual(["a", "b", "c"]);
  });

  it("an ambiguous match (forms naming two subjects) joins none, and a name no subject has joins none; both still count in the share's total", () => {
    const r = assignGraduates({ ...base, graduates: [grad("a", "Moon Cat", "MC", "a", 10), grad("b", "Nothing Here", "NH", "b", 10), grad("c", "Santa", "SANTA", "c", 10), grad("d", "", "", "", 10)] });
    expect(r.grads.map((g) => g["24h"])).toEqual([1, 0, 0]);
    expect(r.grads[0]!.share).toBe(0.25); // 1 of the 4 graduates in the window
  });

  it("counts by graduation time: 6 h and 24 h windows, distinct creators, a repeated mint once, and a graduate outside the window or after the as-of time not at all", () => {
    const r = assignGraduates({
      ...base,
      graduates: [grad("a", "Santa", "SANTA", "same", 10), grad("a", "Santa", "SANTA", "same", 10), grad("b", "Santa", "SANTA", "same", 400), grad("c", "Santa", "SANTA", "other", 1_439), grad("d", "Santa", "SANTA", "x", 1_441), grad("e", "Santa", "SANTA", "y", -5)],
    });
    expect(r.grads[0]).toMatchObject({ "24h": 3, "6h": 1, creators24h: 2 });
  });

  it("only subjects marked nameable can be matched by name, and a subject nobody could match still holds its own mints", () => {
    const r = assignGraduates({ ...base, nameable: (i) => i !== 0, graduates: [grad("a", "Santa", "SANTA", "a", 10), grad("b", "Whatever", "W", "b", 10)], mintSubject: new Map([["b", 0]]) });
    expect(r.grads.map((g) => g["24h"])).toEqual([1, 0, 0]);
    expect(r.graduates[0]!.map((g) => g.mint)).toEqual(["b"]);
  });
});
