import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../packages/core/src/testing/temp";
// @ts-expect-error plain .mjs script, no types
import { setup, worktreeToInstall } from "./wt-setup.mjs";

function repo(withModules: boolean): { main: string; wt: string } {
  const main = tempDir("wt-setup-");
  const wt = path.join(main, ".claude", "worktrees", "agent-x");
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, "package.json"), "{}");
  fs.writeFileSync(path.join(main, "package.json"), "{}");
  if (withModules) fs.mkdirSync(path.join(wt, "node_modules"));
  return { main, wt };
}

describe("worktreeToInstall", () => {
  it("returns the worktree root for the root and for a subdirectory", () => {
    const { wt } = repo(false);
    fs.mkdirSync(path.join(wt, "apps"));
    expect(worktreeToInstall(wt)).toBe(wt);
    expect(worktreeToInstall(path.join(wt, "apps"))).toBe(wt);
  });

  it("is null for the main checkout and for paths outside .claude/worktrees", () => {
    const { main } = repo(false);
    expect(worktreeToInstall(main)).toBeNull();
    expect(worktreeToInstall(path.join(main, ".claude"))).toBeNull();
    expect(worktreeToInstall(path.join(main, ".claude", "worktrees"))).toBeNull();
    expect(worktreeToInstall(tempDir("wt-other-"))).toBeNull();
  });

  it("is null when node_modules exists", () => {
    expect(worktreeToInstall(repo(true).wt)).toBeNull();
  });
});

describe("setup", () => {
  it("does not install outside a bare worktree", () => {
    const calls: string[] = [];
    const install = (r: string) => (calls.push(r), true);
    expect(setup(repo(false).main, { install })).toBe("skipped");
    expect(setup(repo(true).wt, { install })).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("installs in a bare worktree", () => {
    const { wt } = repo(false);
    const calls: string[] = [];
    expect(setup(wt, { install: (r: string) => (calls.push(r), true) })).toBe("installed");
    expect(calls).toEqual([wt]);
  });

  it("warns once and does not throw when the install fails", () => {
    const { wt } = repo(false);
    const warnings: string[] = [];
    expect(setup(wt, { install: () => false, warn: (m: string) => warnings.push(m) })).toBe("failed");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("wt-setup:");
  });
});
