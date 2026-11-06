import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { API_DEFAULT_ROUTING, isApiTask, MAX_API_DAILY_USD, type ApiRoute, type ApiTask } from "./api-brain.ts";
import { BrainError, type Brain, type BrainBackend, type BrainInput, type BrainRun, type BrainRunOptions, type BrainTask } from "./brain.ts";
import type { Datastore } from "./datastore.ts";

/**
 * The ApiBrain fallback (architecture section 5, ADR 0001): when `claude -p` is rate-limited because the subscription window is used
 * up, `judge` and `propose` are served by the API (haiku, pay-as-you-go, real dollars) for the rest of the window. `spec` and `build`
 * never fall back; they wait for the window to reset. It is off unless the Operator turns it on.
 */

export interface ApiFallbackConfig {
  enabled: boolean;
  /** The daily cap in real dollars: at most `MAX_API_DAILY_USD`, which is in code. */
  dailyUsd: number;
}

/**
 * ARGUS_API_FALLBACK (`1` turns it on; unset, empty or `0` leave it off; anything else is an error) and ARGUS_API_DAILY_USD (a positive
 * number of dollars that can only LOWER the cap in code). Each is parsed first and validated after, and an invalid value is an error
 * and never a fallback, as for the other ARGUS_* caps.
 */
export function apiFallbackConfigFromEnv(env: Record<string, string | undefined>): ApiFallbackConfig {
  const rawSwitch = env.ARGUS_API_FALLBACK?.trim() ?? "";
  if (rawSwitch !== "" && rawSwitch !== "0" && rawSwitch !== "1") throw new Error(`ARGUS_API_FALLBACK must be 1 (on) or 0 or unset (off), got "${env.ARGUS_API_FALLBACK}"`);
  const rawCap = env.ARGUS_API_DAILY_USD?.trim() ?? "";
  let dailyUsd = MAX_API_DAILY_USD;
  if (rawCap !== "") {
    const v = Number(rawCap);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`ARGUS_API_DAILY_USD must be a positive number of dollars, got "${env.ARGUS_API_DAILY_USD}"`);
    if (v > MAX_API_DAILY_USD) throw new Error(`ARGUS_API_DAILY_USD must be at most ${MAX_API_DAILY_USD} (a hard cap in code; configuration can only lower it), got "${env.ARGUS_API_DAILY_USD}"`);
    dailyUsd = v;
  }
  return { enabled: rawSwitch === "1", dailyUsd };
}

/**
 * The Anthropic API key: from `env`, else from the .env file at `envFile`, and only that one name is taken from the file. A variable that
 * is set, even to the empty string, wins over the file (so a test or an Operator can mask the file with ""). With `ARGUS_NO_DOTENV` set the
 * file is never read: the test run sets it, so a test never reads the Operator's .env (CODING_STANDARDS 16). Undefined when there is no key.
 * The value is returned to the one caller that hands it to ApiBrain; it is never logged, here or there.
 */
export function anthropicKeyFromEnv(env: Record<string, string | undefined>, envFile: string): string | undefined {
  let value = env.ANTHROPIC_API_KEY;
  if (value === undefined && !env.ARGUS_NO_DOTENV && existsSync(envFile)) {
    try {
      value = parseEnv(readFileSync(envFile, "utf8")).ANTHROPIC_API_KEY;
    } catch {
      value = undefined; // an unreadable file is no key; its text is not echoed
    }
  }
  const key = value?.trim();
  return key ? key : undefined;
}

/** Without a reset time from claude, the API serves this long before the subscription is asked again (one research tick is 30 minutes). */
export const DEFAULT_API_HOLD_MS = 15 * 60_000;
/** The API never serves for longer than this on claude's word alone; the subscription is asked again after it. A 5 hour window fits. */
export const MAX_API_HOLD_MS = 6 * 3_600_000;

/**
 * The real dollars the API has spent in the last 24 hours, for `ApiBrain`'s `spentUsd`: what API runs reported, with a run still in
 * flight, or ended with no cost, charged at its task's per-run cap. Read from the datastore on every call, so it is never stale, and a
 * read that fails makes ApiBrain refuse (fail closed).
 */
