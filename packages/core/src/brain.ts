import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isClosed, killGroup, markClosed } from "./process-group.ts";
import type { SandboxRun } from "./sandbox.ts";

export type BrainTask = "judge" | "propose" | "spec" | "build";
export type BrainBackend = "claude-code" | "api";

/** What a task needs to run: free-form text handed to the skill. */
export interface BrainInput {
  /** The skill's input, appended after `/<task>` in the prompt. */
  prompt: string;
  /**
   * Run this skill instead of `/<task>` (the build route runs the Build repo's own `/implement-spec`). The prompt is then
   * `/<slash> <prompt>` on one line.
   */
  slash?: string;
}

export interface BrainRun<T> {
  output: T;
  /** claude-code only; enables resume. */
  sessionId?: string;
  totalCostUsd: number;
  backend: BrainBackend;
  model: string;
  /** Set when `--dry-run` logged the command and spawned nothing; `output` is then meaningless. */
  dryRun?: true;
}

export interface BrainRunOptions {
  maxBudgetUsd?: number;
  resume?: string;
  /**
   * A stable working directory for this run, kept afterwards. `claude --resume <id>` finds a session by project
   * directory, so a run that may later be resumed must always use the same one. It holds only the task's skill (copied
   * in from `skillsDir`), never the repo root. With `resume` set the directory must already exist: a session started
   * elsewhere (a deleted temp dir) cannot be resumed, so the run fails without spawning.
   */
  workDir?: string;
  /** Working directory for this run (a Build's clone); beats the constructor's `cwd` and `skillsDir`. `workDir` still wins. */
  cwd?: string;
  /** Called with each chunk of the child's stdout as it arrives (the Build log), before the run finishes. */
  onOutput?: (chunk: string) => void;
  /** Aborting kills a live child and fails the run as `interrupted`; an already-aborted signal spawns nothing. */
  signal?: AbortSignal;
  /**
   * Runs the child in a sandbox instead of directly (the build route runs in a podman container). Given the `claude` argv, the
   * working directory (the repo, the same path inside) and the wall-clock cap, it returns what to spawn on the host and how to
   * end the container; the argv itself is untouched. The brain ends the container on timeout, abort, shutdown and when the child
   * has exited, whatever the outcome. Needs `cwd`.
   */
  sandbox?: (job: { args: string[]; cwd: string; timeoutMs: number; signal?: AbortSignal }) => Promise<SandboxRun>;
}

export interface Brain {
  /** Which backend and model a task is routed to, known before the run (recorded on the in-flight run row). */
  routeFor(task: BrainTask): { backend: BrainBackend; model: string };
  run<T = string>(task: BrainTask, input: BrainInput, opts?: BrainRunOptions): Promise<BrainRun<T>>;
}

/** Routing is data: task -> backend, model, spend cap, wall-clock cap and tools. Overridable per task from config. */
export interface TaskRoute {
  backend: BrainBackend;
  model: string;
  /** Passed as `--max-budget-usd`. A caller may lower it, never raise it. */
  maxBudgetUsd: number;
  /** Wall-clock cap in ms. On expiry the child is killed (SIGTERM, then SIGKILL) and the run fails as `timed-out`. */
  timeoutMs: number;
  /**
   * Built-in tools the child may use, passed as `--tools` (the set that exists) and `--allowedTools` (no prompt).
   * Empty means none: `--tools ""`. Required, so a new task cannot forget to decide.
   */
  tools: readonly string[];
  /** `--allowedTools` when it is narrower than `tools` (e.g. `Bash(git commit *)` where `tools` has `Bash`). Defaults to `tools`. */
  allowedTools?: readonly string[];
  /** Passed as `--permission-mode`. */
  permissionMode?: "acceptEdits";
  /** `stream-json` (with `--verbose`) makes the output a live event stream. Defaults to the brain's `outputFormat`, else `json`. */
  outputFormat?: "json" | "stream-json";
}

export type Routing = Record<BrainTask, TaskRoute>;

const MINUTE = 60_000;

/**
 * What the build child may run without a prompt. Unattended, anything not listed is denied. The shell is scoped to what
 * `/implement-spec` needs: git add/commit/status/diff/log/show, pnpm install/add/check/test/typecheck/lint, mkdir/mv/ls.
 * No bare `Bash`, no push, no deploy, no network tools. The Build repo's own `.claude/settings.json` adds deny rules on
 * top (deny beats allow), and argus re-verifies the result itself.
 */
