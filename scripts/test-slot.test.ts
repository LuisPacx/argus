import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../packages/core/src/testing/temp";
// @ts-expect-error plain .mjs script, no types
import { acquire, formatStatus, holdSlot, readStartTime, slotDir, tryAcquire, waitForFree } from "./test-slot.mjs";

const here = import.meta.dirname;
const me = { worktree: "wt-me", command: "pnpm check" };
const fresh = () => tempDir("argus-slot-test-");

/** A pid that is certainly dead: a child that already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  return r.pid;
}

/** Plant a slot file as if another process held it. */
function plant(dir: string, n: number, holder: Record<string, unknown>) {
  writeFileSync(join(dir, `slot-${n}.json`), JSON.stringify({ worktree: "other", command: "pnpm check", since: 1_700_000_000_000, ...holder }));
}

const liveHolder = () => ({ pid: process.pid, startTime: readStartTime(process.pid) });

describe("test slot directory", () => {
  it("defaults under XDG_STATE_HOME or ~/.local/state, never /tmp, and honours the override", () => {
    expect(slotDir({ ARGUS_TEST_SLOT_DIR: "/x/y" })).toBe("/x/y");
    expect(slotDir({ XDG_STATE_HOME: "/s" })).toBe("/s/argus/test-slots");
    expect(slotDir({ HOME: "/home/u" })).toBe("/home/u/.local/state/argus/test-slots");
  });
});

describe("tryAcquire", () => {
  it("takes the two slots, then refuses a third while both holders are live", () => {
    const dir = fresh();
    const a = tryAcquire({ dir, ...me });
    const b = tryAcquire({ dir, ...me });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(tryAcquire({ dir, ...me })).toBeNull();
    a.release();
    const c = tryAcquire({ dir, ...me });
    expect(c).not.toBeNull();
    b.release();
    c.release();
    expect(readdirSync(dir).filter((f: string) => f.startsWith("slot-"))).toEqual([]);
  });

  it("reclaims a slot whose holder pid is dead", () => {
    const dir = fresh();
    plant(dir, 0, { pid: deadPid(), startTime: "1" });
    plant(dir, 1, liveHolder());
    const got = tryAcquire({ dir, ...me });
    expect(got?.slot).toBe(0);
    got.release();
  });

  it("reclaims a slot whose pid is alive but has a different start time (pid reuse)", () => {
    const dir = fresh();
    plant(dir, 0, { pid: process.pid, startTime: "not-my-start-time" });
    plant(dir, 1, liveHolder());
    const got = tryAcquire({ dir, ...me });
    expect(got?.slot).toBe(0);
    got.release();
  });

  it("reclaims an old unreadable slot file (crash mid-write) but respects a brand new one", () => {
    const dir = fresh();
    const file = join(dir, "slot-0.json");
    writeFileSync(file, "");
    plant(dir, 1, liveHolder());
    expect(tryAcquire({ dir, ...me })).toBeNull();
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    const got = tryAcquire({ dir, ...me });
    expect(got?.slot).toBe(0);
    got.release();
  });

  it("two acquirers racing for the last slot cannot both win", async () => {
    for (let round = 0; round < 20; round++) {
      const dir = fresh();
      plant(dir, 0, liveHolder());
      const results = await Promise.all([0, 1, 2, 3].map(async () => tryAcquire({ dir, ...me })));
      expect(results.filter(Boolean)).toHaveLength(1);
    }
  });

  it("racing reclaimers of one stale slot cannot both win", async () => {
    for (let round = 0; round < 20; round++) {
      const dir = fresh();
      plant(dir, 0, { pid: deadPid(), startTime: "1" });
      plant(dir, 1, liveHolder());
      const results = await Promise.all([0, 1, 2].map(async () => tryAcquire({ dir, ...me })));
      expect(results.filter(Boolean)).toHaveLength(1);
    }
  });

  it("records pid, start time, worktree, command and since", () => {
    const dir = fresh();
    const a = tryAcquire({ dir, ...me });
    const rec = JSON.parse(readFileSync(join(dir, `slot-${a.slot}.json`), "utf8"));
    expect(rec).toMatchObject({ pid: process.pid, worktree: "wt-me", command: "pnpm check" });
    expect(typeof rec.since).toBe("number");
    expect(rec.startTime).toBe(readStartTime(process.pid));
    a.release();
  });
});

