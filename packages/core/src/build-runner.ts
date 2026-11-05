import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { BrainError, type ClaudeCodeBrain } from "./brain.ts";
import type { Datastore, Proposal } from "./datastore.ts";
import { checkDisclosure } from "./disclosure.ts";
import { markClosed, signalGroup } from "./process-group.ts";
import { needsHumanSpecReason } from "./spec-drafting.ts";
import { ownerState, type ReadProcStat, type SandboxJob, type SandboxRunner } from "./sandbox.ts";

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
  /**
   * Where agent-influenced code runs: the claude run, the dependency install and the dry-run bundle are containers (containment
   * design). Required: there is no uncontained Build; only `--dry-run` runs without touching it.
   */
  sandbox: SandboxRunner;
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
  /** How often the Build's run row is touched to show the worker is alive (the stale sweep counts from it). Default 60 s. */
  heartbeatMs?: number;
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

/** The allowlisted environment of a child command: COMMON_ENV, the injected `passEnv` names and `names`, taken from `source`. */
function pickEnv(source: NodeJS.ProcessEnv, passEnv: readonly string[] | undefined, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of [...COMMON_ENV, ...(passEnv ?? []), ...names]) if (source[n] !== undefined) out[n] = source[n]!;
  return out;
}

/** The environment `gh` runs with: the same allowlist the Build's own `gh` calls get (common variables plus the GitHub token). */
export function githubCommandEnv(source: NodeJS.ProcessEnv, passEnv?: readonly string[]): Record<string, string> {
  return pickEnv(source, passEnv, GITHUB_ENV);
}

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
 *
 * It also redefines wrangler's module rules for the three types that copy an imported file into the output as a module of its own
 * (Text: .txt and .html, Data: .bin, CompiledWasm: .wasm). A user rule of a type, not marked `fallthrough`, makes wrangler 4.93
 * refuse an import that matches the default rule of that type ("matched a module rule ... but was ignored"), so such an import
 * fails the bundle instead of leaving the file in the output (a `rules: []` would not: the defaults still apply). Nothing
 * argus deploys is a Worker with module imports of those kinds, so they are refused wherever the file is.
 */
export function wranglerConfigFor(slug: string, main: string): string {
  const rules = ["Text", "Data", "CompiledWasm"].map((type) => ({ type, globs: ["**/*.argus-never"], fallthrough: false }));
  return JSON.stringify({ name: slug, main, compatibility_date: COMPATIBILITY_DATE, rules }, null, 2) + "\n";
}

/** A step that failed, with a message fit for the Proposal's status history. */
class StepError extends Error {}

/** The Worker name belongs to someone else: no retry can change that, so the Build fails for good. */
class NameTakenError extends StepError {}

