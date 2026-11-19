import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MOMENT_CONFIG } from "./config.ts";
import type { PostCounts } from "./counts.ts";
import type { ScannedPost } from "./store.ts";
import { killGroup, markClosed } from "../process-group.ts";

/** One load of the plan: an `id` (`top` or `live`) and the address. */
export interface PlanItem {
  id: string;
  url: string;
}

/** One page as the child read it. Everything in `posts` is third-party text; the store cuts and cleans it. */
export interface PageResult {
  id: string;
  status: string;
  signals: string[];
  posts: ScannedPost[];
  error: string;
}

/**
 * What a child run came to. `ran`: it finished or stopped on a signal (`stopped` names a STOP signal). `locked`: the Chrome directory was
 * held, nothing was loaded. `refused`: the plan was refused before any load. `failed`: the child crashed, timed out or printed nothing usable.
 */
export interface RunnerResult {
  kind: "ran" | "locked" | "refused" | "failed";
  pages: PageResult[];
  stopped: string | null;
  /** True when a page's selectors found nothing and the child stopped there. */
  selectorsFoundNothing: boolean;
  reason: string;
}

/** The scanner's child process, as the job sees it. Tests pass a fake. */
export type MomentRunner = (plan: readonly PlanItem[], opts?: { signal?: AbortSignal }) => Promise<RunnerResult>;

const SCRIPT = fileURLToPath(new URL("../../scripts/x-search-scan.mjs", import.meta.url));
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const EXIT = { stopped: 2, locked: 3, refused: 4, selectorsFoundNothing: 5 } as const;
/** The environment names the child may see: what Chrome needs, and the two settings of the profile. Nothing else (no token, no key). */
const CHILD_ENV = ["PATH", "HOME", "USER", "LANG", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "TMPDIR", "ARGUS_CHROME_DIR", "ARGUS_CHROME_BIN"] as const;

const isCount = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);

function toCounts(v: unknown): PostCounts {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const c = (k: string): number | null => (isCount(o[k]) ? (o[k] as number | null) : null);
  return { replies: c("replies"), reposts: c("reposts"), likes: c("likes"), bookmarks: c("bookmarks"), views: c("views") };
}

function toPost(v: unknown): ScannedPost | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.statusId !== "string" || typeof o.handle !== "string") return null;
  return { statusId: o.statusId, handle: o.handle, text: typeof o.text === "string" ? o.text : "", hasVideo: o.hasVideo === true, counts: toCounts(o.counts) };
}

/** Reads the child's output: one JSON object per line. A line that is not valid is ignored. */
export function parseChildOutput(stdout: string, exitCode: number | null): RunnerResult {
  const pages: PageResult[] = [];
  let done: { exit?: number; stopped?: string | null; reason?: string } | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof o !== "object" || o === null) continue;
    const r = o as Record<string, unknown>;
    if (r.done === true) {
      done = { exit: typeof r.exit === "number" ? r.exit : undefined, stopped: typeof r.stopped === "string" ? r.stopped : null, reason: typeof r.reason === "string" ? r.reason : "" };
      continue;
    }
    if (typeof r.id !== "string" || typeof r.status !== "string") continue;
    pages.push({
      id: r.id,
      status: r.status,
      signals: Array.isArray(r.signals) ? r.signals.filter((s): s is string => typeof s === "string").slice(0, 10) : [],
      posts: (Array.isArray(r.posts) ? r.posts : []).map(toPost).filter((p): p is ScannedPost => p !== null),
      error: typeof r.error === "string" ? r.error.slice(0, 200) : "",
    });
  }
  const exit = done?.exit ?? exitCode;
  const reason = done?.reason ?? "";
  if (exit === EXIT.locked) return { kind: "locked", pages, stopped: null, selectorsFoundNothing: false, reason: reason || "the Chrome directory is held by another process" };
  if (exit === EXIT.refused) return { kind: "refused", pages, stopped: null, selectorsFoundNothing: false, reason: reason || "the plan was refused" };
  if (done === null) return { kind: "failed", pages, stopped: null, selectorsFoundNothing: false, reason: `the scanner ended without a result (exit ${exitCode ?? "signal"})` };
  const stopped = done.stopped ?? (exit === EXIT.stopped ? (pages.find((p) => p.status !== "ok")?.status ?? "stopped") : null);
  return { kind: "ran", pages, stopped, selectorsFoundNothing: exit === EXIT.selectorsFoundNothing, reason };
}

/**
 * The real runner: `node x-search-scan.mjs` in its own process group, the plan on stdin, its lines read from stdout. It is killed (the whole
 * group) when it runs past the timeout or the signal aborts. Nothing but a short list of environment names reaches it.
 */
export function spawnMomentRunner(opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; script?: string; nodeBin?: string } = {}): MomentRunner {
  const source = opts.env ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV) if (source[name] !== undefined) env[name] = source[name];
  return (plan, runOpts = {}) =>
    new Promise<RunnerResult>((resolve) => {
      const child = spawn(opts.nodeBin ?? process.execPath, [opts.script ?? SCRIPT], { env, detached: true, stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      let overflow = false;
      let timedOut = false;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        out += d;
        if (out.length > MAX_OUTPUT_BYTES && !overflow) {
          overflow = true;
          killGroup(child, 2_000);
        }
      });
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child, 5_000);
      }, opts.timeoutMs ?? MOMENT_CONFIG.childTimeoutMs);
      const abort = () => killGroup(child, 5_000);
      runOpts.signal?.addEventListener("abort", abort, { once: true });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ kind: "failed", pages: [], stopped: null, selectorsFoundNothing: false, reason: `could not start the scanner: ${e.message.slice(0, 120)}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        runOpts.signal?.removeEventListener("abort", abort);
        markClosed(child);
        const r = parseChildOutput(out, code);
        if (timedOut) resolve({ ...r, kind: r.kind === "ran" ? "ran" : "failed", reason: `the scanner ran past ${(opts.timeoutMs ?? MOMENT_CONFIG.childTimeoutMs) / 1000} s and was stopped` });
        else if (overflow) resolve({ ...r, kind: "failed", reason: "the scanner printed too much and was stopped" });
        else resolve(r);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(plan));
    });
}
