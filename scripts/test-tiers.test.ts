import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs, no types
import { checkEnv, fastTier, INCLUDE, SLOW_TESTS } from "../vitest.tiers.mjs";

const root = new URL("..", import.meta.url).pathname;
const all: string[] = INCLUDE.flatMap((p: string) => globSync(p, { cwd: root, exclude: (n: string) => n === "node_modules" })).sort();
const slow = new Set<string>(SLOW_TESTS);
const fast = all.filter((f) => !slow.has(f));

describe("tier selection from the environment", () => {
  it("only the exact value fast selects the fast tier", () => {
    expect(fastTier({ ARGUS_TEST_TIER: "fast" })).toBe(true);
    for (const v of [undefined, "", "full", "FAST", "fast "]) expect(fastTier({ ARGUS_TEST_TIER: v })).toBe(false);
  });

  it("pnpm check's step env declares the full tier even when the caller exported fast", () => {
    const ambient = { ARGUS_TEST_TIER: "fast", PATH: "/bin" };
    expect(checkEnv(false, ambient).ARGUS_TEST_TIER).toBe("full");
    expect(fastTier(checkEnv(false, ambient))).toBe(false);
    expect(fastTier(checkEnv(true, {}))).toBe(true);
    expect(checkEnv(false, ambient).PATH).toBe("/bin");
  });
});

describe("test tiers", () => {
  it("finds the test files", () => {
    expect(all.length).toBeGreaterThan(50);
  });

  it("lists only existing test files, each once (no stale or typo'd slow entries)", () => {
    expect(SLOW_TESTS.filter((f: string) => !all.includes(f))).toEqual([]);
    expect(slow.size).toBe(SLOW_TESTS.length);
  });

  it("fast and slow are disjoint and together cover every test file", () => {
    const slowFiles = all.filter((f) => slow.has(f));
    expect(slowFiles.filter((f) => fast.includes(f))).toEqual([]);
    expect([...fast, ...slowFiles].sort()).toEqual(all);
  });
});
