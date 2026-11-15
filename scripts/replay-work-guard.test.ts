import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../packages/core/src/testing/temp.ts";
// @ts-expect-error plain .mjs script, no types
import { workDirRefusal } from "./replay-work-guard.mjs";

describe("workDirRefusal", () => {
  const root = tempDir("argus-replay-guard-");
  const roots = [root];

  it("accepts a new directory, and an empty one, under an allowed root", () => {
    expect(workDirRefusal(join(root, "new", "replay"), roots)).toBeUndefined();
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(workDirRefusal(empty, roots)).toBeUndefined();
  });

  it("refuses a directory that already holds something (it would have been deleted)", () => {
    const full = join(root, "full");
    mkdirSync(full);
    writeFileSync(join(full, "keep.txt"), "x");
    expect(workDirRefusal(full, roots)).toMatch(/not empty/);
  });

  it("refuses a path outside the allowed roots, the root itself, /tmp and a file", () => {
    expect(workDirRefusal("/home", roots)).toMatch(/must be a new directory under/);
    expect(workDirRefusal(root, roots)).toMatch(/must be a new directory under/);
    expect(workDirRefusal(join(root, ".."), roots)).toMatch(/must be a new directory under/);
    expect(workDirRefusal("/tmp/replay", ["/tmp"])).toMatch(/\/tmp/);
    const file = join(root, "afile");
    writeFileSync(file, "x");
    expect(workDirRefusal(file, roots)).toMatch(/not a directory|not empty/);
  });

  it("refuses a symlink under a root that points outside it", () => {
    const outside = tempDir("argus-replay-guard-out-");
    const link = join(root, "link");
    symlinkSync(outside, link);
    expect(workDirRefusal(link, roots)).toMatch(/must be a new directory under/);
  });

  it("refuses a not-yet-existing path below a symlinked ancestor that points outside the roots", () => {
    const outside = tempDir("argus-replay-guard-out2-");
    const link = join(root, "ancestor-link");
    symlinkSync(outside, link);
    expect(workDirRefusal(join(link, "x"), roots)).toMatch(/must be a new directory under/);
    expect(workDirRefusal(join(link, "a", "b"), roots)).toMatch(/must be a new directory under/);
  });
});
