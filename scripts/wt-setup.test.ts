import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../packages/core/src/testing/temp";
// @ts-expect-error plain .mjs script, no types
import { setup, worktreeToInstall } from "./wt-setup.mjs";

const scratch = tempDir;

function repo(withModules: boolean): { main: string; wt: string } {
  const main = scratch("wt-setup-");
  const wt = path.join(main, ".claude", "worktrees", "agent-x");
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, "package.json"), "{}");
  fs.writeFileSync(path.join(main, "package.json"), "{}");
  if (withModules) fs.mkdirSync(path.join(wt, "node_modules"));
  return { main, wt };
}

describe("worktreeToInstall", () => {
  it("returns the worktree root for the root and for a subdirectory", () => {
    const { main, wt } = repo(false);
    fs.mkdirSync(path.join(wt, "apps"));
    const real = fs.realpathSync(wt);
    expect(worktreeToInstall(wt, main)).toBe(real);
    expect(worktreeToInstall(path.join(wt, "apps"), main)).toBe(real);
  });

  it("is null for the main checkout and for paths outside .claude/worktrees", () => {
    const { main } = repo(false);
    expect(worktreeToInstall(main, main)).toBeNull();
    expect(worktreeToInstall(path.join(main, ".claude"), main)).toBeNull();
    expect(worktreeToInstall(path.join(main, ".claude", "worktrees"), main)).toBeNull();
    expect(worktreeToInstall(scratch("wt-other-"), main)).toBeNull();
  });

  it("is null when node_modules exists", () => {
    const { main, wt } = repo(true);
    expect(worktreeToInstall(wt, main)).toBeNull();
  });

  it("is null for a worktree name that is a symlink to somewhere else", () => {
    const { main } = repo(false);
    const elsewhere = scratch("wt-elsewhere-");
    fs.writeFileSync(path.join(elsewhere, "package.json"), "{}");
    const link = path.join(main, ".claude", "worktrees", "linked");
    fs.symlinkSync(elsewhere, link);
    expect(worktreeToInstall(link, main)).toBeNull();
  });

  it("resolves an alias symlink to a real sibling worktree to that sibling", () => {
    const { main, wt } = repo(false);
    const alias = path.join(main, ".claude", "worktrees", "alias");
    fs.symlinkSync(wt, alias);
    expect(worktreeToInstall(alias, main)).toBe(fs.realpathSync(wt));
  });

  it("is null for a path that climbs out with ..", () => {
    const { main, wt } = repo(false);
    const outside = scratch("wt-outside-");
    fs.writeFileSync(path.join(outside, "package.json"), "{}");
    const climbing = path.join(wt, "..", "..", "..", "..", path.relative(path.dirname(main), outside));
    expect(worktreeToInstall(climbing, main)).toBeNull();
    expect(worktreeToInstall(path.join(wt, ".."), main)).toBeNull();
  });

  it("is null for another repo's worktree", () => {
    const { main } = repo(false);
    const foreign = repo(false);
    expect(worktreeToInstall(foreign.wt, main)).toBeNull();
  });
});

describe("setup", () => {
  it("does not install outside a bare worktree", () => {
    const calls: string[] = [];
    const install = (r: string) => (calls.push(r), true);
    const bare = repo(false);
    const withModules = repo(true);
    expect(setup(bare.main, { repoRoot: bare.main, install })).toBe("skipped");
    expect(setup(withModules.wt, { repoRoot: withModules.main, install })).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("does not install for a symlinked name, a .. path or a foreign repo's worktree", () => {
    const calls: string[] = [];
    const install = (r: string) => (calls.push(r), true);
    const { main, wt } = repo(false);
    const elsewhere = scratch("wt-elsewhere-");
    fs.writeFileSync(path.join(elsewhere, "package.json"), "{}");
    const link = path.join(main, ".claude", "worktrees", "linked");
    fs.symlinkSync(elsewhere, link);
    expect(setup(link, { repoRoot: main, install })).toBe("skipped");
    expect(setup(path.join(wt, "..", "..", ".."), { repoRoot: main, install })).toBe("skipped");
    expect(setup(repo(false).wt, { repoRoot: main, install })).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("installs in a bare worktree", () => {
    const { main, wt } = repo(false);
    const calls: string[] = [];
    expect(setup(wt, { repoRoot: main, install: (r: string) => (calls.push(r), true) })).toBe("installed");
    expect(calls).toEqual([fs.realpathSync(wt)]);
  });

  it("warns once and does not throw when the install fails", () => {
    const { main, wt } = repo(false);
    const warnings: string[] = [];
    expect(setup(wt, { repoRoot: main, install: () => false, warn: (m: string) => warnings.push(m) })).toBe("failed");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("wt-setup:");
  });
});
