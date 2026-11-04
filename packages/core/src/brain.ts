import { spawn } from "node:child_process";

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
}

export interface Brain {
  run<T = string>(task: BrainTask, input: BrainInput, opts?: BrainRunOptions): Promise<BrainRun<T>>;
}

/** Routing is data: task -> backend, model and spend cap. Overridable per task from config. */
export interface TaskRoute {
  backend: BrainBackend;
  model: string;
  /** Passed as `--max-budget-usd`. A caller may lower it, never raise it. */
  maxBudgetUsd: number;
}

export type Routing = Record<BrainTask, TaskRoute>;

export const DEFAULT_ROUTING: Routing = {
  judge: { backend: "claude-code", model: "haiku", maxBudgetUsd: 0.25 },
  propose: { backend: "claude-code", model: "sonnet", maxBudgetUsd: 1 },
  spec: { backend: "claude-code", model: "sonnet", maxBudgetUsd: 2 },
  build: { backend: "claude-code", model: "sonnet", maxBudgetUsd: 25 },
};

export function resolveRouting(overrides: Partial<Record<BrainTask, Partial<TaskRoute>>> = {}): Routing {
  const out = { ...DEFAULT_ROUTING };
  for (const task of Object.keys(out) as BrainTask[]) out[task] = { ...out[task], ...overrides[task] };
  return out;
}

export type BrainFailureKind = "failed" | "budget-exceeded" | "rate-limited";

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
  /** Working directory; must be the argus repo root so `.claude/skills/` is found. */
  cwd?: string;
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
}

/** Reads the `result` message from `--output-format json` (one object) or `stream-json` (last result line). */
export function parseResult(stdout: string): ResultMessage | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
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
  const flat = candidates.flatMap((c) => (Array.isArray(c) ? c : [c])) as ResultMessage[];
  return flat.filter((m) => m && typeof m === "object" && m.type === "result").at(-1);
}

const RATE_LIMIT_RE = /usage limit|rate.?limit|limit reached|too many requests|\b429\b/i;

export class ClaudeCodeBrain implements Brain {
  private readonly routing: Routing;
  private readonly opts: ClaudeCodeBrainOptions;

  constructor(opts: ClaudeCodeBrainOptions = {}) {
    this.opts = opts;
    this.routing = opts.routing ?? DEFAULT_ROUTING;
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
    const env = scrubEnv(this.opts.env ?? process.env, this.opts.passEnv);
    const { stdout, stderr, code } = await exec(command, args, { cwd: this.opts.cwd, env });
    const msg = parseResult(stdout);
    const base = { sessionId: msg?.session_id, totalCostUsd: msg?.total_cost_usd ?? 0, ...info };
    if (!msg) {
      const detail = (stderr || stdout).trim().slice(0, 500);
      const kind = RATE_LIMIT_RE.test(detail) ? "rate-limited" : "failed";
      throw new BrainError(kind, `claude exited ${code} without a result: ${detail}`, base);
    }
    if (msg.subtype === "error_max_budget_usd") {
      throw new BrainError("budget-exceeded", "Run hit the --max-budget-usd cap", base);
    }
    if (msg.is_error || msg.subtype !== "success" || code !== 0) {
      const text = String(msg.result ?? msg.subtype ?? `exit ${code}`);
      const kind = RATE_LIMIT_RE.test(text) ? "rate-limited" : "failed";
      throw new BrainError(kind, text.slice(0, 500), base);
    }
    return { output: (msg.result ?? "") as T, ...base };
  }
}

function exec(
  command: string,
  args: string[],
  o: { cwd?: string; env: Record<string, string> },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}
