import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { BrainError, type ClaudeCodeBrain } from "./brain.ts";
import type { Datastore, Proposal } from "./datastore.ts";
import { checkDisclosure } from "./disclosure.ts";
import { markClosed, signalGroup } from "./process-group.ts";

/** Where the Build's stream-json lines (and the runner's own `# argus:` notes) go; the War Room tails it. */
export function buildLogPathFor(dataDir: string, proposalId: number): string {
  return join(dataDir, "proposals", String(proposalId), "build.log");
}

export interface BuildRunnerOptions {
  /** Directory holding the Build repos (`~/code`); each Build is `<buildRoot>/<slug>`. */
  buildRoot: string;
  /** Where to clone the template from: a path or URL (`argus-build-template`). */
  templateRepo: string;
  /** argus's data dir (`.data`): the Spec comes from, and the Build log goes under, `proposals/<id>/`. */
  dataDir: string;
  gitBin?: string;
  ghBin?: string;
  wranglerBin?: string;
  /** Where credentials come from; defaults to `process.env`. Each command gets only what it needs, never the lot. */
  env?: NodeJS.ProcessEnv;
  /** Extra variable names every command may inherit (tests point the fakes with these). */
  passEnv?: readonly string[];
  /** For the preview checks and the Cloudflare account check; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Tries (and wait between them) for a fresh preview to respond. Defaults 6 and 5 s. */
  previewAttempts?: number;
  previewDelayMs?: number;
  /** Per git, gh and wrangler command. Default 10 minutes. */
  commandTimeoutMs?: number;
  /** Logs every clone, repo-create, spawn and deploy command and runs none of them. */
  dryRun?: boolean;
  log?: (line: string) => void;
}

export type BuildResult = "built" | "build-failed" | "needs-human" | "dry-run" | "abandoned";
export interface BuildOutcome {
  proposalId: number;
  result: BuildResult;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Paths a Build must leave exactly as the template has them (the template's checks, skill, CI). */
const PROTECTED_PATHS = ["scripts", ".claude", ".github"] as const;
const WORKERS_DEV_URL_RE = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev\b/i;

/** Variables any command may inherit. Credentials are added per command. */
const COMMON_ENV = ["PATH", "HOME", "USER", "LANG", "TMPDIR"];
const GITHUB_ENV = ["GH_TOKEN", "GITHUB_TOKEN"];
const CLOUDFLARE_ENV = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];

/**
 * git run by the runner: hooks and the fsmonitor are switched off and diffs never run external programs. The Build agent can
 * write `.git/config` and `.git/hooks` in its repo, so once it has run, no git command of the runner reads that repo's config
 * at all (see `seal` in build()); GIT_ISOLATION also keeps the machine's own global and system config out of every command.
 */
const SAFE_GIT = ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never"];
const GIT_ISOLATION = { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1" };
const COMMIT_IDENTITY = ["-c", "user.name=argus", "-c", "user.email=argus@localhost", "-c", "commit.gpgsign=false"];

/** The Worker entry point every Build has (the template's `main`) and the compatibility date argus deploys with. */
const WORKER_ENTRY = "src/index.ts";
const COMPATIBILITY_DATE = "2026-11-01";

/**
 * The wrangler config argus deploys with: written by argus, never read from the Build's copy. It names the Worker after the
 * slug and points at the entry point and sets nothing else, so no route, account, binding, asset directory or build command
 * can come from the agent.
 */
export function wranglerConfigFor(slug: string, main: string): string {
  return JSON.stringify({ name: slug, main, compatibility_date: COMPATIBILITY_DATE }, null, 2) + "\n";
}

/** A step that failed, with a message fit for the Proposal's status history. */
class StepError extends Error {}

interface Cmd {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(bin: string, args: string[], o: { cwd?: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal }): Promise<Cmd> {
  return new Promise((resolveCmd) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      // Detached: the command leads its own process group, so killing it also kills anything it started.
      child = spawn(bin, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e) {
      return resolveCmd({ code: null, stdout, stderr: e instanceof Error ? e.message : String(e) });
    }
    const kill = () => signalGroup(child, "SIGKILL");
    const timer = setTimeout(() => {
      stderr += `\n[argus] killed after ${o.timeoutMs} ms`;
      kill();
    }, o.timeoutMs);
    o.signal?.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveCmd({ code: null, stdout, stderr: stderr + e.message });
    });
    child.on("close", (code) => {
      markClosed(child);
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", kill);
      resolveCmd({ code, stdout, stderr });
    });
  });
}

