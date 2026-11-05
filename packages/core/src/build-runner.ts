import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BrainError, type ClaudeCodeBrain } from "./brain.ts";
import type { Datastore, Proposal } from "./datastore.ts";
import { checkDisclosure } from "./disclosure.ts";

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
  /** For the preview checks; defaults to the global `fetch`. */
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
 * git run by the runner inside a Build repo. The Build agent can write `.git/config` and `.git/hooks`, so hooks and the
 * fsmonitor (a configured command git would run on `status`) are switched off here, and diffs never run external programs.
 */
const SAFE_GIT = ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never"];
const COMMIT_IDENTITY = ["-c", "user.name=argus", "-c", "user.email=argus@localhost", "-c", "commit.gpgsign=false"];

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
      child = spawn(bin, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolveCmd({ code: null, stdout, stderr: e instanceof Error ? e.message : String(e) });
    }
    const kill = () => child.kill("SIGKILL");
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
 * The slot is taken synchronously (approved -> building) before anything else, so a second call while a Build runs sees
 * `building` and does nothing. Every status change goes through `store.transition`/`completeBuild`.
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
  store.transition(proposal.id, "building", "build");
  return build(store, brain, o, store.getProposal(proposal.id)!, signal);
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
  say(o.gitBin ?? "git", ["clone", "--origin", "template", o.templateRepo, repo]);
  say(o.ghBin ?? "gh", ["repo", "create", p.slug, "--private", "--source", ".", "--remote", "origin"]);
  say(o.gitBin ?? "git", ["push", "-u", "origin", "HEAD"]);
  const args = brain.buildArgs("build", { prompt: String(p.id), slash: "implement-spec" });
  log(`[build ${p.id}] dry-run: claude (cwd ${repo}) ${args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
  say(o.wranglerBin ?? "wrangler", ["deploy", "--name", p.slug, "--config", "wrangler.jsonc"]);
  return { proposalId: p.id, result: "dry-run" };
}

async function build(store: Datastore, brain: ClaudeCodeBrain, o: BuildRunnerOptions, p: Proposal, signal?: AbortSignal): Promise<BuildOutcome> {
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

  // The run row is open from the moment the slot is taken, so a crash at any point leaves spend to account for.
  const route = brain.routeFor("build");
  const runId = store.startBrainRun({ proposalId: id, task: "build", ...route });
  let runOpen = true;
  const finishRun = (done: { sessionId: string | null; totalCostUsd: number; exitStatus: string }) => {
    if (!runOpen) return;
    runOpen = false;
    store.finishBrainRun(runId, done);
  };
  const fail = (reason: string, exitStatus = "failed"): BuildOutcome => {
    note(`Build failed: ${reason}`);
    finishRun({ sessionId: null, totalCostUsd: 0, exitStatus });
    if (store.getProposal(id)?.status === "building") store.transition(id, "build-failed", "build", `Build failed: ${reason}`.slice(0, 500));
    return { proposalId: id, result: "build-failed" };
  };

  const source = o.env ?? process.env;
  const pick = (names: readonly string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const n of [...COMMON_ENV, ...(o.passEnv ?? []), ...names]) if (source[n] !== undefined) out[n] = source[n]!;
    return out;
  };
  const gitEnv = { ...pick([]), GIT_TERMINAL_PROMPT: "0" };
  const pushEnv = { ...pick(GITHUB_ENV), GIT_TERMINAL_PROMPT: "0" };
  const ghEnv = pick(GITHUB_ENV);
  const wranglerEnv = { ...pick(CLOUDFLARE_ENV), CI: "1", WRANGLER_SEND_METRICS: "false" };
  const timeoutMs = o.commandTimeoutMs ?? 10 * 60_000;
  const git = o.gitBin ?? "git";

  /** Runs one command; a non-zero exit throws a StepError carrying the tail of its stderr. */
  const step = async (label: string, bin: string, args: string[], env: Record<string, string>, cwd?: string): Promise<string> => {
    note(`$ ${show(bin, args)}${cwd ? ` (cwd ${cwd})` : ""}`);
    const r = await runCommand(bin, args, { cwd, env, timeoutMs, signal });
    if (r.code !== 0) throw new StepError(`${label} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-300)}`);
    return r.stdout.trim();
  };
  const inRepo = (label: string, ...args: string[]) => step(label, git, [...SAFE_GIT, ...args], gitEnv, repo);

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

    // Setup: the template clone, a private GitHub repo, the Spec and the slug written in and committed.
    note(`Build starts for ${p.name} (${p.slug})`);
    mkdirSync(o.buildRoot, { recursive: true });
    await step("git clone", git, [...SAFE_GIT, "clone", "--origin", "template", o.templateRepo, repo], gitEnv, o.buildRoot);
    const templateCommit = await inRepo("git rev-parse", "rev-parse", "HEAD");
    await step("gh repo create", o.ghBin ?? "gh", ["repo", "create", p.slug, "--private", "--source", ".", "--remote", "origin"], ghEnv, repo);
    writeFileSync(join(repo, "SPEC.md"), spec.endsWith("\n") ? spec : spec + "\n");
    const wranglerPath = join(repo, "wrangler.jsonc");
    const wrangler = readFileSync(wranglerPath, "utf8");
    if (!/("name"\s*:\s*)"[^"]*"/.test(wrangler)) throw new StepError('wrangler.jsonc has no "name" to set to the slug');
    writeFileSync(wranglerPath, wrangler.replace(/("name"\s*:\s*)"[^"]*"/, `$1"${p.slug}"`));
    await inRepo("git add", "add", "SPEC.md", "wrangler.jsonc");
    await inRepo("git commit", ...COMMIT_IDENTITY, "commit", "--quiet", "-m", `Add Spec for ${p.name}`);
    const specCommit = await inRepo("git rev-parse", "rev-parse", "HEAD");
    await step("git push", git, [...SAFE_GIT, "push", "--quiet", "-u", "origin", "HEAD"], pushEnv, repo);

    // The claude run.
    if (signal?.aborted) return fail("the worker is stopping", "interrupted");
    note(`Starting claude in ${repo}`);
    let run;
    try {
      run = await brain.run<string>("build", { prompt: String(id), slash: "implement-spec" }, { cwd: repo, signal, onOutput: append });
    } catch (e) {
      const be = e instanceof BrainError ? e : undefined;
      // Spend first: whatever the run cost is recorded before anything else happens.
      finishRun({ sessionId: be?.sessionId ?? null, totalCostUsd: be?.totalCostUsd ?? 0, exitStatus: be?.kind ?? "failed" });
      const why = e instanceof Error ? e.message : String(e);
      return fail(be?.kind === "interrupted" ? "interrupted by the worker shutting down" : `claude ${be?.kind ?? "failed"}: ${why}`, be?.kind ?? "failed");
    }
    if (run.dryRun) return fail("the brain is in dry-run mode but the Build Runner is not");
    finishRun({ sessionId: run.sessionId ?? null, totalCostUsd: run.totalCostUsd, exitStatus: "success" });
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

    const head = await inRepo("git rev-parse", "rev-parse", "HEAD");
    if (head === specCommit) return fail("HEAD has not advanced past the Spec commit (nothing was committed)");
    const ancestor = await runCommand(git, [...SAFE_GIT, "merge-base", "--is-ancestor", specCommit, head], { cwd: repo, env: gitEnv, timeoutMs, signal });
    if (ancestor.code !== 0) return fail("HEAD is not a descendant of the Spec commit (history was rewritten)");
    const dirty = await inRepo("git status", "status", "--porcelain", "--untracked-files=all");
    if (dirty) return fail(`the working tree is not clean: ${dirty.split("\n").slice(0, 5).join("; ")}`);
    const changed = await inRepo("git diff", "diff", "--name-only", "--no-renames", "--no-ext-diff", templateCommit, head, "--", ...PROTECTED_PATHS);
    if (changed) return fail(`protected paths differ from the template: ${changed.split("\n").slice(0, 5).join(", ")}`);
    try {
      const was = stableScripts(await inRepo("git show", "show", `${templateCommit}:package.json`));
      const now = stableScripts(await inRepo("git show", "show", `${head}:package.json`));
      if (was !== now) return fail("the scripts field of package.json differs from the template");
    } catch (e) {
      if (e instanceof StepError) throw e;
      return fail("package.json could not be read or parsed");
    }
    if (/"build"\s*:/.test(readFileSync(wranglerPath, "utf8"))) {
      return fail('wrangler.jsonc sets "build" (a command wrangler would run with the deploy credentials); refusing to deploy');
    }

    // Deploy with the global wrangler (never the repo's node_modules), under the slug, then verify the live preview.
    const deployed = await step("wrangler deploy", o.wranglerBin ?? "wrangler", ["deploy", "--name", p.slug, "--config", "wrangler.jsonc"], wranglerEnv, repo);
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
      await step("git push", git, [...SAFE_GIT, "push", "--quiet", "origin", "HEAD"], pushEnv, repo);
    } catch (e) {
      note(`Warning: ${e instanceof Error ? e.message : String(e)}`);
    }
    note("Build done");
    return { proposalId: id, result: "built" };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
