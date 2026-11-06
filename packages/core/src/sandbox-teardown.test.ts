import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runNextBuild } from "./build-runner.ts";
import { makeHarness } from "./testing/build-harness.ts";
import { tempPath } from "./testing/temp.ts";
import { untilExists } from "./testing/wait.ts";

// Ticket 03 (hardening), items 1 and 2: a podman that hangs cannot hold up the teardown, and an abort is seen while podman is busy.

const call = (calls: string[][], ...prefix: string[]) => calls.filter((c) => prefix.every((p, i) => c[i] === p));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** The pids of the fake podman calls that hung (they ignore SIGTERM, so only a SIGKILL ends them). */
const hungPids = (file: string): number[] => {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
};
/** Waits for every hung client to be gone; kills any still there (so a failing test leaves none behind) and says whether it had to. */
async function allGone(file: string): Promise<boolean> {
  for (const end = Date.now() + 3000; hungPids(file).some(alive) && Date.now() < end; ) await sleep(20);
  const left = hungPids(file).filter(alive);
  for (const pid of left) process.kill(pid, "SIGKILL");
  return left.length === 0;
}

describe("a podman that hangs cannot hold up the teardown", { timeout: 60_000 }, () => {
  it("a stop and an rm that never return are cut off after the bound, noted in the Build log, and the Build still ends", async () => {
    const pids = tempPath("hung-pids");
    const h = makeHarness({ podmanEnv: { FAKE_PODMAN_HANG: "stop,rm", FAKE_PODMAN_HANG_PIDS: pids } });
    h.options.sandbox = h.makeSandbox({ teardownTimeoutMs: 300 });
    const p = h.seedApproved("Cat Coin");
    const started = Date.now();
    expect(await runNextBuild(h.store, h.brain, h.options)).toEqual({ proposalId: p.id, result: "built" });
    expect(Date.now() - started).toBeLessThan(40_000);
    expect(call(h.podmanCalls(), "stop").length).toBeGreaterThan(0);
    expect(h.logs.filter((l) => /teardown of argus-(build|install|bundle|egress)-\d+-[0-9a-f]{8} timed out/.test(l)).length).toBeGreaterThan(0);
    expect(await allGone(pids)).toBe(true);
  });

  it("an abort with a hung teardown still kills the podman client's process group and the Build ends", async () => {
    const pids = tempPath("hung-pids");
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_MODE: "hang-stubborn" }, killGraceMs: 300, podmanEnv: { FAKE_PODMAN_HANG: "stop,rm", FAKE_PODMAN_HANG_PIDS: pids } });
    h.options.sandbox = h.makeSandbox({ teardownTimeoutMs: 300 });
    const ac = new AbortController();
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options, ac.signal);
    await untilExists(h.started);
    const claude = h.calls(h.claudeLog)[0]!.pid as number;
    try {
      ac.abort();
      expect(await running).toEqual({ proposalId: p.id, result: "build-failed" });
      expect(h.logs.filter((l) => /teardown of argus-build-\d+-[0-9a-f]{8} timed out/.test(l)).length).toBeGreaterThan(0);
      expect(await allGone(pids)).toBe(true);
    } finally {
      // With podman's stop and rm hung, nothing ends the container but its own `--timeout` (conmon's backstop, which the fake does not
      // model): end the fake container's group here so the test leaves nothing behind.
      try {
        process.kill(-claude, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
});

describe("an abort interrupts the wait while podman is busy", { timeout: 60_000 }, () => {
  it("an abort during a `podman logs` poll that never returns is seen at once", async () => {
    const pids = tempPath("hung-pids");
    const h = makeHarness({ podmanEnv: { FAKE_PODMAN_HANG: "logs", FAKE_PODMAN_HANG_PIDS: pids } });
    h.options.sandbox = h.makeSandbox({ egressWaitMs: 60_000, teardownTimeoutMs: 500 }); // the teardown's own `logs` (the sidecar's denials) hangs too
    const ac = new AbortController();
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options, ac.signal);
    for (const end = Date.now() + 20_000; hungPids(pids).length < 1 && Date.now() < end; ) await sleep(10);
    expect(hungPids(pids).length).toBeGreaterThan(0);
    const aborted = Date.now();
    ac.abort();
    expect(await running).toEqual({ proposalId: p.id, result: "build-failed" });
    expect(Date.now() - aborted).toBeLessThan(10_000); // the poll's own bound is 15 s, and a client that ignores SIGTERM never returns
    expect(h.calls(h.claudeLog)).toEqual([]);
    expect(h.containers()).toEqual([]);
    expect(await allGone(pids)).toBe(true);
  });

  it("an abort while the sidecar is being started (`podman run -d` never returns) is seen at once, and the sidecar is removed", async () => {
    const pids = tempPath("hung-pids");
    const h = makeHarness({ podmanEnv: { FAKE_PODMAN_HANG: "run-d", FAKE_PODMAN_HANG_PIDS: pids } });
    const ac = new AbortController();
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options, ac.signal);
    for (const end = Date.now() + 20_000; hungPids(pids).length < 1 && Date.now() < end; ) await sleep(10);
    expect(hungPids(pids).length).toBeGreaterThan(0);
    const aborted = Date.now();
    ac.abort();
    expect(await running).toEqual({ proposalId: p.id, result: "build-failed" });
    expect(Date.now() - aborted).toBeLessThan(10_000); // the start's own bound is 60 s
    expect(call(h.podmanCalls(), "run").filter((c) => !c.includes("-d"))).toEqual([]);
    expect(call(h.podmanCalls(), "rm").length).toBeGreaterThan(0); // what may have been created is ended by name
    expect(await allGone(pids)).toBe(true);
  });
});
