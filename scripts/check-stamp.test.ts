import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../packages/core/src/testing/temp.ts";
// @ts-expect-error plain .mjs script, no types
import { hasStamp, snapshot, stampDir, stampIfClean, unstampableReason } from "./check-stamp.mjs";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo(): string {
  const dir = tempDir("argus-stamp-");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("stampIfClean", () => {
  it("writes an empty stamp named by HEAD's tree under the git common dir when clean", () => {
    const dir = repo();
    const tree = stampIfClean(dir, snapshot(dir));
    expect(tree).toBe(git(dir, "rev-parse", "HEAD^{tree}"));
    expect(hasStamp(dir, tree)).toBe(true);
    expect(stampDir(dir).startsWith(join(dir, ".git"))).toBe(true);
  });

  it("writes nothing for a modified or untracked-file tree", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "changed");
    expect(stampIfClean(dir, snapshot(dir))).toBeNull();
    git(dir, "checkout", "a.txt");
    writeFileSync(join(dir, "new.txt"), "x");
    expect(stampIfClean(dir, snapshot(dir))).toBeNull();
    expect(existsSync(stampDir(dir))).toBe(false);
  });

  it("writes nothing when HEAD's tree changed during the run", () => {
    const dir = repo();
    const before = snapshot(dir);
    writeFileSync(join(dir, "b.txt"), "b");
    git(dir, "add", "b.txt");
    git(dir, "commit", "-q", "-m", "mid-run commit");
    expect(unstampableReason(before, snapshot(dir))).toBe("HEAD changed during the check");
    expect(stampIfClean(dir, before)).toBeNull();
    expect(existsSync(stampDir(dir))).toBe(false);
  });

  it("writes nothing when the tree was edited during the run, or was dirty at the start", () => {
    const dir = repo();
    const before = snapshot(dir);
    writeFileSync(join(dir, "a.txt"), "edited");
    expect(stampIfClean(dir, before)).toBeNull();
    git(dir, "checkout", "a.txt");
    expect(stampIfClean(dir, { ...before, clean: false })).toBeNull();
    expect(existsSync(stampDir(dir))).toBe(false);
  });

  it("prunes stamps older than 30 days", () => {
    const dir = repo();
    const old = join(stampDir(dir), "0".repeat(40));
    mkdirSync(stampDir(dir), { recursive: true });
    writeFileSync(old, "");
    const longAgo = new Date(Date.now() - 31 * 86400_000);
    utimesSync(old, longAgo, longAgo);
    stampIfClean(dir, snapshot(dir));
    expect(existsSync(old)).toBe(false);
  });
});
