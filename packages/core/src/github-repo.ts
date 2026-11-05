import { execFileSync } from "node:child_process";
import { githubCommandEnv } from "./build-runner.ts";

export interface GithubRepoCheckOptions {
  /** The `gh` binary (tests inject the fake here, as the Build runner does). */
  ghBin: string;
  /** An argus-owned directory to run `gh` in (never the Operator's cwd, so no repo's config is picked up). */
  cwd: string;
  /** Where the allowlisted environment is taken from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Extra variable names `gh` may inherit (tests only). */
  passEnv?: readonly string[];
}

/**
 * Builds the answer to "does the private GitHub repo `slug` exist?" from the `gh` CLI: yes when `gh repo view` succeeds, no only on
 * GitHub's explicit not-found answer, and an error for anything else (no network, no login), so the command is retried rather
 * than let through.
 *
 * Known limit: for a token without access to a private repo GitHub answers exactly like a missing one ("Could not resolve to a
 * Repository with the name ..."), and `gh` gives no way to tell the two apart. Such a token reads as "absent" here.
 *
 * Runs `gh` synchronously and slowly: call it before any SQLite transaction is open, never inside one.
 */
export function githubRepoCheck(o: GithubRepoCheckOptions): (slug: string) => boolean {
  const env = githubCommandEnv(o.env ?? process.env, o.passEnv);
  return (slug) => {
    try {
      execFileSync(o.ghBin, ["repo", "view", slug, "--json", "name"], { env, cwd: o.cwd, stdio: "pipe", timeout: 30_000 });
      return true;
    } catch (e) {
      const stderr = String((e as { stderr?: unknown }).stderr ?? "");
      if (/Could not resolve to a Repository with the name/i.test(stderr)) return false;
      throw new Error(`could not check GitHub for a repo named ${slug}: ${(stderr || (e instanceof Error ? e.message : String(e))).trim().slice(-200)}`);
    }
  };
}