describe("acquire (waiting)", () => {
  it("prints a waiting line naming the holders, then proceeds when a slot frees", async () => {
    const dir = fresh();
    plant(dir, 0, { ...liveHolder(), worktree: "wt-alpha" });
    plant(dir, 1, { ...liveHolder(), worktree: "wt-beta" });
    const lines: string[] = [];
    let polls = 0;
    const got = await acquire({
      dir,
      ...me,
      pollMs: 5,
      timeoutMs: 10_000,
      onWait: (line: string) => lines.push(line),
      sleep: async () => {
        if (++polls === 3) plant(dir, 1, { pid: deadPid(), startTime: "1" }); // the holder dies
      },
    });
    expect(got.slot).toBe(1);
    expect(lines[0]).toMatch(/^check: waiting for a test slot \(2 of 2 held: /);
    expect(lines[0]).toContain("wt-alpha");
    expect(lines[0]).toContain("wt-beta");
    expect(lines[0]).toContain(`pid ${process.pid}`);
    got.release();
  });

  it("times out with a message naming the holders", async () => {
    const dir = fresh();
    plant(dir, 0, { ...liveHolder(), worktree: "wt-alpha" });
    plant(dir, 1, { ...liveHolder(), worktree: "wt-beta" });
    await expect(acquire({ dir, ...me, pollMs: 5, timeoutMs: 30, onWait: () => {} })).rejects.toThrow(/timed out.*wt-alpha.*wt-beta/s);
  });

  it("waitForFree returns without taking a slot", async () => {
    const dir = fresh();
    plant(dir, 0, liveHolder());
    await waitForFree({ dir, pollMs: 5, timeoutMs: 1000, onWait: () => {} });
    expect(existsSync(join(dir, "slot-1.json"))).toBe(false);
  });
});

describe("status", () => {
  it("reports 0 held: both free, exit 0", () => {
    const { text, code } = formatStatus({ dir: fresh() });
    expect(code).toBe(0);
    expect(text).toMatch(/slot 0: free/);
    expect(text).toMatch(/slot 1: free/);
  });

  it("reports 1 held: one free, exit 0, with holder details", () => {
    const dir = fresh();
    plant(dir, 0, { ...liveHolder(), worktree: "wt-alpha", command: "pnpm check" });
    const { text, code } = formatStatus({ dir });
    expect(code).toBe(0);
    expect(text).toMatch(/slot 0: held by wt-alpha/);
    expect(text).toContain(`pid ${process.pid}`);
    expect(text).toMatch(/slot 1: free/);
  });

  it("reports 2 held: exit 1", () => {
    const dir = fresh();
    plant(dir, 0, liveHolder());
    plant(dir, 1, liveHolder());
    const { text, code } = formatStatus({ dir });
    expect(code).toBe(1);
    expect(text).not.toMatch(/free/);
  });

  it("counts stale holders as free", () => {
    const dir = fresh();
    plant(dir, 0, { pid: deadPid(), startTime: "1" });
    plant(dir, 1, { pid: process.pid, startTime: "wrong" });
    const { text, code } = formatStatus({ dir });
    expect(code).toBe(0);
    expect(text).not.toMatch(/held/);
  });
});

describe("CLI", () => {
  it("status exits 1 when both slots are held and 0 otherwise, using ARGUS_TEST_SLOT_DIR", () => {
    const dir = fresh();
    const env = { ...process.env, ARGUS_TEST_SLOT_DIR: dir };
    const run = () => spawnSync(process.execPath, [join(here, "test-slot.mjs"), "status"], { env, encoding: "utf8" });
    expect(run().status).toBe(0);
    plant(dir, 0, liveHolder());
    plant(dir, 1, liveHolder());
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("held");
  });
});

describe("holdSlot releases on signals and exit", () => {
  const holder = join(here, "test-slot-holder.fixture.mjs");
  const waitExit = (child: ReturnType<typeof spawn>) => new Promise<void>((resolve) => child.on("exit", () => resolve()));

  async function runHolder(dir: string, how: "term" | "int" | "throw" | "end") {
    const child = spawn(process.execPath, [holder, how], { env: { ...process.env, ARGUS_TEST_SLOT_DIR: dir }, stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve())); // "held" printed
    expect(existsSync(join(dir, "slot-0.json"))).toBe(true);
    if (how === "term") child.kill("SIGTERM");
    if (how === "int") child.kill("SIGINT");
    await waitExit(child);
    expect(existsSync(join(dir, "slot-0.json"))).toBe(false);
  }

  it("on SIGTERM", async () => runHolder(fresh(), "term"));
  it("on SIGINT", async () => runHolder(fresh(), "int"));
  it("on an uncaught error", async () => runHolder(fresh(), "throw"));
  it("on process.exit", async () => runHolder(fresh(), "end"));
});

describe("real processes racing", () => {
  it("four processes racing for the last slot: exactly one wins", async () => {
    const dir = fresh();
    plant(dir, 0, liveHolder());
    const fixture = join(here, "test-slot-holder.fixture.mjs");
    const kids = [0, 1, 2, 3].map(() => spawn(process.execPath, [fixture, "race"], { env: { ...process.env, ARGUS_TEST_SLOT_DIR: dir }, stdio: ["pipe", "pipe", "inherit"] }));
    const results = await Promise.all(kids.map((k) => new Promise<string>((resolve) => k.stdout.once("data", (d) => resolve(String(d).trim())))));
    for (const k of kids) k.stdin.end(); // winners hold until every result is in
    await Promise.all(kids.map((k) => new Promise<void>((resolve) => k.on("exit", () => resolve()))));
    expect(results.filter((r) => r === "won")).toHaveLength(1);
    expect(results.filter((r) => r === "lost")).toHaveLength(3);
  });
});

describe("a signalled check stops its whole step tree before releasing the slot", () => {
  const fixture = join(here, "test-slot-holder.fixture.mjs");
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  async function until(what: string, cond: () => boolean, ms = 10_000) {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(10);
    }
  }
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
  });

  /** Start the parent fixture (hold slot, run parent -> mid -> grandchild) and wait until the grandchild exists. */
  async function start(mode: "tree" | "tree-stubborn") {
    const slots = fresh();
    const work = fresh();
    const parent = spawn(process.execPath, [fixture, mode], {
      env: { ...process.env, ARGUS_TEST_SLOT_DIR: slots, ARGUS_FIXTURE_DIR: work, ARGUS_FIXTURE_GRACE_MS: mode === "tree" ? "30000" : "300" }, // polite: ample grace, never SIGKILLed
      stdio: ["ignore", "ignore", "ignore"],
    });
    let gc = 0;
    cleanup.push(() => {
      if (gc && alive(gc)) process.kill(gc, "SIGKILL"); // never leave the grandchild behind, even when the test fails
      if (parent.exitCode === null) parent.kill("SIGKILL");
    });
    const exited = new Promise<void>((resolve) => parent.on("exit", () => resolve()));
    await until("grandchild pid", () => existsSync(join(work, "gc.pid")) && readFileSync(join(work, "gc.pid"), "utf8") !== "");
    gc = Number(readFileSync(join(work, "gc.pid"), "utf8")); // known early, for cleanup
    await until("grandchild ready", () => existsSync(join(work, "gc.ready"))); // its signal handler is installed
    await until("slot file", () => existsSync(join(slots, "slot-0.json")));
    expect(alive(gc)).toBe(true);
    return { parent, exited, gc: () => gc, slotFile: join(slots, "slot-0.json"), exitedFile: join(work, "gc.exited") };
  }

  it("SIGTERM: the grandchild is gone, and the slot is never free while it is still running", async () => {
    const t = await start("tree");
    t.parent.kill("SIGTERM");
    let done = false;
    void t.exited.then(() => (done = true));
    while (!done) {
      const slotHeld = existsSync(t.slotFile); // read the slot first, then the marker
      const gcDone = existsSync(t.exitedFile);
      expect(slotHeld || gcDone, "slot released while the grandchild was still running").toBe(true);
      await sleep(5);
    }
    expect(alive(t.gc())).toBe(false);
    expect(existsSync(t.exitedFile)).toBe(true); // it was asked to stop politely and did
    expect(existsSync(t.slotFile)).toBe(false);
    expect(t.parent.exitCode).toBe(128 + 15);
  });

  it("SIGINT is forwarded to the step group like a terminal Ctrl-C would", async () => {
    const t = await start("tree");
    t.parent.kill("SIGINT");
    await t.exited;
    expect(alive(t.gc())).toBe(false);
    expect(existsSync(t.slotFile)).toBe(false);
    expect(t.parent.exitCode).toBe(128 + 2);
  });

  it("a grandchild that ignores SIGTERM is SIGKILLed after the grace period, then the slot is released", async () => {
    const t = await start("tree-stubborn");
    t.parent.kill("SIGTERM");
    await t.exited;
    expect(alive(t.gc())).toBe(false);
    expect(existsSync(t.slotFile)).toBe(false);
  });
});

describe("unusable slot directory", () => {
  it("fails with a message naming the directory and the override", () => {
    const blocker = join(fresh(), "file");
    writeFileSync(blocker, "x");
    const dir = join(blocker, "slots"); // a path below a regular file can never be created
    let message = "";
    try {
      tryAcquire({ dir, ...me });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(dir);
    expect(message).toContain("ARGUS_TEST_SLOT_DIR");
  });
});

describe("holdSlot in process", () => {
  it("returns an idempotent release", async () => {
    const dir = fresh();
    const h = await holdSlot({ dir, ...me, onWait: () => {} });
    h.release();
    h.release();
    expect(existsSync(join(dir, "slot-0.json"))).toBe(false);
  });
});