interface Cmd {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(bin: string, args: string[], o: { cwd?: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal; stop?: () => Promise<void> }): Promise<Cmd> {
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
    // A container's podman client dying leaves the container running: it is ended by name as well (stop, then rm -f).
    const kill = () => {
      void o.stop?.().catch(() => {});
      signalGroup(child, "SIGKILL");
    };
    const timer = setTimeout(() => {
      stderr += `\n[argus] killed after ${o.timeoutMs} ms`;
      kill();
    }, o.timeoutMs);
    o.signal?.addEventListener("abort", kill, { once: true });
    // An abort that came before the listener existed fires no event; it is still an abort.
    if (o.signal?.aborted) kill();
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

const MARKER_NAMES = ["ARGUS_NEEDS_HUMAN", "ARGUS_BUILD_FAILED"] as const;

export function classifyFinalMessage(text: string): FinalVerdict {
  const lastRaw = text.trimEnd().split("\n").at(-1) ?? "";
  const last = lastRaw.endsWith("\r") ? lastRaw.slice(0, -1) : lastRaw;
  // Agent output is untrusted (standards, rule 13): no pattern matching, a fixed prefix then JSON checked against a strict shape.
  const name = MARKER_NAMES.find((n) => last.startsWith(`${n}::`));
  if (!name) {
    // A marker that is not the whole line (backticks, a prefix, an unknown ARGUS_ line) is a malformed marker, not success.
    if (MARKER_NAMES.some((n) => last.includes(`${n}::`)) || last.startsWith("ARGUS_")) {
      return { kind: "failed", summary: `The final line looks like a marker but is malformed: ${JSON.stringify(last.slice(0, 200))}` };
    }
    return { kind: "ok" };
  }
  let body: unknown;
  try {
    body = JSON.parse(last.slice(name.length + 2));
  } catch {
    return { kind: "failed", summary: `Unparseable ${name} marker: ${JSON.stringify(last.slice(0, 200))}` };
  }
  const field = name === "ARGUS_NEEDS_HUMAN" ? "reason" : "summary";
  const value = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>)[field] : undefined;
  if (typeof value !== "string" || !value.trim()) {
    return { kind: "failed", summary: `${name} marker has no "${field}": ${JSON.stringify(last.slice(0, 200))}` };
  }
  return name === "ARGUS_NEEDS_HUMAN" ? { kind: "needs-human", reason: value.trim() } : { kind: "failed", summary: value.trim() };
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

/**
 * What in a commit's tree (`git ls-tree -r -z` output) must keep it from being bundled: a symlink (mode 120000) or a
 * submodule (160000), which a bundler would follow to files outside the commit, and a path that climbs out of the export
 * or sits inside a `.git` directory. One description per offending entry, in tree order.
 */
export function findUnsafeEntries(lsTree: string): string[] {
  const out: string[] = [];
  for (const line of lsTree.split("\0")) {
    const m = /^(\d+) \w+ [0-9a-f]+\t([^]*)$/.exec(line);
    if (!m) continue;
    const [, mode, path] = m as unknown as [string, string, string];
    const segments = path.split("/");
    if (mode === "120000") out.push(`a symlink: ${path}`);
    else if (mode === "160000") out.push(`a submodule: ${path}`);
    else if (segments.includes("..")) out.push(`a path that climbs out: ${JSON.stringify(path)}`);
    else if (segments.includes(".git")) out.push(`a path inside a .git directory: ${JSON.stringify(path)}`);
  }
  return out;
}

/** A metafile input path argus accepts: no `?` or `#` suffix (esbuild keeps those raw, and a `/../` after one normalises away), NUL, backslash or URL scheme. */
const PLAIN_INPUT_RE = /^[^?#\0\\]+$/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/** Is `f` (relative to `cwd`) a plain path to a regular file that exists and whose real path is inside `exportDir`/`realExport`? */
function isPlainFileInside(f: string, cwd: string, exportDir: string, realExport: string): boolean {
  if (!PLAIN_INPUT_RE.test(f) || URL_SCHEME_RE.test(f) || isAbsolute(f)) return false;
  const abs = resolve(cwd, f);
  if (!abs.startsWith(exportDir + sep)) return false;
  try {
    const real = realpathSync(abs);
    return real.startsWith(realExport + sep) && statSync(real).isFile();
  } catch {
    return false;
  }
}

/**
 * Checks the esbuild metafile wrangler wrote for a bundle run in `cwd`: its input paths are relative to the cwd, and every one
 * must be a plain relative path (no `?`, `#`, NUL, backslash or URL scheme) to a regular file that exists and whose real path
 * lies inside `exportDir` (its own node_modules included). Otherwise returns those that do not, as the metafile names them.
 * On success returns the bundle's entry output, which must lie inside `outdir` and be a file.
 */
export function checkMetafile(meta: unknown, cwd: string, exportDir: string, outdir: string): { outside: string[] } | { output: string } {
  const { inputs, outputs } = (meta ?? {}) as { inputs?: Record<string, unknown>; outputs?: Record<string, { entryPoint?: unknown }> };
  if (!inputs || typeof inputs !== "object" || !outputs || typeof outputs !== "object") throw new Error("it has no inputs or outputs");
  const realExport = realpathSync(exportDir);
  const outside = Object.keys(inputs).filter((f) => !isPlainFileInside(f, cwd, exportDir, realExport));
  if (outside.length > 0) return { outside };
  const entries = Object.entries(outputs).filter(([, v]) => typeof v?.entryPoint === "string");
  if (entries.length !== 1) throw new Error(`it lists ${entries.length} entry outputs, not one`);
  const output = resolve(cwd, entries[0]![0]);
  if (!output.startsWith(outdir + sep) || !statSync(output).isFile()) throw new Error("the bundle's output is not a file in its output directory");
  return { output };
}

/**
 * Checks what the bundle step left in `outdir`: only the entry output, its sourcemap and wrangler's README.md may be there, as
 * files. Anything else (the modules wrangler's rules copy out of an import, which the metafile does not list) is returned by name.
 */
export function unexpectedOutdirEntries(outdir: string, output: string): string[] {
  const allowed = new Set([basename(output), `${basename(output)}.map`, "README.md"]);
  return readdirSync(outdir)
    .filter((name) => !allowed.has(name) || !lstatSync(join(outdir, name)).isFile())
    .sort();
}

/** The `wrangler deploy` arguments of the in-container bundle step: a dry run into argus's own directory (`work`), nothing uploaded. */
export function bundleArgs(slug: string, work: string): string[] {
  return ["--name", slug, "--config", join(work, "wrangler.jsonc"), "--env-file", join(work, "empty.env"), "--dry-run", "--outdir", join(work, "dist"), "--metafile", join(work, "meta.json")];
}

/** The last preflight refusal logged for a runner's options, so a missing image is one log line, not one per tick. */
const lastRefusal = new WeakMap<BuildRunnerOptions, string>();

/** The per-Build home (claude config and session transcripts, package store, caches): kept for a failed Build so it can be resumed. */
export function buildHomeFor(dataDir: string, proposalId: number): string {
  return join(resolve(dataDir), "proposals", String(proposalId), "home");
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
  // Entry point 1 (approved -> needs-human): a Spec that is the `## Needs human` refusal is never built, so no slot, clone or container.
  // It runs before the preflight: routing it needs no podman.
  const refusal0 = needsHumanReasonOf(proposal);
  if (refusal0 !== null) {
    store.transition(proposal.id, "needs-human", "build", `Spec needs a human: ${refusal0 || "the Spec is a Needs human refusal"}`.slice(0, 500));
    return { proposalId: proposal.id, result: "needs-human" };
  }
  // Preflight: no Build starts without podman, the image, the network and the token. The Proposal stays approved and the next
  // tick tries again; the reason is logged when it first appears or changes, not every tick.
  const refusal = await o.sandbox.preflight();
  if (refusal) {
    if (lastRefusal.get(o) !== refusal) {
      lastRefusal.set(o, refusal);
      (o.log ?? console.log)(`[worker] Build for proposal ${proposal.id} not started: ${refusal}. It stays approved and is retried on the next tick.`);
    }
    return undefined;
  }
  lastRefusal.delete(o);
  // The slot is taken synchronously below; the preflight awaited, so make sure the queue still looks the way it did.
  if (signal?.aborted || nextBuildable(store)?.id !== proposal.id) return undefined;
  const runId = store.beginBuild(proposal.id, brain.routeFor("build"));
  return build(store, brain, o, store.getProposal(proposal.id)!, runId, signal);
}

/** The reason in an approved Proposal's `## Needs human` Spec, or null when its Spec is to be built (or cannot be read: the Build fails that itself). */
function needsHumanReasonOf(p: Proposal): string | null {
  try {
    return needsHumanSpecReason(readFileSync(p.specPath ?? "", "utf8"));
  } catch {
    return null;
  }
}

/** What the two attempts of one Build share. */
interface Attempts {
  attempt: 1 | 2;
  /** The open brain run of the attempt that is running (the retry gets a new one, see `restartBuildRun`). */
  runId: number;
  /** Set once the clone, the private repo and the Spec commit exist; a failure before that is final, as there is nothing to retry on. */
  setup?: { originUrl: string; branch: string; templateCommit: string; specCommit: string };
  /** Set by a failed first attempt that is to be retried: the failure report appended to the retry's prompt. */
  retryReport?: string;
  /** Set once this Build's `wrangler deploy` succeeded: the Worker under the slug is the Build's own, and the retry may redeploy over it. */
  deployed?: boolean;
}

/** Lines of the Build log, each cut short, that the retry's prompt carries. */
const REPORT_LOG_LINES = 25;
const REPORT_LINE_CHARS = 300;

/** The failure report for the retry: the error and the last lines of the Build log (stream-json events and the runner's own notes). */
function failureReport(logPath: string, reason: string): string {
  let tail = "";
  try {
    tail = readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-REPORT_LOG_LINES)
      .map((l) => (l.length > REPORT_LINE_CHARS ? `${l.slice(0, REPORT_LINE_CHARS)}...` : l))
      .join("\n");
  } catch {
    // no log yet: the error alone
  }
  return [
    "This is the one automatic retry: your previous attempt at this Build failed.",
    "Whatever you had not committed was discarded; the working tree is back at your last commit.",
    `Error: ${reason}`,
    "Last lines of the Build log:",
    tail,
  ].join("\n");
}

/**
 * One Build: its first attempt and, when that fails after setup (a non-zero exit, the budget or wall-clock cap, a failed check,
 * deploy or preview), exactly one retry on the same repo. The Proposal stays `building` between the two.
 */
async function build(store: Datastore, brain: ClaudeCodeBrain, o: BuildRunnerOptions, p: Proposal, runId: number, signal?: AbortSignal): Promise<BuildOutcome> {
  const state: Attempts = { attempt: 1, runId };
  const first = await attempt(store, brain, o, p, state, signal);
  if (state.retryReport === undefined) return first;
  // The retry does not go back through runNextBuild: the Spec is identical, and the pre-spawn `## Needs human` check already ran for attempt 1.
  state.attempt = 2;
  return attempt(store, brain, o, p, state, signal);
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
  // The containers: the agent, then (from a fresh export of the checked commit) the dependency install and the dry-run bundle.
  const seal = join(resolve(o.dataDir), "proposals", String(p.id), "seal-<random>");
  const work = join(seal, "work");
  const containers: SandboxJob[] = [
    { role: "agent", buildId: p.id, cwd: repo, mounts: [repo], home: buildHomeFor(o.dataDir, p.id), args, timeoutMs: brain.timeoutFor("build") },
    { role: "install", buildId: p.id, cwd: join(work, "export"), mounts: [work], home: join(seal, "home"), args: [], timeoutMs: o.commandTimeoutMs ?? 10 * 60_000 },
    { role: "bundle", buildId: p.id, cwd: work, mounts: [work], home: join(seal, "home"), args: bundleArgs(p.slug, work), binDir: join(work, "export", "node_modules", ".bin"), timeoutMs: o.commandTimeoutMs ?? 10 * 60_000 },
  ];
  for (const job of containers) for (const line of o.sandbox.describe(job)) log(`[build ${p.id}] dry-run: ${line}`);
  const wrangler = o.wranglerBin ?? "wrangler";
  say(wrangler, ["deploy", "--name", p.slug, "--config", "<argus-seal>/wrangler-deploy.jsonc", "--env-file", "<argus-seal>/empty.env", "--no-bundle"]);
  return { proposalId: p.id, result: "dry-run" };
}

async function attempt(store: Datastore, brain: ClaudeCodeBrain, o: BuildRunnerOptions, p: Proposal, state: Attempts, signal?: AbortSignal): Promise<BuildOutcome> {
  const id = p.id;
  const runId = state.runId;
  const logSink = (o.log ?? console.log) as (line: string) => void;
  const logPath = buildLogPathFor(o.dataDir, id);
  const repo = resolve(o.buildRoot, p.slug);
  const home = buildHomeFor(o.dataDir, id);
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
    const done = runEnd ?? { sessionId: null, totalCostUsd: 0, exitStatus: "failed" };
    // A failed first attempt that is to be retried hands over to a new run in the same transaction, so a `building` Proposal never lacks one.
    if (state.attempt === 1 && state.retryReport !== undefined) state.runId = store.restartBuildRun(runId, done, brain.routeFor("build"));
    else store.finishBrainRun(runId, done);
  };
  /**
   * Marks the Proposal failed first, then the run closes (in `finally`): the run is open for as long as the Proposal is `building`.
   * A first attempt that failed after setup, and was not stopped by a shutdown, is not final: the report is kept and `build()` retries.
   * A failure a retry cannot change (`retryable` false: the Worker name is someone else's) is final.
   */
  const fail = (reason: string, exitStatus = "failed", retryable = true): BuildOutcome => {
    note(`Build failed: ${reason}`);
    runEnd ??= { sessionId: null, totalCostUsd: 0, exitStatus };
    const building = store.getProposal(id)?.status === "building";
    if (building && retryable && state.attempt === 1 && state.setup && exitStatus !== "interrupted" && !signal?.aborted) {
      state.retryReport = failureReport(logPath, reason);
    } else if (building) store.transition(id, "build-failed", "build", `Build failed: ${reason}`.slice(0, 500));
    return { proposalId: id, result: "build-failed" };
  };

