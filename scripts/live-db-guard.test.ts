import { linkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../packages/core/src/testing/temp.ts";
// @ts-expect-error plain .mjs script, no types
import { isLiveDb } from "./live-db-guard.mjs";

describe("isLiveDb", () => {
  const dir = tempDir("argus-live-db-guard-");
  const live = join(dir, "live.db");
  writeFileSync(live, "x");
  const copy = join(dir, "copy.db");
  writeFileSync(copy, "x");
  const symlink = join(dir, "sym.db");
  symlinkSync(live, symlink);
  const hardlink = join(dir, "hard.db");
  linkSync(live, hardlink);

  it("refuses the same path, a symlink and a hard link to the live file", () => {
    expect(isLiveDb(live, [live])).toBe(true);
    expect(isLiveDb(symlink, [live])).toBe(true);
    expect(isLiveDb(hardlink, [live])).toBe(true);
  });

  it("allows an unrelated copy and ignores missing or unset live paths", () => {
    expect(isLiveDb(copy, [live])).toBe(false);
    expect(isLiveDb(copy, [join(dir, "missing.db"), undefined])).toBe(false);
  });
});