const show = (bin: string, args: readonly string[]) => [bin, ...args].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ");

/** What the final message's last line says (template README, "Runner contract"). Only that line counts. */
export type FinalVerdict = { kind: "ok" } | { kind: "needs-human"; reason: string } | { kind: "failed"; summary: string };

export function classifyFinalMessage(text: string): FinalVerdict {
  const last = text.trimEnd().split("\n").at(-1)?.replace(/\r$/, "") ?? "";
  const marker = /^(ARGUS_NEEDS_HUMAN|ARGUS_BUILD_FAILED)::(.*)$/.exec(last);
  if (!marker) {
    // A marker that is not the whole line (backticks, a prefix, an unknown ARGUS_ line) is a malformed marker, not success.
    if (/ARGUS_(NEEDS_HUMAN|BUILD_FAILED)::/.test(last) || /^ARGUS_[A-Z_]+/.test(last)) {
      return { kind: "failed", summary: `The final line looks like a marker but is malformed: ${JSON.stringify(last.slice(0, 200))}` };
    }
    return { kind: "ok" };
  }
  let body: unknown;
  try {
    body = JSON.parse(marker[2]!);
  } catch {
    return { kind: "failed", summary: `Unparseable ${marker[1]} marker: ${JSON.stringify(last.slice(0, 200))}` };
  }
  const field = marker[1] === "ARGUS_NEEDS_HUMAN" ? "reason" : "summary";
  const value = (body as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string" || !value.trim()) {
    return { kind: "failed", summary: `${marker[1]} marker has no "${field}": ${JSON.stringify(last.slice(0, 200))}` };
  }
  return marker[1] === "ARGUS_NEEDS_HUMAN" ? { kind: "needs-human", reason: value.trim() } : { kind: "failed", summary: value.trim() };
}

const stableScripts = (pkg: string): string => {
  const scripts = (JSON.parse(pkg) as { scripts?: Record<string, unknown> }).scripts ?? {};
  return JSON.stringify(Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b)));
};

const COMMIT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The commit a Build repo's HEAD points at, read from the files in `.git` without running git: git would read the repo's
 * config, which the Build agent could have written. Handles a detached HEAD, a loose branch ref and `packed-refs`.
 */
