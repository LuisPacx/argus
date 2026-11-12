import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { removeTree } from "./build-home.ts";
import { BRAIN_RUN_IN_FLIGHT, type Datastore, type Proposal } from "./datastore.ts";
import { DomainError, type Command, type ProposalStatus } from "./lifecycle.ts";

/**
 * "Clean up build": removes what a dead Build left outside argus (its Cloudflare Worker, its private GitHub repo and its checkout
 * under the build root) and records it. The worker applies it as the `cleanup-build` command; the War Room only reads the plan.
 *
 * argus deletes only what it can show it made. Each artifact has its own ownership check, and a check that fails leaves the artifact
 * and says why. Nothing here is reachable for a Proposal that was ever launched (`cleanupRefusal`). Every network call goes through the
 * injected `fetch`, every `gh` call through the injected token source, so tests never touch a real service.
 */

/** The statuses a Build may be cleaned up from. `built` is dismissed first; `launched` is never cleaned. */
export const CLEANUP_STATUSES: readonly ProposalStatus[] = ["dismissed", "closed", "build-failed"];

/** The slug rule the Build uses (`SLUG_RE` in build-runner.ts) plus its 63-character cap. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const validSlug = (slug: string): boolean => SLUG_RE.test(slug) && slug.length <= 63;

/** `owner/name` of a github.com remote URL (https, scp-like or ssh), or null. */
export function parseGithubRepo(url: string): string | null {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The remotes in a checkout's `.git/config`, read as text (git is not run: a Build's agent can write that file). Null when `.git` is
 * not a real directory holding a real config file. A remote with several `url` lines has all of them.
 */
function readRemotes(dir: string): Map<string, string[]> | null {
  let text: string;
  try {
    const gitDir = join(dir, ".git");
    const config = join(gitDir, "config");
    if (!lstatSync(gitDir).isDirectory()) return null;
    const st = lstatSync(config);
    if (!st.isFile() || st.size > 1_000_000) return null;
    text = readFileSync(config, "utf8");
  } catch {
    return null;
  }
  const remotes = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      const m = /^\[remote "([^"\\]+)"\]$/.exec(line);
      current = null;
      if (m) {
        current = remotes.get(m[1]!) ?? [];
        remotes.set(m[1]!, current);
      }
      continue;
    }
    const u = /^url\s*=\s*(.+)$/.exec(line);
    if (u && current) current.push(u[1]!.trim());
  }
  return remotes;
}

/**
 * `owner/slug` named by the checkout's `origin` remote, when the checkout looks like a Build's (a `template` remote as well: the
 * Build clones with `--origin template`) and `origin` has exactly one url that names a github.com repo called `slug`. Else null.
 */
function originRepo(dir: string, slug: string): string | null {
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
  } catch {
    return null;
  }
  const remotes = readRemotes(dir);
  const urls = remotes?.get("origin");
  if (!remotes || !remotes.has("template") || urls?.length !== 1) return null;
  const repo = parseGithubRepo(urls[0]!);
  return repo !== null && repo.split("/")[1] === slug ? repo : null;
}

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** What a clean-up would remove, from argus's own records and a read-only look at the disk: no network, no credentials. */
export interface CleanupPlan {
  worker: { name: string; found: boolean };
  /** `name` is the recorded `owner/slug`, else the one the checkout's origin names (a `legacy` repo, removed only on a typed confirmation); null when neither. */
  repo: { name: string | null; found: boolean; legacy: boolean };
  /** `removable`: argus can show the directory is this Build's checkout (a real directory whose origin is this Build's repo). A directory that is `found` but not `removable` (the Build failed before the repo was created, or it is not a plain Build checkout) is never removed by argus: the Operator removes it by hand. */
  directory: { path: string; found: boolean; removable: boolean };
}

