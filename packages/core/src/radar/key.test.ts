import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aliasKey, normaliseKey } from "../meta/key.ts";
import { radarKey } from "./key.ts";

describe("radarKey", () => {
  it("is aliasKey(normaliseKey(x)) from meta/key.ts", () => {
    for (const x of ["GTA VI", "Super Bowl LX", "#GTA6", "Café Olé", "a  b   c", "米苏"]) expect(radarKey(x)).toBe(aliasKey(normaliseKey(x)));
  });

  it("folds GTA VI, gta 6, GTA6 and #GTA6 to one key", () => {
    expect(new Set(["GTA VI", "gta 6", "GTA6", "#GTA6", "gta vi"].map(radarKey))).toEqual(new Set(["gta6"]));
  });

  it("does not rewrite Super Bowl LX", () => {
    expect(radarKey("Super Bowl LX")).toBe("superbowllx");
  });

  it("gives no key for only punctuation or emoji", () => {
    for (const x of ["", "!!! ???", "🔥🔥🔥", "…", "   ", "​‍"]) expect(radarKey(x)).toBe("");
  });

  it("cuts 10,000 characters", () => {
    expect(radarKey("a".repeat(10_000)).length).toBeLessThanOrEqual(64);
    expect(radarKey("word ".repeat(5_000)).length).toBeLessThanOrEqual(64);
  });
});

describe("the radar has no normaliser and builds no RegExp from text", () => {
  const dir = new URL(".", import.meta.url);
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const code = (f: string) =>
    readFileSync(new URL(f, dir), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
      .join("\n");

  it("reads the source files of radar/", () => {
    expect(files).toEqual(expect.arrayContaining(["key.ts", "clean.ts", "check.ts", "job.ts", "store.ts", "skip.ts", "readers/google-trends.ts"]));
  });

  it.each(files)("%s defines no numeral table, no case or Unicode folding and no dynamic RegExp", (f) => {
    const src = code(f);
    expect(src).not.toMatch(/new RegExp|RegExp\(/);
    expect(src).not.toMatch(/\.normalize\(|toLowerCase|toLocaleLowerCase|toUpperCase/);
    expect(src).not.toMatch(/ROMAN|NUMERAL/i);
  });
});
