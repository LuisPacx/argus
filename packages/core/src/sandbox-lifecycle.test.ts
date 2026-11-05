import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BrainRunOptions } from "./brain.ts";
import { buildHomeFor, removeTree, runNextBuild, sweepStaleSeals } from "./build-runner.ts";
import { dataIdFor, ownerAlive, ownerState, ownerToken, parseProcStat, type ProcStatRead } from "./sandbox.ts";
import { makeHarness, type Harness } from "./testing/build-harness.ts";
import { tempDir, tempPath } from "./testing/temp.ts";
import { untilExists } from "./testing/wait.ts";

// Three review findings of ticket 15 (ff4c3aa): who may reap a container, when a stop can be too early, and a seal that cannot be removed.

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

/** A pid that has existed and is gone. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(r.stdout);
}

describe("who owns a container: only a dead owner's containers of this data dir are reaped", { timeout: 60_000 }, () => {
  const seed = (h: Harness, name: string, labels: Record<string, string>) => {
    mkdirSync(h.podmanState, { recursive: true });
    writeFileSync(join(h.podmanState, `${name}.json`), JSON.stringify({ name, id: `id-${name}`, labels }));
  };

  it("ownerToken names a process by pid and start time, and a reused pid is not the same owner", () => {
    const mine = ownerToken();
    expect(mine).toMatch(/^\d+\.\d+$/);
    expect(ownerAlive(mine)).toBe(true);
    expect(ownerAlive(`${process.pid}.1`)).toBe(false); // this pid, another start time: pid reuse
    expect(ownerAlive(`${deadPid()}.123456789`)).toBe(false);
    for (const junk of ["", "x", "12", "12.", ".12", "1.2.3", "-1.5", "1e3.5"]) expect(ownerAlive(junk), junk).toBe(false);
  });

  it("an unreadable /proc never means a dead owner; only a vanished process does", () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    const reader = (r: ProcStatRead) => () => r;
    const unknown = reader("unknown");
    expect(ownerState("4242.500", reader("gone"))).toBe("dead");
    expect(ownerState("4242.500", unknown)).toBe("unknown"); // EMFILE, EACCES, EIO...
    expect(ownerState("4242.500", reader({ state: "S", ticks: 500 }))).toBe("alive");
    expect(ownerState("4242.500", reader({ state: "S", ticks: 501 }))).toBe("dead"); // reused pid
    expect(ownerState("4242.500", reader({ state: "Z", ticks: 500 }))).toBe("dead");
    expect(ownerState("4242.0", reader({ state: "S", ticks: 500 }))).toBe("unknown"); // a start time of 0 proves nothing
    expect(ownerState("4242.0", reader("gone"))).toBe("unknown");
    expect(ownerAlive("4242.500", unknown)).toBe(false); // alive means provably alive; callers that reap use ownerState
    // The real reader: ENOENT/ESRCH is gone, anything else unknown.
    expect(parseProcStat(() => { throw err("ENOENT"); })).toBe("gone");
    expect(parseProcStat(() => { throw err("ESRCH"); })).toBe("gone");
    for (const code of ["EMFILE", "EACCES", "EIO", "ENFILE"]) expect(parseProcStat(() => { throw err(code); }), code).toBe("unknown");
    expect(parseProcStat(() => "garbage")).toBe("unknown");
    // Minting never yields a start time of 0: it fails the launch loudly instead.
    expect(() => ownerToken(4242, unknown)).toThrow(/start time/);
    expect(() => ownerToken(4242, reader("gone"))).toThrow(/start time/);
    expect(ownerToken(4242, reader({ state: "S", ticks: 77 }))).toBe("4242.77");
  });

  it("a live Build's seal and container are left alone when /proc cannot be read", async () => {
    const dataDir = tempDir("argus-sweep-unknown-");
    mkdirSync(join(dataDir, "proposals/1/seal-4242.500-abc123/work"), { recursive: true });
    mkdirSync(join(dataDir, "proposals/1/seal-4343.600-def456/work"), { recursive: true });
    const reader = (pid: number): ProcStatRead => (pid === 4242 ? "unknown" : "gone");
    const lines: string[] = [];
    const removed = sweepStaleSeals(dataDir, (l) => lines.push(l), reader);
    expect(removed.map((p) => p.slice(dataDir.length + 1))).toEqual(["proposals/1/seal-4343.600-def456"]);
    expect(readdirSync(join(dataDir, "proposals/1"))).toEqual(["seal-4242.500-abc123"]);
    expect(lines.filter((l) => l.includes("seal-4242.500-abc123") && l.includes("left alone"))).toHaveLength(1);

    const h = makeHarness();
    const mine = dataIdFor(h.dataDir);
    mkdirSync(h.podmanState, { recursive: true });
    for (const [name, owner] of [["argus-build-1-aaaaaaa1", "4242.500"], ["argus-build-2-bbbbbbb2", "4343.600"]] as const)
      writeFileSync(join(h.podmanState, `${name}.json`), JSON.stringify({ name, id: `id-${name}`, labels: { "argus.build": name.split("-")[2]!, "argus.data": mine, "argus.owner": owner } }));
    const clines: string[] = [];
    const reaped = await h.sandbox.reconcile((l) => clines.push(l), reader);
    expect(reaped).toEqual(["argus-build-2-bbbbbbb2"]);
    expect(h.containers()).toEqual(["argus-build-1-aaaaaaa1"]);
    expect(clines.filter((l) => l.includes("argus-build-1-aaaaaaa1") && l.includes("left alone"))).toHaveLength(1);
  });

  it("a live owner's container survives, another data dir's survives, a dead owner's is reaped (and the labels the Build containers carry say so)", async () => {
    const h = makeHarness();
    const mine = dataIdFor(h.dataDir);
    const other = dataIdFor(join(h.root, "some-other-checkout", ".data"));
    const dead = `${deadPid()}.123456789`;
    const live = ownerToken();
    seed(h, "argus-build-1-aaaaaaa1", { "argus.build": "1", "argus.data": mine, "argus.owner": live }); // a worker still running (a --once beside the daemon)
    seed(h, "argus-egress-1-aaaaaaa1", { "argus.build": "1", "argus.data": mine, "argus.owner": live });
    seed(h, "argus-build-2-bbbbbbb2", { "argus.build": "2", "argus.data": other, "argus.owner": dead }); // another data dir, owner dead: not ours to reap
    seed(h, "argus-build-3-ccccccc3", { "argus.build": "3", "argus.data": mine, "argus.owner": dead }); // reaped
    seed(h, "argus-egress-3-ccccccc3", { "argus.build": "3", "argus.data": mine, "argus.owner": dead }); // reaped
    seed(h, "argus-build-4-ddddddd4", { "argus.build": "4", "argus.data": mine, "argus.owner": `${process.pid}.1` }); // reused pid: reaped
    seed(h, "argus-build-5-eeeeeee5", { "argus.build": "5" }); // no owner at all (an older argus): cannot be shown dead, left alone
    seed(h, "argus-build-6-fffffff6", { "argus.build": "6", "argus.data": mine, "argus.owner": "garbage" }); // unreadable owner: left alone
    seed(h, "supabase_db_workers", { "com.docker.compose.project": "supabase" });
    seed(h, "my-own-thing", { "argus.build": "1", "argus.data": mine, "argus.owner": dead }); // our labels, not our name

    const lines: string[] = [];
    const removed = await h.sandbox.reconcile((l) => lines.push(l));

    expect(removed.sort()).toEqual(["argus-build-3-ccccccc3", "argus-build-4-ddddddd4", "argus-egress-3-ccccccc3"]);
    expect(h.containers()).toEqual([
      "argus-build-1-aaaaaaa1",
      "argus-build-2-bbbbbbb2",
      "argus-build-5-eeeeeee5",
      "argus-build-6-fffffff6",
      "argus-egress-1-aaaaaaa1",
      "my-own-thing",
      "supabase_db_workers",
    ]);
    const touched = [...call(h.podmanCalls(), "stop"), ...call(h.podmanCalls(), "rm")].map((c) => c.at(-1));
    expect(new Set(touched)).toEqual(new Set(["argus-build-3-ccccccc3", "argus-egress-3-ccccccc3", "argus-build-4-ddddddd4"]));
    expect(lines.join("\n")).toContain("removed leftover Build container argus-build-3-ccccccc3");
  });

  it("every container a sandbox starts is labelled with its data dir and its owner, and its own reconcile leaves it alone", async () => {
    const h = makeHarness();
    const r = await (async () => {
      const p = h.seedApproved("Cat Coin");
      await runNextBuild(h.store, h.brain, h.options);
      return p;
    })();
    expect(h.store.getProposal(r.id)!.status).toBe("built");
    const runs = call(h.podmanCalls(), "run");
    expect(runs.length).toBeGreaterThanOrEqual(4); // sidecar, agent, sidecar, install, bundle
    for (const c of runs) {
      const labels = c.flatMap((a, i) => (a === "--label" ? [c[i + 1]!] : []));
      expect(labels, c.join(" ")).toContain(`argus.data=${dataIdFor(h.dataDir)}`);
      expect(labels, c.join(" ")).toContain(`argus.owner=${ownerToken()}`);
    }
  });
});

describe("stop() cannot be too early: the container is ended again once the podman client has exited", { timeout: 60_000 }, () => {
  it("a stop that comes before `podman run` has created the container is retried after the client exits, so the container does not live on", async () => {
    const started = tempPath("run-started");
    const gate = tempPath("run-gate");
    const h = makeHarness({
      claudeEnv: { FAKE_CLAUDE_MODE: "hang-stubborn" },
      killGraceMs: 3000, // the client outlives the first stop
      podmanEnv: { FAKE_PODMAN_RUN_STARTED: started, FAKE_PODMAN_RUN_GATE: gate },
    });
    const ac = new AbortController();
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options, ac.signal);
    await untilExists(started); // the client is up, creating the container: nothing exists to stop yet
    ac.abort();
    // The first stop has finished: it ended the sidecar, and found no container (there is none yet) to end.
    const container = () => call(h.podmanCalls(), "run").map((c) => c[c.indexOf("--name") + 1]!).find((n) => n.startsWith("argus-build-"))!;
    for (const end = Date.now() + 20_000; call(h.podmanCalls(), "rm").length < 2 && Date.now() < end; ) await sleep(20);
    expect(call(h.podmanCalls(), "rm").length).toBe(2); // the container's (a no-op) and the sidecar's
    expect(h.containers()).toEqual([]);
    writeFileSync(gate, ""); // now the client creates and starts the container, after the stop that missed it
    await untilExists(h.started);
    expect(h.containers().filter((n) => n.startsWith("argus-build-"))).toHaveLength(1);
    expect(await running).toEqual({ proposalId: p.id, result: "build-failed" });
    expect(h.containers()).toEqual([]);
    expect(alive(h.calls(h.claudeLog)[0]!.pid)).toBe(false);
    // The container was ended by a stop and rm that came after the one that missed it.
    const name = container();
    expect(call(h.podmanCalls(), "rm").filter((c) => c.at(-1) === name).length).toBeGreaterThanOrEqual(2);
  });

  it("an abort that lands between launch() and the child being spawned spawns nothing and ends the sidecar", async () => {
    const h = makeHarness();
    const ac = new AbortController();
    // The signal fires just as the sandbox hands back the run: after launch() resolved, before any listener could be attached.
    const launching: NonNullable<BrainRunOptions["sandbox"]> = (job) =>
      h.sandbox.launch({ role: "agent", buildId: 1, cwd: job.cwd, mounts: [job.cwd], home: tempDir("argus-home-"), args: job.args, timeoutMs: job.timeoutMs }).then((run) => {
        ac.abort();
        return run;
      });
    await expect(h.brain.run("build", { prompt: "1", slash: "implement-spec" }, { cwd: h.root, signal: ac.signal, sandbox: launching })).rejects.toMatchObject({ kind: "interrupted" });
    const calls = h.podmanCalls();
    expect(call(calls, "run").filter((c) => !c.includes("-d"))).toEqual([]); // the Build container was never started
    const sidecar = call(calls, "run").map((c) => c[c.indexOf("--name") + 1]!).find((n) => n.startsWith("argus-egress-"))!;
    expect(call(calls, "rm").some((c) => c.at(-1) === sidecar)).toBe(true);
    expect(h.containers()).toEqual([]);
    expect(h.calls(h.claudeLog)).toEqual([]);
  });

  it("an abort that lands after the install container was launched starts no install", async () => {
    const h = makeHarness();
    const ac = new AbortController();
    const real = h.sandbox.launch.bind(h.sandbox);
    h.sandbox.launch = async (job) => {
      const run = await real(job);
      if (job.role === "install") ac.abort();
      return run;
    };
    const p = h.seedApproved("Cat Coin");
    expect(await runNextBuild(h.store, h.brain, h.options, ac.signal)).toEqual({ proposalId: p.id, result: "build-failed" });
    const names = call(h.podmanCalls(), "run").map((c) => c[c.indexOf("--name") + 1]!);
    expect(names.some((n) => n.startsWith("argus-install-"))).toBe(false);
    expect(h.containers()).toEqual([]);
  });

  it("an abort while the sidecar is not yet listening ends the wait at once and removes the sidecar", async () => {
    const h = makeHarness({ podmanEnv: { FAKE_PODMAN_EGRESS_SILENT: "1" } });
    h.options.sandbox = h.makeSandbox({ egressWaitMs: 60_000 });
    const ac = new AbortController();
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options, ac.signal);
    for (const end = Date.now() + 20_000; call(h.podmanCalls(), "logs").length < 1 && Date.now() < end; ) await sleep(20);
    ac.abort();
    expect(await running).toEqual({ proposalId: p.id, result: "build-failed" });
    expect(h.calls(h.claudeLog)).toEqual([]);
    expect(h.containers()).toEqual([]);
  });
});

describe("a seal that cannot be removed does not skip the rest of the cleanup", { timeout: 60_000 }, () => {
  it("removeTree removes a tree holding a mode-000 directory, and reports (never throws) what it cannot", () => {
    const dir = tempDir("argus-locked-");
    mkdirSync(join(dir, "a/locked/inner"), { recursive: true });
    writeFileSync(join(dir, "a/locked/inner/f"), "x");
    chmodSync(join(dir, "a/locked/inner"), 0o000);
    chmodSync(join(dir, "a/locked"), 0o000);
    expect(removeTree(join(dir, "a"))).toBeUndefined();
    expect(existsSync(join(dir, "a"))).toBe(false);
    expect(removeTree(join(dir, "never-there"))).toBeUndefined();
    // A path whose parent cannot be written to: reported, not thrown.
    mkdirSync(join(dir, "ro/child"), { recursive: true });
    chmodSync(join(dir, "ro"), 0o500);
    try {
      expect(removeTree(join(dir, "ro/child"))).toMatch(/EACCES|permission/i);
    } finally {
      chmodSync(join(dir, "ro"), 0o700);
    }
  });

  it("a Build whose install left a mode-000 directory is still built, its run is closed and its seal is gone", async () => {
    const h = makeHarness({ podmanEnv: { FAKE_PODMAN_INSTALL_LOCKED: "1" } });
    const p = h.seedApproved("Cat Coin");
    expect(await runNextBuild(h.store, h.brain, h.options)).toEqual({ proposalId: p.id, result: "built" });
    expect(h.store.brainRunsFor(p.id)).toMatchObject([{ exitStatus: "success" }]);
    expect(h.store.getProposal(p.id)!.brainRunInFlightSince).toBeNull();
    const proposalDir = join(h.dataDir, "proposals", String(p.id));
    expect(readdirSync(proposalDir).filter((n) => n.startsWith("seal-"))).toEqual([]);
    expect(existsSync(buildHomeFor(h.dataDir, p.id))).toBe(false);
    expect(h.logs.join("\n")).not.toContain("could not remove");
  });

  it("sweepStaleSeals removes seals whose Build is gone (mode-000 contents included) and leaves a live Build's seal and everything else", () => {
    const dataDir = tempDir("argus-sweep-");
    const mk = (path: string, locked = false) => {
      mkdirSync(join(dataDir, path, "work/export/locked"), { recursive: true });
      writeFileSync(join(dataDir, path, "work/export/locked/f"), "x");
      if (locked) chmodSync(join(dataDir, path, "work/export/locked"), 0o000);
    };
    const gone = `seal-${deadPid()}.123456789-abc123`;
    mk(`proposals/1/${gone}`, true);
    mk(`proposals/1/seal-${process.pid}.1-reused`, true); // a reused pid is a dead owner
    mk(`proposals/2/seal-${ownerToken()}-live00`); // this very process: a live Build
    mk("proposals/3/seal-legacy"); // no owner in its name: cannot be shown dead
    mk("proposals/3/home");
    writeFileSync(join(dataDir, "proposals/3/spec.md"), "spec");
    const lines: string[] = [];
    const removed = sweepStaleSeals(dataDir, (l) => lines.push(l));
    expect(removed.map((p) => p.slice(dataDir.length + 1)).sort()).toEqual([`proposals/1/${gone}`, `proposals/1/seal-${process.pid}.1-reused`].sort());
    expect(readdirSync(join(dataDir, "proposals/1"))).toEqual([]);
    expect(readdirSync(join(dataDir, "proposals/2"))).toHaveLength(1);
    expect(readdirSync(join(dataDir, "proposals/3")).sort()).toEqual(["home", "seal-legacy", "spec.md"]);
    expect(lines.join("\n")).toContain("removed stale seal");
    expect(sweepStaleSeals(join(dataDir, "no-proposals-here"), () => {})).toEqual([]);
    expect(statSync(join(dataDir, "proposals/3/spec.md")).isFile()).toBe(true);
    expect(readFileSync(join(dataDir, "proposals/3/spec.md"), "utf8")).toBe("spec");
  });
});