export function cleanupPlan(p: Proposal, buildRoot: string): CleanupPlan {
  const path = join(resolve(buildRoot), p.slug);
  const ok = validSlug(p.slug);
  const origin = ok ? originRepo(path, p.slug) : null;
  const name = p.buildRepo ?? origin;
  const removable = origin !== null && (p.buildRepo === null || origin.toLowerCase() === p.buildRepo.toLowerCase());
  return {
    worker: { name: p.slug, found: p.workerDeployed },
    repo: { name, found: name !== null, legacy: p.buildRepo === null && name !== null },
    directory: { path, found: ok && exists(path), removable },
  };
}

/**
 * Why a Proposal's Build may not be cleaned up, or null when it may. Only a dismissed, closed or build-failed Proposal that has an
 * artifact, and never one that was ever launched: not by its status (a `closed` or `dismissed` one may have been launched) but by its
 * history and its mint.
 */
export function cleanupRefusal(store: Pick<Datastore, "historyFor" | "brainRunsFor">, p: Proposal, buildRoot: string): string | null {
  if (p.status === "launched") return "Clean up build is never done for a launched Proposal: its site stays up";
  if (!CLEANUP_STATUSES.includes(p.status)) return `Clean up build needs a dismissed, closed or build-failed Proposal (it is ${p.status}; dismiss it first)`;
  if (p.mint !== null || store.historyFor(p.id).some((h) => h.to === "launched")) return "Clean up build is never done for a Proposal that was launched: its site stays up";
  // Dismissing a `building` Proposal stops its Build, but not at once: the runner notices on its next step or poll. The Build's run row
  // (opened by beginBuild, closed by the runner when it ends, and marked interrupted by the stale sweep if its worker died) is the one
  // signal that the runner has stopped, and it outlives the status: so a dismissed Proposal is cleaned only once that row is closed.
  if (store.brainRunsFor(p.id).some((r) => r.task === "build" && r.exitStatus === BRAIN_RUN_IN_FLIGHT)) {
    return "A Build is still running for this Proposal (it was dismissed while building); clean up once it has stopped";
  }
  const plan = cleanupPlan(p, buildRoot);
  if (!plan.directory.found && p.buildRepo === null && !p.workerDeployed) return "Nothing to clean up: no checkout, repo or Worker is recorded for this Build";
  return null;
}

export type CleanupArtifact = "worker" | "repo" | "directory";
export type CleanupOutcome = "deleted" | "already gone" | "skipped" | "failed";

export interface CleanupResult {
  artifact: CleanupArtifact;
  /** The Worker name, `owner/slug` or directory path. */
  target: string;
  outcome: CleanupOutcome;
  /** Why it was skipped or failed; empty otherwise. */
  detail: string;
  /** Nothing of the Build's is left in this place for argus to remove (deleted, already gone, or skipped because there was nothing of ours). */
  clear: boolean;
}

/** The one-line form recorded in `status_history` and shown on the page. */
export function cleanupLine(r: CleanupResult): string {
  const what = r.artifact === "worker" ? "Worker" : r.artifact === "repo" ? "repo" : "directory";
  const how = r.outcome === "skipped" ? `skipped (not ours: ${r.detail})` : r.outcome === "failed" ? `failed: ${r.detail}` : r.outcome;
  return `Clean up: ${what} ${r.target} ${how}`;
}

const GH_FIX = "gh auth refresh -h github.com -s delete_repo";

export interface CleanupOptions {
  buildRoot: string;
  /** Credential source (the worker passes the process environment plus the two Cloudflare keys from `.env`). */
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** The GitHub token: defaults to `GH_TOKEN` / `GITHUB_TOKEN` from `env`, else `gh auth token`. Tests inject one. */
  githubToken?: () => string | undefined;
  ghBin?: string;
  log?: (line: string) => void;
}

export interface CleanupRun {
  results: CleanupResult[];
  /** True when every artifact is clear: this is what `build_cleaned` records. */
  cleaned: boolean;
  /** A legacy repo that was removed (or found gone): kept on the row so a second run can say it is gone. */
  repoToRecord?: string;
}