export const BUILD_ALLOWED_TOOLS: readonly string[] = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(git status*)",
  "Bash(git diff*)",
  "Bash(git log*)",
  "Bash(git show *)",
  "Bash(pnpm install*)",
  "Bash(pnpm add *)",
  "Bash(pnpm check*)",
  "Bash(pnpm test*)",
  "Bash(pnpm typecheck*)",
  "Bash(pnpm lint*)",
  "Bash(pnpm exec vitest*)",
  "Bash(pnpm exec tsc*)",
  "Bash(pnpm exec oxlint*)",
  "Bash(ls*)",
  "Bash(mkdir *)",
  "Bash(mv *)",
];

/**
 * Wall-clock caps: judge 5 min, propose 15 min, spec 10 min (a Spec is one short document, no tools), build 4 h
 * (architecture §4). Tools: judge and propose read the web, spec gets none (its input is untrusted Proposal text), build
 * gets the file and shell tools, with the shell scoped by BUILD_ALLOWED_TOOLS.
 */
export const DEFAULT_ROUTING: Routing = {
  judge: { backend: "claude-code", model: "haiku", maxBudgetUsd: 0.25, timeoutMs: 5 * MINUTE, tools: ["WebFetch"] },
  propose: { backend: "claude-code", model: "sonnet", maxBudgetUsd: 1, timeoutMs: 15 * MINUTE, tools: ["WebSearch", "WebFetch"] },
  spec: { backend: "claude-code", model: "sonnet", maxBudgetUsd: 2, timeoutMs: 10 * MINUTE, tools: [] },
  build: {
    backend: "claude-code",
    model: "sonnet",
    maxBudgetUsd: 25,
    timeoutMs: 240 * MINUTE,
    // `tools` is the set that exists; `allowedTools` is what may run without a prompt.
    tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
    allowedTools: BUILD_ALLOWED_TOOLS,
    permissionMode: "acceptEdits",
    outputFormat: "stream-json",
  },
};

export function resolveRouting(overrides: Partial<Record<BrainTask, Partial<TaskRoute>>> = {}): Routing {
  const out = { ...DEFAULT_ROUTING };
  for (const task of Object.keys(out) as BrainTask[]) out[task] = { ...out[task], ...overrides[task] };
  return out;
}

/** `interrupted`: the worker was shutting down. The run did not fail on its merits, so the work may be tried again. */
export type BrainFailureKind = "failed" | "budget-exceeded" | "rate-limited" | "timed-out" | "interrupted";

/** A run that did not succeed. Carries what was spent so the caller can still record it. */
/** A Claude Code session id is a UUID; anything else is never passed to `--resume`. */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BrainError extends Error {
  readonly kind: BrainFailureKind;
  readonly sessionId?: string;
  readonly totalCostUsd: number;
  readonly backend: BrainBackend;
  readonly model: string;
  constructor(
    kind: BrainFailureKind,
    message: string,
    info: { sessionId?: string; totalCostUsd?: number; backend: BrainBackend; model: string },
  ) {
    super(message);
    this.name = "BrainError";
    this.kind = kind;
    this.sessionId = info.sessionId;
    this.totalCostUsd = info.totalCostUsd ?? 0;
    this.backend = info.backend;
    this.model = info.model;
  }
}

/** Variables the child may inherit. Everything else, notably ANTHROPIC_API_KEY, is dropped. */
export const CHILD_ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LANG", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

export function scrubEnv(source: NodeJS.ProcessEnv, extra: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...CHILD_ENV_ALLOWLIST, ...extra]) {
    if (name === "ANTHROPIC_API_KEY") continue;
    const v = source[name];
    if (v !== undefined) out[name] = v;
  }
  return out;
}

export interface ClaudeCodeBrainOptions {
  routing?: Routing;
  /** Executable to spawn; tests point this at the fake. */
  command?: string;
  /**
   * Directory holding the project skills (`<skillsDir>/<task>/SKILL.md`, normally argus's `.claude/skills`). Each run
   * gets a fresh temp working directory containing only that task's skill, so the child never sees the repo root
   * (`.env`, `.data/argus.db`). Ignored when `cwd` is set.
   */
  skillsDir?: string;
  /** Explicit working directory (e.g. a Build's clone); takes precedence over `skillsDir`. */
  cwd?: string;
  /** Grace between SIGTERM and SIGKILL when a child is killed. Default 5000. */
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Extra variable names (beyond CHILD_ENV_ALLOWLIST) to pass through. */
  passEnv?: readonly string[];
  dryRun?: boolean;
  log?: (line: string) => void;
  outputFormat?: "json" | "stream-json";
}