  const source = o.env ?? process.env;
  const pick = (names: readonly string[]) => pickEnv(source, o.passEnv, names);
  const gitEnv = { ...pick([]), ...GIT_ISOLATION };
  const pushEnv = { ...pick(GITHUB_ENV), ...GIT_ISOLATION };
  const ghEnv = pick(GITHUB_ENV);
  const wranglerEnv = { ...pick(CLOUDFLARE_ENV), CI: "1", WRANGLER_SEND_METRICS: "false" };
  const timeoutMs = o.commandTimeoutMs ?? 10 * 60_000;
  const git = o.gitBin ?? "git";
  const gh = o.ghBin ?? "gh";

  /** Runs one command; a non-zero exit throws a StepError carrying the tail of its stderr. */
  const step = async (label: string, bin: string, args: string[], env: Record<string, string>, cwd?: string, stop?: () => Promise<void>): Promise<string> => {
    note(`$ ${show(bin, args)}${cwd ? ` (cwd ${cwd})` : ""}`);
    const r = await runCommand(bin, args, { cwd, env, timeoutMs, signal, stop });
    if (r.code !== 0) throw new StepError(`${label} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-300)}`);
    return r.stdout.trim();
  };
  /** One step as a container (dependency install, bundle): its sidecar and container are ended by name however the step ends. */
  const inContainer = async (label: string, job: Pick<SandboxJob, "role" | "cwd" | "mounts" | "home" | "args" | "binDir">): Promise<void> => {
    let launched;
    try {
      launched = await o.sandbox.launch({ ...job, buildId: id, timeoutMs, signal, note });
    } catch (e) {
      throw new StepError(`${label} failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400));
    }
    try {
      // An abort that landed while the sandbox was starting leaves nothing to run: end what it started and stop here.
      if (signal?.aborted) throw new StepError(`${label} failed: the worker is stopping`);
      await step(label, launched.command, launched.args, launched.env, job.cwd, launched.stop);
    } finally {
      await launched.stop().catch(() => {});
    }
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

  /**
   * Before the retry: the Build repo's working tree and index go back to its last commit, and untracked files go. The agent's
   * `.git/config`, hooks and attributes are never read: like the checks below, this runs git from a git directory of argus's own
   * that borrows only the repo's objects, with the repo as its work tree. The repo's own index is replaced by the one that
   * produces, so the agent's git sees a clean tree. Ignored files (node_modules) stay.
   */
  const resetRepo = async () => {
    const head = readHeadCommit(repo);
    const dotGit = join(repo, ".git");
    // A symlinked .git could send the index write somewhere else on the host.
    if (!lstatSync(dotGit).isDirectory()) throw new StepError("the Build repo's .git is not a directory");
    mkdirSync(dirname(home), { recursive: true });
    const tmp = mkdtempSync(join(dirname(home), `seal-${o.sandbox.owner}-`));
    try {
      const tmpGit = join(tmp, ".git");
      const inTmp = (label: string, ...args: string[]) => step(label, git, [...SAFE_GIT, ...args], gitEnv, tmp);
      await inTmp("git init", "init", "--quiet", tmp);
      writeFileSync(join(tmpGit, "objects", "info", "alternates"), join(dotGit, "objects") + "\n");
      const onTree = { ...gitEnv, GIT_DIR: tmpGit, GIT_WORK_TREE: repo };
      await inTmp("git cat-file", "cat-file", "-e", `${head}^{commit}`);
      await inTmp("git update-ref", "update-ref", "--no-deref", "HEAD", head);
      await step("git read-tree", git, [...SAFE_GIT, "read-tree", "--reset", "-u", head], onTree, tmp);
      await step("git clean", git, [...SAFE_GIT, "clean", "-ffdq"], onTree, tmp);
      rmSync(join(dotGit, "index"), { force: true });
      copyFileSync(join(tmpGit, "index"), join(dotGit, "index"));
    } finally {
      removeTree(tmp);
    }
  };

  /**
   * Never deploys over a Worker that is already in the account: the name is the slug, and an existing one is someone's, unless
   * this Build deployed it itself (`state.deployed`: the retry redeploys over its own Worker).
   */
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
    if (res.status === 200 && state.deployed) return;
    if (res.status === 200) throw new NameTakenError(`a Worker named ${p.slug} already exists in the Cloudflare account; refusing to overwrite it`);
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

  // Beats for as long as this Build runs, whatever phase it is in: the stale sweep fails a Build whose worker went quiet for the
  // route's cap plus a grace, which a long deploy, crawl or push after a full-length claude run would otherwise look like.
  // A beat that fails (a busy database) is logged and dropped: an error thrown out of a timer would crash the worker, and the
  // next beat, a minute on, is soon enough.
  const heartbeat = setInterval(() => {
    try {
      store.touchBrainRun(runId);
    } catch (e) {
      try {
        logSink(`[build ${id}] heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
      } catch {
        // nothing left to report to
      }
    }
  }, o.heartbeatMs ?? 60_000);
  heartbeat.unref();

