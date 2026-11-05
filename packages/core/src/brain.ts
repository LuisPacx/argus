import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type BrainTask = "judge" | "propose" | "spec" | "build";
export type BrainBackend = "claude-code" | "api";

/** What a task needs to run: free-form text handed to the skill. */
export interface BrainInput {
  /** The skill's input, appended after `/<task>` in the prompt. */
  prompt: string;
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
  /** Aborting kills a live child and fails the run as `interrupted`; an already-aborted signal spawns nothing. */
  signal?: AbortSignal;
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
}

export type Routing = Record<BrainTask, TaskRoute>;

const MINUTE = 60_000;

/**
 * Wall-clock caps: judge 5 min, propose 15 min, spec 10 min (a Spec is one short document, no tools), build 4 h
 * (architecture §6). Tools: judge and propose read the web, spec gets none (its input is untrusted Proposal text), build
 * gets the file and shell tools; ticket 07 scopes build's list further (e.g. `Bash(git *)`).
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
    tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
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

function killChild(child: ChildProcess, graceMs: number): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, graceMs);
  t.unref();
  child.once("close", () => clearTimeout(t));
}

/** Children killed by shutdown, so their runs are reported as `interrupted` rather than failed. */
const shutdownKilled = new WeakSet<ChildProcess>();

/** Kills every live brain child (SIGTERM, then SIGKILL after `graceMs`) and resolves once they have all exited. */
export async function killLiveBrainChildren(graceMs = 5_000): Promise<number> {
  const children = [...liveChildren];
  for (const c of children) shutdownKilled.add(c);
  await Promise.all(
    children.map(
      (c) =>
        new Promise<void>((resolve) => {
          if (c.exitCode !== null || c.signalCode !== null) return resolve();
          c.once("close", () => resolve());
          killChild(c, graceMs);
        }),
    ),
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

  /**
   * How old an in-flight row for `task` may get before it is stale: its route's wall-clock cap plus a grace period.
   * A live run is killed at its cap, so it never gets this old. An unknown task falls back to the longest cap.
   */
  staleAfterMs(task: string): number {
    const route = (this.routing as Record<string, TaskRoute | undefined>)[task];
    const cap = route ? route.timeoutMs : Math.max(...Object.values(this.routing).map((r) => r.timeoutMs));
    return cap + STALE_RUN_GRACE_MS;
  }

  /** The argv for `claude`; exposed so dry runs and tests see exactly what would be spawned. */
  buildArgs(task: BrainTask, input: BrainInput, opts: BrainRunOptions = {}): string[] {
    const route = this.routing[task];
    // The configured cap is a ceiling: a caller may lower it but never raise it.
    const budget = Math.min(route.maxBudgetUsd, opts.maxBudgetUsd ?? route.maxBudgetUsd);
    const args = [
      "-p",
      `/${task}\n\n${input.prompt}`,
      "--output-format",
      this.opts.outputFormat ?? "json",
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
    if (route.tools.length > 0) args.push("--allowedTools", route.tools.join(","));
    if (this.opts.outputFormat === "stream-json") args.push("--verbose");
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
    const env = scrubEnv(this.opts.env ?? process.env, this.opts.passEnv);
    let isolated: string | undefined;
    let out: ExecResult;
    try {
      if (this.opts.cwd === undefined && this.opts.skillsDir !== undefined) isolated = prepareSkillCwd(this.opts.skillsDir, task);
      out = await exec(command, args, {
        cwd: this.opts.cwd ?? isolated,
        env,
        timeoutMs: route.timeoutMs,
        killGraceMs: this.opts.killGraceMs ?? 5_000,
        signal: opts.signal,
      });
    } finally {
      if (isolated) rmSync(isolated, { recursive: true, force: true });
    }
    const { stdout, stderr, code, signal, timedOut, interrupted } = out;
    const messages = parseMessages(stdout);
    const msg = messages.filter((m) => m.type === "result").at(-1);
    const base = { sessionId: msg?.session_id, totalCostUsd: msg?.total_cost_usd ?? 0, ...info };
    if (timedOut) {
      throw new BrainError("timed-out", `Run exceeded its ${route.timeoutMs} ms wall-clock cap and was killed`, base);
    }
    const succeeded = msg?.subtype === "success" && !msg.is_error && code === 0;
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
    if (msg.is_error || msg.subtype !== "success" || code !== 0) {
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
  o: { cwd?: string; env: Record<string, string>; timeoutMs: number; killGraceMs: number; signal?: AbortSignal },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
    liveChildren.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      killChild(child, o.killGraceMs);
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child, o.killGraceMs);
    }, o.timeoutMs);
    const done = () => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      liveChildren.delete(child);
    };
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      done();
      reject(e);
    });
    child.on("close", (code, signal) => {
      done();
      resolve({ stdout, stderr, code, signal, timedOut, interrupted: aborted || shutdownKilled.has(child) });
    });
  });
}