export function apiSpentUsd(store: Pick<Datastore, "apiSpendSince">, now: () => Date = () => new Date(), routing: Record<ApiTask, ApiRoute> = API_DEFAULT_ROUTING): () => number {
  const caps = { judge: routing.judge.maxBudgetUsd, propose: routing.propose.maxBudgetUsd };
  return () => store.apiSpendSince(new Date(now().getTime() - 24 * 3_600_000).toISOString(), caps).chargedUsd;
}

type PrimaryBrain =Brain & { staleAfterMs(task: string): number };

export interface FallbackBrainOptions {
  /** The subscription backend (ClaudeCodeBrain). */
  primary: PrimaryBrain;
  /** The API backend (ApiBrain). */
  api: Brain;
  now?: () => Date;
  log?: (line: string) => void;
  /** With a dry run, the API request a fallback would send is logged as well (it sends nothing). */
  dryRun?: boolean;
}

/**
 * The Brain the worker holds when the fallback is on: claude first, always. A rate-limited claude run (any task: the window is one
 * window) starts a hold until the reset time claude gave, clamped to between now and `MAX_API_HOLD_MS` from now, else for
 * `DEFAULT_API_HOLD_MS`. The run that hit the limit, and each judge or propose run during the hold, is served by the API; once the hold is
 * over claude is asked again. If the API refuses (its daily cap) or fails, nothing falls back further.
 */
export class FallbackBrain implements Brain {
  private holdUntil = 0;
  private readonly primary: PrimaryBrain;
  private readonly api: Brain;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly dryRun: boolean;

  constructor(o: FallbackBrainOptions) {
    this.primary = o.primary;
    this.api = o.api;
    this.now = o.now ?? (() => new Date());
    this.log = o.log ?? console.log;
    this.dryRun = o.dryRun ?? false;
  }

  private holding(task: BrainTask): task is ApiTask & BrainTask {
    return isApiTask(task) && this.now().getTime() < this.holdUntil;
  }

  /** The route a run of `task` would take now: the API's during a hold (judge and propose), else the subscription's. */
  routeFor(task: BrainTask): { backend: BrainBackend; model: string; maxBudgetUsd?: number } {
    return this.holding(task) ? this.api.routeFor(task) : this.primary.routeFor(task);
  }

  /** The subscription's route whatever is being served, for Est. usage caps. */
  primaryRouteFor(task: BrainTask): { backend: BrainBackend; model: string; maxBudgetUsd?: number } {
    return this.primary.routeFor(task);
  }

  staleAfterMs(task: string): number {
    return this.primary.staleAfterMs(task);
  }

  async run<T = string>(task: BrainTask, input: BrainInput, opts?: BrainRunOptions): Promise<BrainRun<T>> {
    if (this.holding(task)) return this.api.run<T>(task, input, opts);
    try {
      const run = await this.primary.run<T>(task, input, opts);
      // A dry run spawns nothing, so nothing is rate-limited; show the request the fallback would send as well.
      if (run.dryRun && this.dryRun && isApiTask(task)) await this.api.run(task, input, opts);
      return run;
    } catch (e) {
      if (!(e instanceof BrainError) || e.kind !== "rate-limited") throw e;
      this.startHold(e);
      if (!isApiTask(task)) throw e; // spec and build wait for the window to reset
      try {
        return await this.api.run<T>(task, input, opts);
      } catch (apiError) {
        // The API will not take the work over because of its own cap: the run is the rate limit it was.
        if (apiError instanceof BrainError && apiError.kind === "rate-limited") throw e;
        throw apiError;
      }
    }
  }

  private startHold(e: BrainError): void {
    const now = this.now().getTime();
    const reset = e.resetsAt?.getTime();
    const until = reset !== undefined && reset > now ? Math.min(reset, now + MAX_API_HOLD_MS) : now + DEFAULT_API_HOLD_MS;
    // A later limit never shortens a hold that is running.
    if (until > this.holdUntil) {
      this.holdUntil = until;
      this.log(`[brain] the subscription window is exhausted; judge and propose use the API until ${new Date(until).toISOString()}, spec and build wait`);
    }
  }
}
