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

describe("assignGraduates blend pass (christmas-fix ticket 04)", () => {
  const bar = { minGrads: 10, minCreators: 6, live6h: 3 };
  const santaTokens = ["s1", "s2", "s3"].map((creator) => ({ name: "Santa Claus", symbol: "SANTA", creator }));
  /** Christmas: its theme key `christmas`, the short stem `mas` as a merged key, and three creators who launched Santa tokens. */
  const christmas = { key: "christmas", label: "Christmas", memberKeys: ["mas"], tokens: santaTokens };
  const bull = { key: "bull", label: "Bull", tokens: [{ name: "Bull Run", symbol: "BULL", creator: "u1" }] };
  /** `n` exact-name graduates of Christmas, the first `recent` of them inside the last 6 h. */
  const exact = (n: number, recent: number) => Array.from({ length: n }, (_, i) => grad(`e${i}`, "Christmas Cat", "CCAT", `c${i}`, i < recent ? 10 * (i + 1) : 400 + i));
  const blends = [grad("b1", "Bullmas", "BULLMAS", "b1", 10), grad("b2", "CATEMAS", "CATEMAS", "b2", 20), grad("b3", "pepesanta", "PEPESANTA", "b3", 30)];
  const run = (over: Partial<Parameters<typeof assignGraduates>[0]> & { graduates: readonly GraduatedToken[] }) => assignGraduates({ ...base, subjects: [christmas], bar, ...over });

  it("the exact passes leave Bullmas, CATEMAS and pepesanta unassigned; the blend pass gives them to Christmas, which reaches 10 graduations, 10 creators and 3 in 6 h", () => {
    const withoutBar = run({ graduates: [...exact(7, 0), ...blends], bar: undefined });
    expect(withoutBar.grads[0]).toMatchObject({ "24h": 7, "6h": 0, creators24h: 7 });
    const r = run({ graduates: [...exact(7, 0), ...blends] });
    expect(r.grads[0]).toMatchObject({ "24h": 10, "6h": 3, creators24h: 10 });
    expect(r.graduates[0]!.map((g) => g.mint)).toEqual(expect.arrayContaining(["b1", "b2", "b3"]));
  });

  it("a stem used by 2 distinct creators is not learned; one used by 3 is", () => {
    const winter = (creators: string[]) => ({ key: "winter", label: "Winter", tokens: creators.map((creator) => ({ name: "Frosty", symbol: "FROSTY", creator })) });
    const g = [grad("f", "Frostyking", "FK", "z", 10)];
    expect(run({ subjects: [winter(["a", "b", "a", "b"])], graduates: g }).grads[0]!["24h"]).toBe(0);
    expect(run({ subjects: [winter(["a", "b", "c", "a"])], graduates: g }).grads[0]!["24h"]).toBe(1);
  });

  it("a stem with 69 % self-consistency is not learned; 70 % is", () => {
    const frosty = (n: number, key: string) => ({ key, label: key, tokens: Array.from({ length: n }, (_, i) => ({ name: "Frosty", symbol: "FROSTY", creator: `${key}${i % 5}` })) });
    const g = [grad("f", "Frostyking", "FK", "z", 10)];
    expect(run({ subjects: [frosty(69, "winter"), frosty(31, "other")], graduates: g }).grads.map((c) => c["24h"])).toEqual([0, 0]);
    expect(run({ subjects: [frosty(70, "winter"), frosty(30, "other")], graduates: g }).grads.map((c) => c["24h"])).toEqual([1, 0]);
  });

  it("a graduate that matches two subjects is ambiguous and joins none", () => {
    const r = run({ subjects: [christmas, bull], graduates: [grad("b1", "Bullmas", "BULLMAS", "b1", 10)] });
    expect(r.grads.map((c) => c["24h"])).toEqual([0, 0]);
  });

  it("a graduate already assigned (by its create, or by its name) is never moved by the blend", () => {
    const r = run({
      subjects: [christmas, bull],
      graduates: [grad("m", "CATEMAS", "CATEMAS", "a", 10), grad("n", "Bull Catemas", "BC", "b", 10)],
      mintSubject: new Map([["m", 1]]),
    });
    expect(r.grads.map((c) => c["24h"])).toEqual([0, 2]);
  });

  it("a subject that is already a Meta gains nothing from the blend pass", () => {
    const r = run({ graduates: [...exact(10, 3), grad("b2", "CATEMAS", "CATEMAS", "b2", 20)] });
    expect(r.grads[0]).toMatchObject({ "24h": 10, "6h": 3, creators24h: 10 });
  });

  it("a subject the previous tick had as a Meta is strong even below the bar (kept by hysteresis), so it gains nothing from the blend", () => {
    const graduates = [...exact(8, 3), grad("b2", "CATEMAS", "CATEMAS", "b2", 20)];
    expect(run({ graduates }).grads[0]!["24h"]).toBe(9); // control: weak, the blend joins it
    const r = run({ graduates, wasMeta: () => true });
    expect(r.grads[0]).toMatchObject({ "24h": 8, "6h": 3, creators24h: 8 });
    expect(r.graduates[0]!.map((g) => g.mint)).not.toContain("b2");
  });

  it("Thomas does not join a subject through the stem mas; CATEMAS does", () => {
    const r = run({ graduates: [grad("t", "Thomas", "THOMAS", "t", 10), grad("c", "CATEMAS", "CATEMAS", "c", 10)] });
    expect(r.graduates[0]!.map((g) => g.mint)).toEqual(["c"]);
  });
});