  // Scratch space for after the agent has run: a git directory of argus's own, and the wrangler config.
  let seal: string | undefined;
  try {
    if (signal?.aborted) return fail("the worker is stopping", "interrupted");
    if (!state.setup) {
      if (!SLUG_RE.test(p.slug) || p.slug.length > 63) return fail(`invalid slug ${JSON.stringify(p.slug)}`);
      if (existsSync(repo)) return fail(`${repo} already exists; refusing to build over it. Remove it, and the private GitHub repo ${p.slug}, before re-queueing`);
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
      state.setup = { originUrl, branch, templateCommit, specCommit };
    } else {
      // The retry: the same repo, taken back to its last commit first.
      if (store.getProposal(id)?.status !== "building") {
        note("The Proposal is no longer building (dismissed meanwhile); nothing more is done");
        return { proposalId: id, result: "abandoned" };
      }
      note("Retrying once, from the last commit; uncommitted work is discarded");
      await resetRepo();
    }
    const { originUrl, branch, templateCommit, specCommit } = state.setup;

    // The claude run.
    if (signal?.aborted) return fail("the worker is stopping", "interrupted");
    note(`Starting claude in a container (cwd ${repo})`);
    // The per-Build home: claude's config and sessions, the package store and caches. Kept when the Build fails (so the session can
    // be resumed), removed when it is built.
    mkdirSync(home, { recursive: true, mode: 0o700 });
    let run;
    try {
      run = await brain.run<string>(
        "build",
        { prompt: state.retryReport === undefined ? String(id) : `${id}\n\n${state.retryReport}`, slash: "implement-spec" },
        {
          cwd: repo,
          signal,
          onOutput: append,
          sandbox: (job) => o.sandbox.launch({ role: "agent", buildId: id, cwd: job.cwd, mounts: [job.cwd], home, args: job.args, timeoutMs: job.timeoutMs, signal: job.signal, note }),
        },
      );
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
    // Under the data dir, on the disk: the dependency install below puts a node_modules in it, which does not belong in /tmp.
    mkdirSync(dirname(home), { recursive: true });
    // Named for the worker that made it, so a later worker can tell a seal whose Build is over from one still in use.
    seal = mkdtempSync(join(dirname(home), `seal-${o.sandbox.owner}-`));
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
    await step("git read-tree", git, [...SAFE_GIT, "read-tree", head], onTree, seal);
    const dirty = await step("git status", git, [...SAFE_GIT, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=all"], onTree, seal);
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

    // Only what is committed is ever bundled, and the Worker is deployed with the global wrangler (never the repo's node_modules)
    // under the slug, with a config argus wrote. The tree must hold no symlink and no submodule, and the bundle is built from a
    // fresh export of the commit, never from the agent's working tree. The dependencies come from the committed lockfile, and
    // the bundling itself (the one step that reads dependency and agent code as a bundler does) runs in the Build container: it
    // sees the export and nothing else of the host, has no network and no credentials. Its --dry-run uploads nothing. argus
    // still checks what it left: every input its metafile lists must lie inside the export, the output directory must hold only
    // the entry, and only that checked entry is deployed (--no-bundle) from argus's own directory, with the credentials.
    const unsafe = findUnsafeEntries(await sealed("git ls-tree", "ls-tree", "-r", "-z", "--full-tree", head));
    if (unsafe.length > 0) return fail(`the commit holds ${unsafe.slice(0, 5).join("; ")}; refusing to bundle it`);
    const sealDir = realpathSync(seal);
    // `work` is the one directory the containers write (the export, its node_modules, the bundle, the metafile); nothing argus
    // trusts is in it. The seal's git directory, the tarball and the deploy's inputs stay beside it.
    const workDir = join(sealDir, "work");
    const exportDir = join(workDir, "export");
    const tarball = join(sealDir, "export.tar");
    mkdirSync(exportDir, { recursive: true });
    mkdirSync(join(sealDir, "home"));
    await sealed("git archive", "archive", "--format=tar", "-o", tarball, head);
    await step("tar", "tar", ["-xf", tarball, "-C", exportDir, "--no-same-owner"], pick([]), sealDir);
    try {
      if (!lstatSync(join(exportDir, WORKER_ENTRY)).isFile()) throw new Error("not a file");
    } catch {
      return fail(`${WORKER_ENTRY} is missing or is not a file in the commit; refusing to deploy`);
    }
    // wrangler loads .env, .env.local and .dev.vars from its working directory, and the agent can leave those in the repo (the
    // template ignores them, so the clean-tree check passes): a CLOUDFLARE_API_BASE_URL there would send the Operator's token to
    // the agent. The deploy therefore runs in argus's own directory (`sealDir`, which no container writes), and --env-file names
    // an empty file of argus's own as a second guard. The bundle step has no credentials; it gets the same guards anyway.
    const bundleHome = join(sealDir, "home");
    const bundleConfig = join(workDir, "wrangler.jsonc");
    const outdir = join(workDir, "dist");
    const metafile = join(workDir, "meta.json");
    writeFileSync(join(workDir, "empty.env"), "");
    writeFileSync(bundleConfig, wranglerConfigFor(p.slug, join(exportDir, WORKER_ENTRY)));
    await inContainer("dependency install", { role: "install", cwd: exportDir, mounts: [workDir], home: bundleHome, args: [] });
    // The project's own wrangler (the template's pinned devDependency, from the lockfile), run from the work directory: its config,
    // output and metafile are there, and its working directory has no agent-written .env.
    await inContainer("wrangler bundle", { role: "bundle", cwd: workDir, mounts: [workDir], home: bundleHome, args: bundleArgs(p.slug, workDir), binDir: join(exportDir, "node_modules", ".bin") });
    const envFile = join(sealDir, "empty.env");
    writeFileSync(envFile, "");
    const wrangler = o.wranglerBin ?? "wrangler";
    let bundled: string;
    try {
      // The metafile and the output directory are what the container wrote: a symlink in either place could name a host file, so
      // both must be what they claim to be before anything is read from them. The metafile is then only read as data.
      if (!lstatSync(metafile).isFile()) throw new Error("it is not a regular file");
      if (!lstatSync(outdir).isDirectory()) throw new Error("the output directory is not a directory");
      if (!lstatSync(exportDir).isDirectory()) throw new Error("the export is not a directory");
      let meta: unknown;
      try {
        meta = JSON.parse(readFileSync(metafile, "utf8"));
      } catch {
        throw new Error("it is not JSON");
      }
      const checked = checkMetafile(meta, workDir, exportDir, outdir);
      if ("outside" in checked) return fail(`the bundle read files outside the commit, or by a path that is not a plain one to a file in it: ${checked.outside.slice(0, 5).map((f) => JSON.stringify(f)).join(", ")}; refusing to deploy`);
      bundled = checked.output;
    } catch (e) {
      return fail(`the bundle's metafile could not be checked: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Deny by default: the outdir holds exactly what was expected, and the deploy uploads from a fresh directory with only the
    // checked entry file in it (a --no-bundle deploy uploads whatever else sits beside its entry).
    const extra = unexpectedOutdirEntries(outdir, bundled);
    if (extra.length > 0) return fail(`the bundle's output directory holds more than the bundle: ${extra.slice(0, 5).join(", ")}; refusing to deploy`);
    const uploadDir = join(sealDir, "upload");
    mkdirSync(uploadDir);
    const uploadMain = join(uploadDir, basename(bundled));
    copyFileSync(bundled, uploadMain);
    const configPath = join(sealDir, "wrangler-deploy.jsonc");
    writeFileSync(configPath, wranglerConfigFor(p.slug, uploadMain));
    await requireFreeWorkerName();
    const deployed = await step("wrangler deploy", wrangler, ["deploy", "--name", p.slug, "--config", configPath, "--env-file", envFile, "--no-bundle"], wranglerEnv, sealDir);
    // The Worker under the slug is this Build's now: the retry (should the checks below fail) may redeploy over it, and the card
    // names it among the leftovers the Operator removes before a re-queue.
    state.deployed = true;
    store.markWorkerDeployed(id);
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
    // A built Build is never resumed: its home (session transcripts, package store) goes. A failed Build keeps it (design Q8).
    const homeError = removeTree(home);
    if (homeError) note(`Warning: could not remove ${home}: ${homeError}`);
    // The repo holds the built code; a failed push does not undo a verified preview.
    try {
      await push(seal, originUrl, head, branch);
    } catch (e) {
      note(`Warning: ${e instanceof Error ? e.message : String(e)}`);
    }
    note("Build done");
    return { proposalId: id, result: "built" };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), "failed", !(e instanceof NameTakenError));
  } finally {
    clearInterval(heartbeat);
    // The seal holds what the containers wrote, and nothing about that is under argus's control (a mode-000 directory from an install
    // script, say). Removing it can fail, and failing must neither skip closing the run nor leave the seal unmentioned.
    try {
      if (seal) {
        const sealError = removeTree(seal);
        if (sealError) note(`Warning: could not remove ${seal}: ${sealError}`);
      }
    } catch {
      // nothing left to report to
    } finally {
      try {
        // Dismissed while the Build ran: the lifecycle left the home to us, as the container was using it.
        if (store.getProposal(id)?.status === "dismissed") {
          const homeError = removeTree(home);
          if (homeError) note(`Warning: could not remove ${home}: ${homeError}`);
        }
      } finally {
        closeRun();
      }
    }
  }
}

/**
 * Removes a directory tree that a container wrote to: directories the agent's install scripts left unreadable or unwritable
 * (mode 000, say) are made enterable first, as `chmod -R u+rwX` would, without following a symlink. Never throws; returns the
 * reason it could not remove the tree, or undefined when it is gone.
 */
export function removeTree(path: string): string | undefined {
  const open = (p: string): void => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (!st.isDirectory()) return;
    try {
      chmodSync(p, st.mode | 0o700);
    } catch {
      // not ours to change, or gone: rmSync below says what is left
    }
    let names: string[] = [];
    try {
      names = readdirSync(p);
    } catch {
      return;
    }
    for (const n of names) open(join(p, n));
  };
  try {
    open(path);
    rmSync(path, { recursive: true, force: true });
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * At worker start: removes the seal directories (`proposals/<id>/seal-<pid>.<ticks>-*`) of Builds that are over, found by the worker
 * that made them being gone. A seal whose worker is alive (a Build running now, in this process or in a `--once` run beside it) and
 * one whose name says nothing about its owner are left alone. Returns the paths removed.
 */
export function sweepStaleSeals(dataDir: string, log: (line: string) => void = () => {}, readStat?: ReadProcStat): string[] {
  const removed: string[] = [];
  const proposals = join(resolve(dataDir), "proposals");
  let ids: string[] = [];
  try {
    ids = readdirSync(proposals);
  } catch {
    return removed;
  }
  for (const id of ids) {
    let names: string[] = [];
    try {
      names = readdirSync(join(proposals, id));
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^seal-([1-9][0-9]{0,9}\.[0-9]{1,15})-[A-Za-z0-9]{6}$/.exec(name);
      if (!m) continue;
      const path = join(proposals, id, name);
      const state = ownerState(m[1]!, readStat);
      if (state === "unknown") log(`[worker] left alone seal ${path}: could not tell whether its owner ${m[1]} is running`);
      if (state !== "dead") continue;
      const error = removeTree(path);
      if (error) log(`[worker] could not remove stale seal ${path}: ${error}`);
      else {
        removed.push(path);
        log(`[worker] removed stale seal ${path}`);
      }
    }
  }
  return removed;
}