interface ResultMessage {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  /** HTTP status of the API error behind an error result, when there was one. */
  api_error_status?: number | null;
  rate_limit_info?: { status?: string };
}

/** Every JSON message in `--output-format json` (one object or array) or `stream-json` (one per line) output. */
export function parseMessages(stdout: string): ResultMessage[] {
  const text = stdout.trim();
  if (!text) return [];
  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(text));
  } catch {
    for (const line of text.split("\n")) {
      try {
        candidates.push(JSON.parse(line));
      } catch {
        // not JSON; ignore
      }
    }
  }
  return (candidates.flatMap((c) => (Array.isArray(c) ? c : [c])) as ResultMessage[]).filter((m) => m && typeof m === "object");
}

/** Reads the `result` message from `--output-format json` or `stream-json` (the last one). */
export function parseResult(stdout: string): ResultMessage | undefined {
  return parseMessages(stdout).filter((m) => m.type === "result").at(-1);
}

/**
 * Phrases claude prints when the subscription runs out. Anchored to the start of a line so that a spec or error that merely
 * mentions "429" or "rate limit" in passing is not mistaken for throttling.
 */
const LIMIT_MESSAGE_RE =
  /^(?:claude ai usage limit reached|you(?:'|\u2019)ve hit your (?:session |weekly |usage )?limit|(?:5-hour|weekly|session|usage) limit reached|api error: 429\b)/im;

/**
 * Whether a failed run was throttled. Structured fields first: `api_error_status` 429 on the result, or a
 * `rate_limit_event` with status `rejected` in the stream. Only then the anchored message above, and only on the
 * failure text (the result's `result` when it is an error, else stderr), never on arbitrary output.
 */
export function isRateLimited(messages: ResultMessage[], failureText: string): boolean {
  const result = messages.filter((m) => m.type === "result").at(-1);
  if (result?.api_error_status === 429) return true;
  if (messages.some((m) => m.type === "rate_limit_event" && m.rate_limit_info?.status === "rejected")) return true;
  return LIMIT_MESSAGE_RE.test(failureText);
}

/** Children currently running, so shutdown can kill them (no orphaned, still-spending claude). */
const liveChildren = new Set<ChildProcess>();

/** Children killed by shutdown, so their runs are reported as `interrupted` rather than failed. */
const shutdownKilled = new WeakSet<ChildProcess>();

/** How to end the container a sandboxed live child runs in (killing the podman client alone would leave it running). */
const liveStops = new Map<ChildProcess, () => Promise<void>>();

/** Kills every live brain child (SIGTERM, then SIGKILL after `graceMs`) and resolves once they have all exited. */
export async function killLiveBrainChildren(graceMs = 5_000): Promise<number> {
  const children = [...liveChildren];
  for (const c of children) shutdownKilled.add(c);
  await Promise.all(
    children.map((c) => {
      const stopped = liveStops.get(c)?.().catch(() => {});
      return Promise.all([
        stopped,
        new Promise<void>((resolve) => {
          if (isClosed(c)) return resolve();
          c.once("close", () => resolve());
          killGroup(c, graceMs);
        }),
      ]);
    }),
  );
  return children.length;
}

/** Slack on top of a route's timeout before an open run row counts as left by a dead process (covers the kill grace). */
export const STALE_RUN_GRACE_MS = 5 * 60_000;

export class ClaudeCodeBrain implements Brain {
  private readonly routing: Routing;
  private readonly opts: ClaudeCodeBrainOptions;

  constructor(opts: ClaudeCodeBrainOptions = {}) {
    this.opts = opts;
    this.routing = opts.routing ?? DEFAULT_ROUTING;
  }

  routeFor(task: BrainTask): { backend: BrainBackend; model: string } {
    const { backend, model } = this.routing[task];
    return { backend, model };
  }

  /** The task's wall-clock cap in ms. */
  timeoutFor(task: BrainTask): number {
    return this.routing[task].timeoutMs;
  }

  /**
   * How old an in-flight row for `task` may get before it is stale: its route's wall-clock cap plus a grace period.
   * A live run is killed at its cap, so it never gets this old. An unknown task falls back to the longest cap.
   */
  staleAfterMs(task: string): number {
    const routing = this.routing as Record<string, TaskRoute | undefined>;
    // `spec-revise` rows run on the spec route.
    const route = routing[task] ?? routing[task.split("-")[0]!];
    const cap = route ? route.timeoutMs : Math.max(...Object.values(this.routing).map((r) => r.timeoutMs));
    return cap + STALE_RUN_GRACE_MS;
  }

  /** The argv for `claude`; exposed so dry runs and tests see exactly what would be spawned. */
  buildArgs(task: BrainTask, input: BrainInput, opts: BrainRunOptions = {}): string[] {
    const route = this.routing[task];
    // The configured cap is a ceiling: a caller may lower it but never raise it.
    const budget = Math.min(route.maxBudgetUsd, opts.maxBudgetUsd ?? route.maxBudgetUsd);
    const outputFormat = route.outputFormat ?? this.opts.outputFormat ?? "json";
    const args = [
      "-p",
      input.slash !== undefined ? `/${input.slash} ${input.prompt}` : `/${task}\n\n${input.prompt}`,
      "--output-format",
      outputFormat,
      "--model",
      route.model,
      "--max-budget-usd",
      String(budget),
    ];
    // Keep the operator's own Claude Code setup out of the child: HOME is passed (it holds the login), so without these
    // ~/.claude settings, hooks, MCP servers (user and claude.ai connectors) and plugins would load into an unattended run.
    // `--strict-mcp-config` with no `--mcp-config` means no MCP servers; `--setting-sources project` reads only the cwd's own settings.
    args.push("--strict-mcp-config", "--setting-sources", "project");
    // Tool restriction: `--tools` fixes the set that exists (empty string = none), `--allowedTools` lets them run unprompted.
    args.push("--tools", route.tools.join(","));
    const allowed = route.allowedTools ?? route.tools;
    if (allowed.length > 0) args.push("--allowedTools", allowed.join(","));
    if (route.permissionMode) args.push("--permission-mode", route.permissionMode);
    if (outputFormat === "stream-json") args.push("--verbose");
    if (opts.resume) args.push("--resume", opts.resume);
    return args;
  }

  async run<T = string>(task: BrainTask, input: BrainInput, opts: BrainRunOptions = {}): Promise<BrainRun<T>> {
    const route = this.routing[task];
    if (route.backend !== "claude-code") {
      throw new Error(`Task ${task} is routed to backend ${route.backend}, which ClaudeCodeBrain cannot run`);
    }
    const info = { backend: route.backend, model: route.model };
    const command = this.opts.command ?? "claude";
    const args = this.buildArgs(task, input, opts);
    if (this.opts.dryRun) {
      const shown = args.map((a, i) => (i === 1 ? JSON.stringify(a.slice(0, 200)) : a));
      (this.opts.log ?? console.log)(`[brain] dry-run: ${command} ${shown.join(" ")}`);
      return { output: "" as T, totalCostUsd: 0, dryRun: true, ...info };
    }
    if (opts.signal?.aborted) throw new BrainError("interrupted", "Run not started: the worker is stopping", info);
    if (opts.resume && !SESSION_ID_RE.test(opts.resume)) {
      throw new BrainError("failed", "Cannot resume the session: invalid session id", info);
    }
    if (opts.resume && opts.workDir !== undefined && !existsSync(opts.workDir)) {
      throw new BrainError("failed", "Cannot resume the session: its working directory is gone (the Spec was drafted before sessions were resumable)", info);
    }
    // Project instructions (CLAUDE.md) found in parent directories of a stable working dir must not reach the child.
    const env = { ...scrubEnv(this.opts.env ?? process.env, this.opts.passEnv), CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" };
    let isolated: string | undefined;
    let launched: SandboxRun | undefined;
    let out: ExecResult;
    try {
      let cwd = opts.cwd ?? this.opts.cwd;
      if (opts.workDir !== undefined) cwd = prepareSkillDir(opts.workDir, this.opts.skillsDir, task);
      else if (cwd === undefined && this.opts.skillsDir !== undefined) cwd = isolated = prepareSkillCwd(this.opts.skillsDir, task);
      if (opts.sandbox) {
        if (cwd === undefined) throw new BrainError("failed", "A sandboxed run needs a working directory", info);
        try {
          launched = await opts.sandbox({ args, cwd, timeoutMs: route.timeoutMs, signal: opts.signal });
        } catch (e) {
          if (opts.signal?.aborted) throw new BrainError("interrupted", "Run not started: the worker is stopping", info);
          throw new BrainError("failed", `The sandbox could not be started: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500), info);
        }
      }
      // The sandbox's command is the podman client; the `claude` argv rides inside it, unchanged.
      out = await exec(launched?.command ?? command, launched?.args ?? args, {
        cwd,
        env: launched?.env ?? env,
        timeoutMs: route.timeoutMs,
        killGraceMs: this.opts.killGraceMs ?? 5_000,
        signal: opts.signal,
        onOutput: opts.onOutput,
        stop: launched?.stop,
      });
    } finally {
      if (isolated) rmSync(isolated, { recursive: true, force: true });
      // Whatever happened, no container or sidecar outlives the run.
      await launched?.stop().catch(() => {});
    }
    const { stdout, stderr, code, signal, timedOut, interrupted } = out;
    const messages = parseMessages(stdout);
    const msg = messages.filter((m) => m.type === "result").at(-1);
    const base = { sessionId: msg?.session_id, totalCostUsd: msg?.total_cost_usd ?? 0, ...info };
    // A complete successful result is the run's outcome even if our own kill (cap or shutdown) landed after it was printed.
    const killedByUs = timedOut || interrupted;
    const succeeded = msg?.subtype === "success" && !msg.is_error && (code === 0 || killedByUs);
    if (timedOut && !succeeded) {
      throw new BrainError("timed-out", `Run exceeded its ${route.timeoutMs} ms wall-clock cap and was killed`, base);
    }
    if (interrupted && !succeeded) {
      throw new BrainError("interrupted", "Run was killed because the worker is stopping", base);
    }
    if (!msg) {
      const detail = (stderr || stdout).trim().slice(0, 500);
      const kind = isRateLimited(messages, stderr) ? "rate-limited" : "failed";
      throw new BrainError(kind, `claude exited ${code ?? signal} without a result: ${detail}`, base);
    }
    if (msg.subtype === "error_max_budget_usd") {
      throw new BrainError("budget-exceeded", "Run hit the --max-budget-usd cap", base);
    }
    if (!succeeded) {
      const text = String(msg.result ?? msg.subtype ?? `exit ${code}`);
      const kind = (msg.is_error || code !== 0) && isRateLimited(messages, text) ? "rate-limited" : "failed";
      throw new BrainError(kind, text.slice(0, 500), base);
    }
    return { output: (msg.result ?? "") as T, ...base };
  }
}

/** A fresh working directory holding only `<skillsDir>/<task>`, laid out as `.claude/skills/<task>` so `/<task>` resolves. */
function prepareSkillCwd(skillsDir: string, task: BrainTask): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-brain-"));
  try {
    const dest = join(dir, ".claude", "skills", task);
    mkdirSync(dest, { recursive: true });
    cpSync(join(skillsDir, task), dest, { recursive: true });
    return dir;
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Makes `dir` (kept across runs) hold exactly the task's skill, refreshed each run so skill edits apply. */
function prepareSkillDir(dir: string, skillsDir: string | undefined, task: BrainTask): string {
  mkdirSync(dir, { recursive: true });
  if (skillsDir !== undefined) {
    const dest = join(dir, ".claude", "skills", task);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(join(skillsDir, task), dest, { recursive: true });
  }
  return dir;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Killed by shutdown (aborted signal or killLiveBrainChildren). */
  interrupted: boolean;
}

function exec(
  command: string,
  args: string[],
  o: {
    cwd?: string;
    env: Record<string, string>;
    timeoutMs: number;
    killGraceMs: number;
    signal?: AbortSignal;
    onOutput?: (chunk: string) => void;
    /** Ends the container the child is the podman client of; called wherever the child's group is killed. */
    stop?: () => Promise<void>;
  },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    // Detached: the child leads its own process group, so a kill reaches everything it started (see process-group.ts).
    const child = spawn(command, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    liveChildren.add(child);
    if (o.stop) liveStops.set(child, o.stop);
    const endContainer = () => void o.stop?.().catch(() => {});
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      endContainer();
      killGroup(child, o.killGraceMs);
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      endContainer();
      killGroup(child, o.killGraceMs);
    }, o.timeoutMs);
    const done = () => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      liveChildren.delete(child);
      liveStops.delete(child);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
      o.onOutput?.(d);
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      done();
      reject(e);
    });
    child.on("close", (code, signal) => {
      markClosed(child);
      done();
      resolve({ stdout, stderr, code, signal, timedOut, interrupted: aborted || shutdownKilled.has(child) });
    });
  });
}
