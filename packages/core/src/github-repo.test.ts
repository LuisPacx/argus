import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { githubRepoCheck, GithubNoAccessError } from "./github-repo.ts";
import { FAKE_GH } from "./testing/fake-tools.ts";
import { tempDir } from "./testing/temp.ts";

// Ticket 03 (hardening), items 5 and 6: a `gh` exit 1 is "not found" only on gh's not-found text, and a repo that does not exist is
// told apart from a token that cannot see it.

const PASS = ["FAKE_GH_REMOTES", "FAKE_GH_VIEW_FAIL", "FAKE_GH_VIEW_EXIT", "FAKE_GH_SCOPES", "FAKE_GH_API_FAIL"];
function setup(extra: Record<string, string> = {}) {
  const dir = tempDir("argus-remotes-");
  const cwd = tempDir("argus-ghcwd-");
  mkdirSync(join(dir, "cat-coin.git"));
  return githubRepoCheck({ ghBin: FAKE_GH, cwd, env: { PATH: process.env.PATH, FAKE_GH_REMOTES: dir, ...extra }, passEnv: PASS });
}

describe("githubRepoCheck: what counts as 'the repo does not exist'", () => {
  it("is not-found only for exit 1 with gh's not-found text; the same text with another exit code fails closed", () => {
    expect(setup()("dog-coin")).toBe(false);
    const other = setup({ FAKE_GH_VIEW_EXIT: "4" });
    expect(() => other("dog-coin")).toThrow(/could not check GitHub for a repo named dog-coin/);
    expect(() => other("dog-coin")).not.toThrow(GithubNoAccessError);
  });

  it("any other exit-1 output fails closed", () => {
    expect(() => setup({ FAKE_GH_VIEW_FAIL: "1" })("dog-coin")).toThrow(/could not check GitHub/);
  });

  it("an existing repo is still found", () => {
    expect(setup()("cat-coin")).toBe(true);
  });
});

describe("githubRepoCheck: 'does not exist' is told apart from 'no access'", () => {
  it("a token that can read private repos (the repo scope) gets 'does not exist' from GitHub's not-found", () => {
    expect(setup({ FAKE_GH_SCOPES: "repo, read:org" })("dog-coin")).toBe(false);
  });

  it("a token without the repo scope cannot say: the answer is a no-access error that names the scopes, never 'absent'", () => {
    const check = setup({ FAKE_GH_SCOPES: "public_repo, read:org" });
    expect(() => check("dog-coin")).toThrow(GithubNoAccessError);
    expect(() => check("dog-coin")).toThrow(/no access to private repos.*public_repo, read:org/);
    expect(check("cat-coin")).toBe(true); // a repo gh can view needs no such check
  });

  it("a token that reports no scopes at all (a fine-grained one) cannot be told either, and fails closed with its own message", () => {
    const check = setup({ FAKE_GH_SCOPES: "none" });
    expect(() => check("dog-coin")).toThrow(GithubNoAccessError);
    expect(() => check("dog-coin")).toThrow(/does not say which repos it can read/);
  });

  it("a failing scope probe fails closed too", () => {
    expect(() => setup({ FAKE_GH_API_FAIL: "1" })("dog-coin")).toThrow(/could not check GitHub/);
  });
});
