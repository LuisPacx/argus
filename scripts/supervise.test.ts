import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../packages/core/src/testing/temp.ts";
// @ts-expect-error plain .mjs script, no types
import { backoffDelay, exitsLogFile, readState, stateFile, stopFile } from "./supervise.mjs";

const SUPERVISE = path.join(path.dirname(fileURLToPath(import.meta.url)), "supervise.mjs");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const groups: number[] = [];

afterEach(() => {
  for (const pgid of groups.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // ESRCH: already gone.
    }
  }
});

type State = { status: string; childPid: number | null; restarts: number };

// Starts the supervisor in its own process group (as dev-server.mjs does) around a stand-in child.
function start(name: string, childBody: string, flags: string[] = []) {
  const runDir = tempDir("supervise-");
  const sup = spawn(process.execPath, [SUPERVISE, "--name", name, "--run-dir", runDir, "--backoff-ms", "20", "--max-backoff-ms", "100", ...flags, "--", process.execPath, "-e", childBody], {
    detached: true,
    stdio: "ignore",
  });
  const pgid = sup.pid!;
  groups.push(pgid);
  let exit: { code: number | null; signal: string | null } | null = null;
  sup.once("exit", (code, signal) => (exit = { code, signal }));
  return { runDir, pgid, exited: () => exit };
}

async function until<T>(what: string, probe: () => T | null | undefined | false, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = probe();
    if (v) return v;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const state = (runDir: string, name: string) => readState(runDir, name) as State | null;
const runningChild = (runDir: string, name: string) => {
  const s = state(runDir, name);
  return s?.status === "running" ? s : null;
};
const STAND_IN = "setInterval(() => {}, 1000)";

describe("supervise", () => {
  it("backoff doubles from the base up to the cap", () => {
    expect([0, 1, 2, 3, 10].map((n) => backoffDelay(n, 1000, 30_000))).toEqual([1000, 2000, 4000, 8000, 30_000]);
  });

  it("restarts a killed stand-in and logs the exit with signal and uptime", async () => {
    const { runDir } = start("w", STAND_IN);
    const first = await until("first child", () => runningChild(runDir, "w"));
    process.kill(first.childPid!, "SIGKILL");
    const second = await until("a new child", () => {
      const s = runningChild(runDir, "w");
      return s && s.childPid !== first.childPid ? s : null;
    });
    expect(second.restarts).toBe(1);
    expect(alive(second.childPid!)).toBe(true);
    const log = fs.readFileSync(exitsLogFile(runDir, "w"), "utf8");
    expect(log).toMatch(/^\S+ w exit signal=SIGKILL uptime=\d+\.\ds action=restart #1 in 20ms$/m);
  });

  it("logs an exit code for a stand-in that exits by itself", async () => {
    const { runDir } = start("c", "setTimeout(() => process.exit(7), 100)", ["--max-restarts", "50"]);
    await until("an exit line", () => fs.existsSync(exitsLogFile(runDir, "c")) && fs.readFileSync(exitsLogFile(runDir, "c"), "utf8").includes("exit code=7 uptime="));
  });

  it("does not respawn after an intended stop (marker, then SIGTERM to the group)", async () => {
    const { runDir, pgid, exited } = start("s", STAND_IN);
    const running = await until("child", () => runningChild(runDir, "s"));
    fs.writeFileSync(stopFile(runDir, "s"), "");
    process.kill(-pgid, "SIGTERM");
    await until("supervisor exit", () => exited());
    expect(exited()).toEqual({ code: 0, signal: null });
    await sleep(300);
    expect(alive(running.childPid!)).toBe(false);
    expect(fs.existsSync(stateFile(runDir, "s"))).toBe(false);
    expect(fs.readFileSync(exitsLogFile(runDir, "s"), "utf8")).toMatch(/action=stopped \(dev:stop\)/);
    expect(fs.existsSync(stopFile(runDir, "s"))).toBe(false);
  });

  it("restarts after a group SIGTERM that has no stop marker (an outside signal)", async () => {
    const { runDir, pgid, exited } = start("o", STAND_IN);
    const first = await until("child", () => runningChild(runDir, "o"));
    process.kill(-pgid, "SIGTERM");
    const second = await until("a new child", () => {
      const s = runningChild(runDir, "o");
      return s && s.childPid !== first.childPid ? s : null;
    });
    expect(exited()).toBeNull();
    expect(alive(second.childPid!)).toBe(true);
    const log = fs.readFileSync(exitsLogFile(runDir, "o"), "utf8");
    expect(log).toMatch(/without a stop marker/);
    expect(log).toMatch(/exit signal=SIGTERM/);
  });

  it("gives up after the restart cap inside the window, so a crash loop does not spin", async () => {
    const { runDir, exited } = start("l", "process.exit(3)", ["--max-restarts", "3", "--window-ms", "60000"]);
    await until("supervisor exit", () => exited());
    expect(exited()).toEqual({ code: 1, signal: null });
    const lines = fs.readFileSync(exitsLogFile(runDir, "l"), "utf8").trim().split("\n");
    expect(lines.filter((l) => l.includes("exit code=3"))).toHaveLength(4); // first run plus 3 restarts
    expect(lines.at(-1)).toMatch(/action=giving up: 3 restarts within 60s/);
    const s = state(runDir, "l");
    expect(s?.status).toBe("gave-up");
    expect(s?.restarts).toBe(3);
  });

  it("a long-lived child resets the backoff and the window keeps old restarts from counting", async () => {
    // Exits after 150 ms every time; healthy-ms 100 makes each run healthy, window 1 s with a cap of 2: three restarts spread over time stay under it.
    const { runDir, exited } = start("h", "setTimeout(() => process.exit(0), 600)", ["--max-restarts", "2", "--window-ms", "700", "--healthy-ms", "100"]);
    await until("three restarts", () => (state(runDir, "h")?.restarts ?? 0) >= 3, 10_000);
    expect(exited()).toBeNull();
  });
});