export function readHeadCommit(repo: string): string {
  const gitDir = join(repo, ".git");
  let head: string;
  try {
    head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    throw new StepError("the Build repo's .git/HEAD could not be read");
  }
  if (COMMIT_ID_RE.test(head)) return head;
  const ref = /^ref: (refs\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
  if (!ref || ref.includes("..")) throw new StepError(`the Build repo's HEAD is not a branch or a commit: ${JSON.stringify(head.slice(0, 100))}`);
  try {
    const loose = readFileSync(join(gitDir, ref), "utf8").trim();
    if (COMMIT_ID_RE.test(loose)) return loose;
  } catch {
    // not a loose ref: look in packed-refs
  }
  try {
    for (const line of readFileSync(join(gitDir, "packed-refs"), "utf8").split("\n")) {
      const m = /^([0-9a-f]{40,64}) (\S+)$/.exec(line);
      if (m && m[2] === ref && COMMIT_ID_RE.test(m[1]!)) return m[1]!;
    }
  } catch {
    // no packed-refs
  }
  throw new StepError(`could not resolve ${ref} in the Build repo`);
}

/** The next Proposal to build: oldest approval first (ties by id); none while a Build is running. */
export function nextBuildable(store: Datastore): Proposal | undefined {
  const all = store.listProposals();
  if (all.some((p) => p.status === "building")) return undefined;
  return all
    .filter((p) => p.status === "approved")
    .sort((a, b) => (a.approvedAt ?? "").localeCompare(b.approvedAt ?? "") || a.id - b.id)[0];
}

/**
 * Builds the next approved Proposal, if the Build slot is free: one Build at a time, FIFO by approval time. Resolves with
 * what happened, or undefined when there was nothing to do.
 *
 * The slot is taken synchronously (approved -> building, with the brain run opened in the same transaction) before anything
 * else, so a second call while a Build runs sees `building` and does nothing. Every status change goes through
 * `store.transition`/`completeBuild`.
 */
export async function runNextBuild(
  store: Datastore,
  brain: ClaudeCodeBrain,
  o: BuildRunnerOptions,
  signal?: AbortSignal,
): Promise<BuildOutcome | undefined> {
  if (signal?.aborted) return undefined;
  const proposal = nextBuildable(store);
  if (!proposal) return undefined;
  if (o.dryRun) return dryRun(brain, o, proposal);
  const runId = store.beginBuild(proposal.id, brain.routeFor("build"));
  return build(store, brain, o, store.getProposal(proposal.id)!, runId, signal);
}

/** One worker pass: build until the queue is empty (a dry run reports the next Build once and stops). */
export async function runPendingBuilds(store: Datastore, brain: ClaudeCodeBrain, o: BuildRunnerOptions, signal?: AbortSignal): Promise<number> {
  let n = 0;
  for (;;) {
    const outcome = await runNextBuild(store, brain, o, signal);
    if (!outcome || outcome.result === "dry-run") return n;
    n++;
    (o.log ?? console.log)(`[worker] build for proposal ${outcome.proposalId}: ${outcome.result}`);
  }
}

function dryRun(brain: ClaudeCodeBrain, o: BuildRunnerOptions, p: Proposal): BuildOutcome {
  const log = o.log ?? console.log;
  const repo = join(o.buildRoot, p.slug);
  const say = (bin: string, args: string[]) => log(`[build ${p.id}] dry-run: ${show(bin, args)}`);
  say("curl", ["-H", "Authorization: Bearer <token>", `https://api.cloudflare.com/client/v4/accounts/<account>/workers/scripts/${p.slug}/settings`]);
  say(o.gitBin ?? "git", ["clone", "--origin", "template", o.templateRepo, repo]);
  say(o.ghBin ?? "gh", ["repo", "create", p.slug, "--private", "--source", ".", "--remote", "origin"]);
  say(o.gitBin ?? "git", ["push", "<origin>", "<commit>:refs/heads/<branch>"]);
  const args = brain.buildArgs("build", { prompt: String(p.id), slash: "implement-spec" });
  log(`[build ${p.id}] dry-run: claude (cwd ${repo}) ${args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
  say(o.wranglerBin ?? "wrangler", ["deploy", "--name", p.slug, "--config", "<argus-seal>/wrangler.jsonc"]);
  return { proposalId: p.id, result: "dry-run" };
}

async function build(store: Datastore, brain: ClaudeCodeBrain, o: BuildRunnerOptions, p: Proposal, runId: number, signal?: AbortSignal): Promise<BuildOutcome> {
  const id = p.id;
  const logSink = (o.log ?? console.log) as (line: string) => void;
  const logPath = buildLogPathFor(o.dataDir, id);
  const repo = resolve(o.buildRoot, p.slug);
  let midLine = false;
  const append = (text: string) => {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, text);
    midLine = !text.endsWith("\n");
  };
  const note = (line: string) => {
    logSink(`[build ${id}] ${line}`);
    append(`${midLine ? "\n" : ""}# argus: ${line.replace(/\n/g, " ")}\n`);
  };

  // The run row (opened with the slot, by beginBuild) stays open until the Build is over: a worker that dies at any point,
  // deploy and preview checks included, leaves an open row for the sweep to find, and the Build slot is freed with it.
  // What the row closes with is fixed once claude finishes (its session, spend and exit); until then a failure closes it as such.
  let runEnd: { sessionId: string | null; totalCostUsd: number; exitStatus: string } | undefined;
  const closeRun = () => {
    store.finishBrainRun(runId, runEnd ?? { sessionId: null, totalCostUsd: 0, exitStatus: "failed" });
  };
  /** Marks the Proposal failed first, then the run closes (in `finally`): the run is open for as long as the Proposal is `building`. */
  const fail = (reason: string, exitStatus = "failed"): BuildOutcome => {
    note(`Build failed: ${reason}`);
    runEnd ??= { sessionId: null, totalCostUsd: 0, exitStatus };
    if (store.getProposal(id)?.status === "building") store.transition(id, "build-failed", "build", `Build failed: ${reason}`.slice(0, 500));
    return { proposalId: id, result: "build-failed" };
  };

  const source = o.env ?? process.env;
  const pick = (names: readonly string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const n of [...COMMON_ENV, ...(o.passEnv ?? []), ...names]) if (source[n] !== undefined) out[n] = source[n]!;
    return out;
  };
  const gitEnv = { ...pick([]), ...GIT_ISOLATION };
  const pushEnv = { ...pick(GITHUB_ENV), ...GIT_ISOLATION };
  const ghEnv = pick(GITHUB_ENV);
  const wranglerEnv = { ...pick(CLOUDFLARE_ENV), CI: "1", WRANGLER_SEND_METRICS: "false" };
  const timeoutMs = o.commandTimeoutMs ?? 10 * 60_000;
  const git = o.gitBin ?? "git";
  const gh = o.ghBin ?? "gh";

  /** Runs one command; a non-zero exit throws a StepError carrying the tail of its stderr. */
  const step = async (label: string, bin: string, args: string[], env: Record<string, string>, cwd?: string): Promise<string> => {
    note(`$ ${show(bin, args)}${cwd ? ` (cwd ${cwd})` : ""}`);
    const r = await runCommand(bin, args, { cwd, env, timeoutMs, signal });
    if (r.code !== 0) throw new StepError(`${label} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-300)}`);
    return r.stdout.trim();
  };
  const inRepo = (label: string, ...args: string[]) => step(label, git, [...SAFE_GIT, ...args], gitEnv, repo);
  /** Pushes `commit` to `branch` at `url` (both recorded by argus before the agent ran), with gh as the credential helper. */
  const push = (cwd: string, url: string, commit: string, branch: string) =>
    step(
      "git push",
      git,
      [...SAFE_GIT, "-c", "credential.helper=", "-c", `credential.helper=!'${gh.replace(/'/g, "'\\''")}' auth git-credential`, "push", "--quiet", url, `${commit}:refs/heads/${branch}`],
      pushEnv,
      cwd,
    );

  /** Never deploys over a Worker that is already in the account: the name is the slug, and an existing one is someone's. */
  const requireFreeWorkerName = async () => {
    const account = source.CLOUDFLARE_ACCOUNT_ID;
    const token = source.CLOUDFLARE_API_TOKEN;
    if (!account || !token) throw new StepError("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are needed to check that the Worker name is free");
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(p.slug)}/settings`;
    let res: Response;
    try {
      res = await (o.fetch ?? fetch)(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new StepError(`could not check the Cloudflare account for a Worker named ${p.slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 200) throw new StepError(`a Worker named ${p.slug} already exists in the Cloudflare account; refusing to overwrite it`);
    // Only Cloudflare's own "no such Worker" answer (error 10007) counts as free; any other reply is not an answer.
    let notFound = false;
    if (res.status === 404) {
      try {
        notFound = ((await res.json()) as { errors?: { code?: number }[] }).errors?.some((e) => e.code === 10007) === true;
      } catch {
        // not JSON: not the API's answer
      }
    }
    if (!notFound) throw new StepError(`could not check the Cloudflare account for a Worker named ${p.slug} (HTTP ${res.status})`);
  };

  // Scratch space for after the agent has run: a git directory of argus's own, and the wrangler config.
  let seal: string | undefined;
  try {
    if (signal?.aborted) return fail("the worker is stopping", "interrupted");
    if (!SLUG_RE.test(p.slug) || p.slug.length > 63) return fail(`invalid slug ${JSON.stringify(p.slug)}`);
    if (existsSync(repo)) return fail(`${repo} already exists; refusing to build over it`);
    let spec: string;
    try {
      spec = readFileSync(p.specPath ?? "", "utf8");
    } catch {
      return fail("the Spec file could not be read");
    }

    // Setup: the Worker name checked, the template clone, a private GitHub repo, the Spec and the slug written in and committed.
    note(`Build starts for ${p.name} (${p.slug})`);
    await requireFreeWorkerName();
    mkdirSync(o.buildRoot, { recursive: true });
    await step("git clone", git, [...SAFE_GIT, "clone", "--origin", "template", o.templateRepo, repo], gitEnv, o.buildRoot);
    const templateCommit = await inRepo("git rev-parse", "rev-parse", "HEAD");
    const branch = await inRepo("git rev-parse", "rev-parse", "--abbrev-ref", "HEAD");
    if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch === "HEAD") throw new StepError(`the template checkout is not on a branch (${JSON.stringify(branch)})`);
    await step("gh repo create", gh, ["repo", "create", p.slug, "--private", "--source", ".", "--remote", "origin"], ghEnv, repo);
    // From here on the repo's own settings are the agent's to change, so the remote is read once now and used by URL.
    const originUrl = await inRepo("git remote", "remote", "get-url", "origin");
    writeFileSync(join(repo, "SPEC.md"), spec.endsWith("\n") ? spec : spec + "\n");
    writeFileSync(join(repo, "wrangler.jsonc"), wranglerConfigFor(p.slug, WORKER_ENTRY));
    await inRepo("git add", "add", "SPEC.md", "wrangler.jsonc");
    await inRepo("git commit", ...COMMIT_IDENTITY, "commit", "--quiet", "-m", `Add Spec for ${p.name}`);
    const specCommit = await inRepo("git rev-parse", "rev-parse", "HEAD");
    await push(repo, originUrl, specCommit, branch);

    // The claude run.
    if (signal?.aborted) return fail("the worker is stopping", "interrupted");
    note(`Starting claude in ${repo}`);
    let run;
    try {
      run = await brain.run<string>("build", { prompt: String(id), slash: "implement-spec" }, { cwd: repo, signal, onOutput: append });
    } catch (e) {
      const be = e instanceof BrainError ? e : undefined;
      // Spend first: whatever the run cost is recorded before anything else happens.
      runEnd = { sessionId: be?.sessionId ?? null, totalCostUsd: be?.totalCostUsd ?? 0, exitStatus: be?.kind ?? "failed" };
      const why = e instanceof Error ? e.message : String(e);
      return fail(be?.kind === "interrupted" ? "interrupted by the worker shutting down" : `claude ${be?.kind ?? "failed"}: ${why}`, be?.kind ?? "failed");
    }
    if (run.dryRun) return fail("the brain is in dry-run mode but the Build Runner is not");
    // The spend is on the card now, while the run stays open for the deploy and the checks.
    runEnd = { sessionId: run.sessionId ?? null, totalCostUsd: run.totalCostUsd, exitStatus: "success" };
    store.recordBrainRunSpend(runId, runEnd);
    note(`claude finished (session ${run.sessionId ?? "none"}, est. usage $${run.totalCostUsd.toFixed(4)})`);

    if (store.getProposal(id)?.status !== "building") {
      note("The Proposal is no longer building (dismissed meanwhile); nothing more is done");
      return { proposalId: id, result: "abandoned" };
    }

    // Success is decided here, by argus, from the repo and the final message; never from the Build's own checks.
    const verdict = classifyFinalMessage(run.output);
    if (verdict.kind === "needs-human") {
      note(`The Spec needs a human: ${verdict.reason}`);
      store.transition(id, "needs-human", "build", `Spec needs a human: ${verdict.reason}`.slice(0, 500));
      return { proposalId: id, result: "needs-human" };
    }
    if (verdict.kind === "failed") return fail(`the Build reported failure: ${verdict.summary}`);

    // The seal: a git directory of argus's own whose only link to the Build repo is its object store (read through
    // `objects/info/alternates`). The agent's .git/config, hooks, attributes drivers and refs are never read, so nothing it
    // planted there can run, and the push below comes from here, to the origin recorded before the agent ran.
    const head = readHeadCommit(repo);
    seal = mkdtempSync(join(tmpdir(), "argus-seal-"));
    const sealGit = join(seal, ".git");
    await step("git init", git, [...SAFE_GIT, "init", "--quiet", seal], gitEnv, seal);
    writeFileSync(join(sealGit, "objects", "info", "alternates"), join(repo, ".git", "objects") + "\n");
    const sealed = (label: string, ...args: string[]) => step(label, git, [...SAFE_GIT, ...args], gitEnv, seal);
    if (!COMMIT_ID_RE.test(head)) return fail("HEAD is not a commit");
    await sealed("git cat-file", "cat-file", "-e", `${head}^{commit}`);
    if (head === specCommit) return fail("HEAD has not advanced past the Spec commit (nothing was committed)");
    const ancestor = await runCommand(git, [...SAFE_GIT, "merge-base", "--is-ancestor", specCommit, head], { cwd: seal, env: gitEnv, timeoutMs, signal });
    if (ancestor.code !== 0) return fail("HEAD is not a descendant of the Spec commit (history was rewritten)");
    // Is the working tree clean against HEAD? The seal's git directory with the Build repo as work tree: the index is read
    // from HEAD's tree, so the tree is compared by content, and no filter or attribute driver is defined to run.
    const onTree = { ...gitEnv, GIT_DIR: sealGit, GIT_WORK_TREE: repo };
    await sealed("git update-ref", "update-ref", "--no-deref", "HEAD", head);
    await step("git read-tree", git, [...SAFE_GIT, "read-tree", head], onTree, repo);
    const dirty = await step("git status", git, [...SAFE_GIT, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=all"], onTree, repo);
    if (dirty) return fail(`the working tree is not clean: ${dirty.split("\n").slice(0, 5).join("; ")}`);
    const changed = await sealed("git diff", "diff", "--name-only", "--no-renames", "--no-ext-diff", templateCommit, head, "--", ...PROTECTED_PATHS);
    if (changed) return fail(`protected paths differ from the template: ${changed.split("\n").slice(0, 5).join(", ")}`);
    try {
      const was = stableScripts(await sealed("git show", "show", `${templateCommit}:package.json`));
      const now = stableScripts(await sealed("git show", "show", `${head}:package.json`));
      if (was !== now) return fail("the scripts field of package.json differs from the template");
    } catch (e) {
      if (e instanceof StepError) throw e;
      return fail("package.json could not be read or parsed");
    }

    // Deploy with the global wrangler (never the repo's node_modules), under the slug, with a config argus wrote. The entry
    // point must be a real file inside the repo: a symlink would let the Worker bundle any file the Operator can read.
    let main: string;
    try {
      main = realpathSync(join(repo, WORKER_ENTRY));
      if (!main.startsWith(realpathSync(repo) + sep) || !statSync(main).isFile()) throw new Error("outside the repo");
    } catch {
      return fail(`${WORKER_ENTRY} is missing or is not a file inside the repo; refusing to deploy`);
    }
    const configPath = join(seal, "wrangler.jsonc");
    writeFileSync(configPath, wranglerConfigFor(p.slug, main));
    await requireFreeWorkerName();
    const deployed = await step("wrangler deploy", o.wranglerBin ?? "wrangler", ["deploy", "--name", p.slug, "--config", configPath], wranglerEnv, repo);
    const url = WORKERS_DEV_URL_RE.exec(deployed)?.[0];
    if (!url) return fail("wrangler deploy printed no workers.dev URL");
    note(`Deployed to ${url}; checking the preview`);
    const check = await checkDisclosure(url, o.fetch ?? fetch, { attempts: o.previewAttempts, delayMs: o.previewDelayMs });
    if (!check.ok) {
      return fail(`the preview at ${url} failed verification (it is still deployed): ${check.problems.slice(0, 5).join("; ")}`);
    }
    note(`Preview verified: disclosure on ${check.pages} page(s)`);
    try {
      store.completeBuild(id, { previewUrl: url });
    } catch (e) {
      note(`Could not mark the Proposal built: ${e instanceof Error ? e.message : String(e)}`);
      return { proposalId: id, result: "abandoned" };
    }
    // The repo holds the built code; a failed push does not undo a verified preview.
    try {
      await push(seal, originUrl, head, branch);
    } catch (e) {
      note(`Warning: ${e instanceof Error ? e.message : String(e)}`);
    }
    note("Build done");
    return { proposalId: id, result: "built" };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    if (seal) rmSync(seal, { recursive: true, force: true });
    closeRun();
  }
}
