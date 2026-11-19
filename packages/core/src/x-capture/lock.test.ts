import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../testing/temp.ts";
// @ts-expect-error plain .mjs module, no types
import { assertDirSafe, lockHolder } from "./lock.mjs";

// The lock and directory checks moved out of the capture spike into one shared module; behaviour unchanged.
describe("lockHolder", () => {
  it("is null when the directory has no lock", () => {
    expect(lockHolder(tempDir("x-lock-"))).toBeNull();
  });

  it("is alive for a lock held by a running process (this one)", () => {
    const dir = tempDir("x-lock-");
    symlinkSync(`somehost-${process.pid}`, path.join(dir, "SingletonLock"));
    expect(lockHolder(dir)).toEqual({ pid: process.pid, alive: true, stale: false });
  });

  it("is stale for a lock whose process is gone, and for a lock with no pid", () => {
    const dir = tempDir("x-lock-");
    symlinkSync("somehost-2147483646", path.join(dir, "SingletonLock"));
    expect(lockHolder(dir)).toMatchObject({ alive: false, stale: true });
    const dir2 = tempDir("x-lock-");
    symlinkSync("somehost-notanumber", path.join(dir2, "SingletonLock"));
    expect(lockHolder(dir2)).toEqual({ pid: null, alive: false, stale: true });
  });
});

describe("assertDirSafe", () => {
  it("accepts a 700 directory outside the working directory's repository", () => {
    const dir = tempDir("x-safe-");
    chmodSync(dir, 0o700);
    expect(assertDirSafe(dir, "/somewhere/else")).toBe("700");
  });

  it("refuses any other mode", () => {
    const dir = tempDir("x-safe-");
    chmodSync(dir, 0o755);
    expect(() => assertDirSafe(dir, "/somewhere/else")).toThrow(/expected 700/);
  });

  it("refuses a directory inside a repository", () => {
    const repo = tempDir("x-repo-");
    mkdirSync(path.join(repo, ".git"));
    const inside = path.join(repo, "chrome");
    mkdirSync(inside, { mode: 0o700 });
    chmodSync(inside, 0o700);
    expect(() => assertDirSafe(inside, repo)).toThrow(/outside the repository/);
  });
});
