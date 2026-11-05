import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ownerState, type OwnerState } from "./sandbox.ts";

/**
 * Support for `scripts/verify-contain.mjs` that is worth testing on its own: the cleanup that must survive a second signal, and the
 * sweep of scratch directories an earlier run left behind. Nothing here talks to podman.
 */

export interface Stoppable {
  stop(): Promise<void>;
}

/**
 * One shared, in-flight cleanup. `stop()` starts it the first time and hands every later caller (a second Ctrl-C, the `finally`
 * block) the same promise, so nobody exits while it is half done. Once it has started, `launch()` refuses: a check that is still
 * running cannot start a container the cleanup would then miss.
 */
export class Teardown<R extends Stoppable> {
  private readonly runs: R[] = [];
  private inflight: Promise<void> | undefined;
  private started = false;
  private readonly aborter = new AbortController();
  private readonly pending = new Set<Promise<R>>();

  /** `finish` runs after every tracked run has been stopped (remove what the label finds, delete the scratch dir). */
  private readonly finish: () => Promise<void> | void;
  constructor(finish: () => Promise<void> | void) {
    this.finish = finish;
  }

  get stopping(): boolean {
    return this.started;
  }

  /**
   * Starts a container through `launcher` (which gets a signal that `stop()` aborts, to hand to the sandbox job) and tracks it for
   * the cleanup. Throws once the cleanup has started. The launch stays pending until it settles, and `stop()` waits for that.
   */
  async launch(launcher: (signal: AbortSignal) => Promise<R>): Promise<R> {
    this.refuseIfStopping();
    const launching = this.launchTracked(launcher);
    this.pending.add(launching);
    try {
      return await launching;
    } finally {
      this.pending.delete(launching);
    }
  }

  private async launchTracked(launcher: (signal: AbortSignal) => Promise<R>): Promise<R> {
    const run = await launcher(this.aborter.signal);
    if (this.started) {
      // The cleanup began while this launch was in flight: this run did not exist when it walked the runs, so it is ours to stop.
      await run.stop().catch(() => {});
      this.refuseIfStopping();
    }
    this.runs.push(run);
    return run;
  }

  stop(): Promise<void> {
    this.started = true;
    this.aborter.abort();
    this.inflight ??= this.run();
    return this.inflight;
  }

  private async run(): Promise<void> {
    // Launches still creating containers (the sidecar start alone can take seconds) finish first, each stopping what it made, so
    // the final label sweep and the process exit cannot overtake a container that appears late.
    await Promise.allSettled([...this.pending]);
    for (const r of this.runs) {
      try {
        await r.stop();
      } catch {
        // The caller's `finish` looks for what is left by label.
      }
    }
    await this.finish();
  }

  private refuseIfStopping(): void {
    if (this.started) throw new Error("verify:contain is shutting down; not starting another container");
  }
}

export const SCRATCH_PREFIX = "argus-verify-contain-";
/** The scratch directory name prefix for a worker: it carries the owner token, so a later run can tell whether the owner is still alive. */
export const scratchPrefixFor = (token: string): string => `${SCRATCH_PREFIX}${token}-`;
const SCRATCH_NAME = /^argus-verify-contain-([1-9][0-9]{0,9}\.[0-9]{1,15})-[A-Za-z0-9]{6}$/;

export interface SweepOptions {
  state?: (token: string) => OwnerState;
  log?: (line: string) => void;
}

/**
 * Deletes the scratch directories in `cacheDir` whose owner is provably dead (a run that was SIGKILLed or lost power). A directory
 * whose name carries no token, whose owner cannot be judged ("unknown"), or that is a symlink or a file, is left alone.
 * Returns the names removed.
 */
export function sweepStaleScratch(cacheDir: string, { state = ownerState, log = () => {} }: SweepOptions = {}): string[] {
  let names: string[];
  try {
    names = readdirSync(cacheDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const token = SCRATCH_NAME.exec(name)?.[1];
    if (token === undefined || state(token) !== "dead") continue;
    const path = join(cacheDir, name);
    try {
      const st = lstatSync(path);
      if (!st.isDirectory() || st.uid !== process.getuid?.()) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
      log(`removed stale scratch directory ${path} (owner ${token} is gone)`);
    } catch (e) {
      log(`could not remove stale scratch directory ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return removed;
}