/** `text` with every secret (raw or URL-encoded) replaced. */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s) for (const t of new Set([s, encodeURIComponent(s)])) out = out.split(t).join("[redacted]");
  return out;
}

function defaultGithubToken(env: NodeJS.ProcessEnv, ghBin: string): string | undefined {
  const fromEnv = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    // The same allowlist the Build's own `gh` calls get: common variables, no credential but the GitHub token (none is set here).
    const ghEnv: Record<string, string> = {};
    for (const k of ["PATH", "HOME", "USER", "LANG", "TMPDIR"]) if (env[k] !== undefined) ghEnv[k] = env[k]!;
    const out = execFileSync(ghBin, ["auth", "token"], { env: ghEnv, stdio: "pipe", timeout: 30_000, encoding: "utf8" }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Removes the Worker, then the repo, then the directory (last: its origin remote is the ownership proof for a legacy repo). Each
 * step is independent and never throws; `typedName` is what the Operator typed in the dialog (needed only for a legacy repo).
 * `p` must already have passed `cleanupRefusal`.
 */
export async function cleanupBuild(p: Proposal, o: CleanupOptions, typedName = ""): Promise<CleanupRun> {
  const doFetch = o.fetch ?? fetch;
  const ghBin = o.ghBin ?? "gh";
  // Read once, up front, so that every message of the run can be scrubbed of it.
  const ghToken = (o.githubToken ?? (() => defaultGithubToken(o.env, ghBin)))();
  const githubToken = (): string | undefined => ghToken;
  const safe = (text: string) => redactSecrets(text, [o.env.CLOUDFLARE_API_TOKEN, o.env.GH_TOKEN, o.env.GITHUB_TOKEN, ghToken]);
  const call = async (url: string, init: RequestInit): Promise<Response> => doFetch(url, { ...init, signal: AbortSignal.timeout(30_000) });

  const root = resolve(o.buildRoot);
  const dirPath = join(root, p.slug);
  const slugOk = validSlug(p.slug);
  const plan = cleanupPlan(p, o.buildRoot);
  const result = (artifact: CleanupArtifact, target: string, outcome: CleanupOutcome, detail = "", clear = outcome === "deleted" || outcome === "already gone"): CleanupResult => ({
    artifact,
    target,
    outcome,
    detail: safe(detail),
    clear,
  });
  const attempt = async (artifact: CleanupArtifact, target: string, step: () => Promise<CleanupResult>): Promise<CleanupResult> => {
    try {
      return await step();
    } catch (e) {
      return result(artifact, target, "failed", e instanceof Error ? e.message : String(e));
    }
  };

  // Worker: only the one this Build's own `wrangler deploy` made, under exactly the slug.
  const worker = await attempt("worker", p.slug, async () => {
    if (!slugOk) return result("worker", p.slug, "skipped", "the slug is not a valid Build slug", false);
    if (!p.workerDeployed) return result("worker", p.slug, "skipped", "this Build did not deploy a Worker", true);
    const account = o.env.CLOUDFLARE_ACCOUNT_ID;
    const token = o.env.CLOUDFLARE_API_TOKEN;
    if (!account || !token) return result("worker", p.slug, "failed", "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are needed (the token needs Workers Scripts: Edit)");
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(p.slug)}`;
    const res = await call(url, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    if (res.status === 200) return result("worker", p.slug, "deleted");
    if (res.status === 404) {
      let code: number | undefined;
      try {
        code = ((await res.json()) as { errors?: { code?: number }[] }).errors?.find((e) => e.code === 10007)?.code;
      } catch {
        // not the API's answer
      }
      if (code === 10007) return result("worker", p.slug, "already gone");
    }
    if (res.status === 401 || res.status === 403) {
      return result("worker", p.slug, "failed", `Cloudflare refused the delete (HTTP ${res.status}): check CLOUDFLARE_API_TOKEN (it needs Workers Scripts: Edit) and CLOUDFLARE_ACCOUNT_ID`);
    }
    return result("worker", p.slug, "failed", `Cloudflare answered HTTP ${res.status}`);
  });

  // Repo: the recorded `owner/slug`, or a legacy one named by the checkout's origin and confirmed by typing its name.
  let repoToRecord: string | undefined;
  const repoName = plan.repo.name;
  const repoOutcome = await attempt("repo", repoName ?? p.slug, async () => {
    if (!slugOk) return result("repo", p.slug, "skipped", "the slug is not a valid Build slug", false);
    if (repoName === null) return result("repo", p.slug, "skipped", "no repo is recorded for this Build and its checkout names none to prove one; delete it by hand if it exists", true);
    const [owner, name] = repoName.split("/") as [string, string];
    if (name !== p.slug) return result("repo", repoName, "skipped", "the repo name is not the slug", false);
    const token = githubToken();
    if (!token) return result("repo", repoName, "failed", "no GitHub token (set GH_TOKEN or run gh auth login), then Clean up build again");
    const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "argus", "x-github-api-version": "2022-11-28" };
    if (plan.repo.legacy) {
      // The checkout's origin is the agent's to edit, so the owner is checked against the account the token belongs to.
      if (typedName.trim() !== repoName) return result("repo", repoName, "skipped", `a Build from before repos were recorded: type ${repoName} in the dialog to confirm`, false);
      const me = await call("https://api.github.com/user", { headers });
      if (me.status !== 200) return result("repo", repoName, "failed", `GitHub answered HTTP ${me.status} when asked who the token belongs to`);
      const login = ((await me.json()) as { login?: unknown }).login;
      if (typeof login !== "string" || login.toLowerCase() !== owner.toLowerCase()) return result("repo", repoName, "skipped", "the checkout's origin names a repo of another account", false);
    }
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const got = await call(url, { headers });
    if (got.status === 404) {
      // GitHub answers a token that cannot see a private repo with the same 404 as for a missing one. For a repo argus recorded, that is
      // taken as gone; for a legacy repo it proves nothing, so it is a failure and the checkout stays.
      if (plan.repo.legacy) return result("repo", repoName, "failed", "GitHub answered 404 for the repo: it may be gone, or the token may not be able to see it. Check by hand, then Clean up build again");
      return result("repo", repoName, "already gone");
    }
    if (got.status !== 200) return result("repo", repoName, "failed", `GitHub answered HTTP ${got.status} when the repo was read; check the token (gh auth status)`);
    const body = (await got.json()) as { private?: unknown; full_name?: unknown };
    if (typeof body.full_name !== "string" || body.full_name.toLowerCase() !== repoName.toLowerCase()) return result("repo", repoName, "skipped", "GitHub names a different repo (it was renamed or moved)", false);
    if (body.private !== true) return result("repo", repoName, "skipped", "the repo is not private", false);
    const del = await call(url, { method: "DELETE", headers });
    if (del.status === 204 || del.status === 200) {
      if (plan.repo.legacy) repoToRecord = repoName;
      return result("repo", repoName, "deleted");
    }
    if (del.status === 404) {
      if (plan.repo.legacy) repoToRecord = repoName;
      return result("repo", repoName, "already gone");
    }
    if (del.status === 403 || del.status === 401) {
      return result("repo", repoName, "failed", `GitHub refused the delete (HTTP ${del.status}: the token lacks admin rights or the delete_repo scope). Run: ${GH_FIX}, then Clean up build again`);
    }
    return result("repo", repoName, "failed", `GitHub answered HTTP ${del.status} to the delete`);
  });

  // Directory: a real directory (not a symlink) directly under the build root, a Build checkout whose origin is this Build's repo.
  const directory = await attempt("directory", dirPath, async () => {
    if (!slugOk) return result("directory", dirPath, "skipped", "the slug is not a valid Build slug", false);
    let st;
    try {
      st = lstatSync(dirPath);
    } catch {
      return result("directory", dirPath, "already gone");
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return result("directory", dirPath, "skipped", "it is not a plain directory (a symlink or a file)", false);
    if (realpathSync(dirPath) !== join(realpathSync(root), p.slug)) return result("directory", dirPath, "skipped", "it is not directly under the build root", false);
    const origin = originRepo(dirPath, p.slug);
    if (origin === null) return result("directory", dirPath, "skipped", "its origin remote does not name a repo called the slug, or it is not a Build checkout", false);
    if (p.buildRepo !== null) {
      if (origin.toLowerCase() !== p.buildRepo.toLowerCase()) return result("directory", dirPath, "skipped", `its origin is ${origin}, not this Build's repo ${p.buildRepo}`, false);
    } else if (!(repoOutcome.outcome === "deleted" || repoOutcome.outcome === "already gone")) {
      // A legacy Build: the origin is the only proof of the repo, so the checkout stays until the repo is dealt with.
      return result("directory", dirPath, "skipped", "kept: its origin is the only proof of the legacy repo, which is still there", false);
    }
    const error = removeTree(dirPath);
    return error ? result("directory", dirPath, "failed", error) : result("directory", dirPath, "deleted");
  });

  const results = [worker, repoOutcome, directory];
  return { results, cleaned: results.every((r) => r.clear), repoToRecord };
}

