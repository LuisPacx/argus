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

/** The token cannot be shown to see private repos, so a "could not resolve" from GitHub may mean the repo exists and is hidden from it. */
export class GithubNoAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubNoAccessError";
  }
}

/** gh's own not-found answer to `repo view` (its GraphQL error), as it prints it on stderr. */
const NOT_FOUND_RE = /^GraphQL: Could not resolve to a Repository with the name '[^'\n]*'\. \(repository\)\s*$/m;

/**
 * Builds the answer to "does the private GitHub repo `slug` exist?" from the `gh` CLI: yes when `gh repo view` succeeds, and no only
 * when gh exited 1 with GitHub's explicit not-found text and the token is known to be able to read private repos. Anything else
 * is an error, so the command is retried rather than let through: no network, no login, another exit code or other text with exit 1,
 * and a token that cannot be shown to see private repos (`GithubNoAccessError`).
 *
 * Why the last one: for a token without access to a private repo GitHub answers exactly like for a missing one ("Could not resolve to a
 * Repository ..."), so a not-found alone does not tell "does not exist" from "exists, and you cannot see it". The two are told apart by
 * the token: a classic or OAuth token with the `repo` scope sees every private repo of its owner, so for it not-found means absent;
 * a token whose scopes lack `repo`, or that reports none (a fine-grained token names its repos elsewhere), cannot say.
 *
 * Runs `gh` synchronously and slowly: call it before any SQLite transaction is open, never inside one.
 */
export function githubRepoCheck(o: GithubRepoCheckOptions): (slug: string) => boolean {
  const env = githubCommandEnv(o.env ?? process.env, o.passEnv);
  const run = (args: string[]): string => execFileSync(o.ghBin, args, { env, cwd: o.cwd, stdio: "pipe", timeout: 30_000, encoding: "utf8" });
  const fail = (what: string, e: unknown): never => {
    const stderr = String((e as { stderr?: unknown }).stderr ?? "");
    throw new Error(`could not check GitHub for ${what}: ${(stderr || (e instanceof Error ? e.message : String(e))).trim().slice(-200)}`);
  };
  /** The scopes GitHub says the token has (X-OAuth-Scopes), or undefined when it sends none. Throws when the probe itself fails. */
  const tokenScopes = (slug: string): string[] | undefined => {
    let headers: string;
    try {
      headers = run(["api", "-i", "user"]);
    } catch (e) {
      return fail(`a repo named ${slug} (and what the token may read)`, e);
    }
    const line = /^x-oauth-scopes:[ \t]*(.*)$/im.exec(headers.split(/\r?\n\r?\n/, 1)[0] ?? "");
    return line ? line[1]!.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  };
  return (slug) => {
    try {
      run(["repo", "view", slug, "--json", "name"]);
      return true;
    } catch (e) {
      const { status, stderr } = e as { status?: unknown; stderr?: unknown };
      if (status !== 1 || !NOT_FOUND_RE.test(String(stderr ?? ""))) return fail(`a repo named ${slug}`, e);
    }
    const scopes = tokenScopes(slug);
    if (scopes === undefined) {
      throw new GithubNoAccessError(
        `could not check GitHub for a repo named ${slug}: GitHub says it cannot be found, but the token does not say which repos it can read, so it may exist and be hidden from this token. Use a token with the repo scope (gh auth login), or check by hand`,
      );
    }
    if (!scopes.includes("repo")) {
      throw new GithubNoAccessError(
        `could not check GitHub for a repo named ${slug}: GitHub says it cannot be found, but the token has no access to private repos (scopes: ${scopes.join(", ") || "none"}), so it may exist and be hidden from this token. Use a token with the repo scope`,
      );
    }
    return false;
  };
}
