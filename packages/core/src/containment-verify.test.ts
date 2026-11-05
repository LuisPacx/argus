import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCRATCH_PREFIX, Teardown, scratchPrefixFor, sweepStaleScratch } from "./containment-verify.ts";
import { ownerToken, type OwnerState } from "./sandbox.ts";
import { tempDir } from "./testing/temp.ts";

/** A run whose stop() stays pending until the test lets it finish. */
function gatedRun() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const stops: string[] = [];
  return { stops, release, run: { stop: async () => void (await gate, stops.push("stop")) } };
}

describe("Teardown: one in-flight cleanup, and nothing launches once it has started", () => {
  it("a second stop() awaits the cleanup already running instead of returning early, and the cleanup body runs once", async () => {
    const g = gatedRun();
    let finished = 0;
    const td = new Teardown<typeof g.run>(async () => void finished++);
    await td.launch(async () => g.run);

    const first = td.stop();
    let secondDone = false;
    const second = td.stop().then(() => (secondDone = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(secondDone, "second signal must not return while the first cleanup is mid-way").toBe(false);
    expect(finished).toBe(0);

    g.release();
    await Promise.all([first, second]);
    expect(secondDone).toBe(true);
    expect(finished).toBe(1);
    expect(g.stops).toEqual(["stop"]);
  });

  it("launch() throws once the cleanup has started, without calling the launcher", async () => {
    const td = new Teardown<{ stop(): Promise<void> }>(async () => {});
    const stopping = td.stop();
    let called = false;
    await expect(td.launch(async () => ((called = true), { stop: async () => {} }))).rejects.toThrow(/shutting down/);
    expect(called).toBe(false);
    await stopping;
  });

  it("a container whose launch was still in flight when the cleanup began is stopped by launch() itself and then refused", async () => {
    let finishLaunch!: () => void;
    const launching = new Promise<void>((r) => (finishLaunch = r));
    const stopped: string[] = [];
    const td = new Teardown<{ stop(): Promise<void> }>(async () => {});
    const pending = td.launch(async () => (await launching, { stop: async () => void stopped.push("late run") }));
    const rejected = expect(pending).rejects.toThrow(/shutting down/);
    await td.stop(); // the cleanup finds no run yet
    finishLaunch();
    await rejected;
    expect(stopped).toEqual(["late run"]);
  });

  it("a run that fails to stop does not keep the others from stopping or the cleanup body from running", async () => {
    const stopped: string[] = [];
    let finished = false;
    const td = new Teardown<{ stop(): Promise<void> }>(async () => void (finished = true));
    await td.launch(async () => ({ stop: async () => Promise.reject(new Error("boom")) }));
    await td.launch(async () => ({ stop: async () => void stopped.push("second") }));
    await td.stop();
    expect(stopped).toEqual(["second"]);
    expect(finished).toBe(true);
  });
});

describe("sweepStaleScratch: scratch dirs of dead verify:contain runs", () => {
  const cacheWith = (...names: string[]) => {
    const dir = tempDir("argus-sweep-");
    for (const n of names) {
      mkdirSync(join(dir, n));
      writeFileSync(join(dir, n, "token"), "x");
    }
    return dir;
  };
  const named = (token: string) => `${scratchPrefixFor(token)}abc123`;

  it("removes the directory of a dead owner and leaves a live one, an unknown one, and unrelated entries alone", () => {
    const states: Record<string, OwnerState> = { "10.1": "dead", "11.1": "alive", "12.1": "unknown" };
    const cache = cacheWith(named("10.1"), named("11.1"), named("12.1"), `${SCRATCH_PREFIX}oldformat`, "something-else");
    const removed = sweepStaleScratch(cache, { state: (t) => states[t] ?? "unknown" });
    expect(removed).toEqual([named("10.1")]);
    expect(existsSync(join(cache, named("10.1")))).toBe(false);
    for (const kept of [named("11.1"), named("12.1"), `${SCRATCH_PREFIX}oldformat`, "something-else"]) expect(existsSync(join(cache, kept)), kept).toBe(true);
  });

  it("with the real owner check: this process is alive, a pid that cannot exist is dead", () => {
    const mine = named(ownerToken());
    const gone = named("999999999.1");
    const cache = cacheWith(mine, gone);
    expect(sweepStaleScratch(cache)).toEqual([gone]);
    expect(existsSync(join(cache, mine))).toBe(true);
  });

  it("never follows a symlink named like a stale scratch dir", () => {
    const cache = tempDir("argus-sweep-");
    const victim = tempDir("argus-sweep-victim-");
    writeFileSync(join(victim, "precious"), "x");
    symlinkSync(victim, join(cache, named("10.1")));
    expect(sweepStaleScratch(cache, { state: () => "dead" })).toEqual([]);
    expect(existsSync(join(victim, "precious"))).toBe(true);
  });

  it("a missing cache directory is not an error", () => {
    expect(sweepStaleScratch(join(tempDir("argus-sweep-"), "nope"))).toEqual([]);
  });
});