export interface PendingCleanupOptions extends CleanupOptions {
  /** `onError` is told of a command that hit a non-domain error (it is retried like any other). */
  onError?: (command: Command, error: unknown) => void;
}

/**
 * Applies the pending `cleanup-build` commands, in order, and returns how many were resolved. Async because it reaches Cloudflare and
 * GitHub, so `applyPendingCommands` leaves these to it. A refused command (wrong status, launched, nothing to clean) is rejected with
 * a DomainError before anything is touched. The command's `reason` is the repo name the Operator typed (legacy Builds only).
 */
export async function runPendingCleanups(store: Datastore, o: PendingCleanupOptions): Promise<number> {
  let n = 0;
  for (const c of store.pendingCommands()) {
    if (c.type !== "cleanup-build") continue;
    try {
      const p = store.getProposal(c.proposalId);
      const refusal = p ? cleanupRefusal(store, p, o.buildRoot) : `Proposal ${c.proposalId} not found`;
      if (!p || refusal !== null) {
        store.resolveCommand(c.id, () => {
          throw new DomainError(refusal ?? "Proposal not found");
        });
        n++;
        continue;
      }
      // The claim keeps a re-queue (or another clean-up, in another worker process) from running while this one applies. If the Proposal
      // moved on since the check above, or another clean-up holds it, the command stays pending: the next pass decides it.
      const claimedAt = new Date();
      if (!store.beginCleanup(p.id, CLEANUP_STATUSES, claimedAt)) {
        o.log?.(`[worker] clean-up of proposal ${p.id} not started: another clean-up holds it, or it is no longer ${CLEANUP_STATUSES.join(", ")}; left pending`);
        continue;
      }
      try {
        let run: CleanupRun;
        try {
          run = await cleanupBuild(p, o, c.reason);
        } catch (e) {
          store.resolveCommand(c.id, () => {
            throw e;
          });
          continue;
        }
        for (const r of run.results) o.log?.(`[worker] ${cleanupLine(r)}`);
        store.resolveCommand(c.id, () => store.recordCleanup(p.id, run.results.map(cleanupLine), run.cleaned, run.repoToRecord));
        n++;
      } finally {
        store.endCleanup(p.id, claimedAt);
      }
    } catch (e) {
      o.onError?.(c, e);
    }
  }
  return n;
}
