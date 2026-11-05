import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registryDirFor, startTicks } from "./run-registry.mjs";

/**
 * Vitest globalSetup: the suite must not leave a fake `claude`, `gh` or `wrangler` (or a grandchild one of them started)
 * running. Such a leak means a kill path did not reach a whole process group, which is the bug class the process-group tests
 * guard; leftovers also pile up on the machine (idle fakes were found reparented to the user manager hours later).
 *
 * Only this run's fakes count. The run makes a registry directory named after its own pid (see run-registry.mjs); each fake
 * started under this process, and each grandchild a fake starts, records its pid and start time there. After the run, any of
 * those still alive fails the run and is killed. A second vitest run in the same checkout has its own directory and is never
 * looked at. Linux only (reads /proc); elsewhere it does nothing.
 *
 * Temp dirs get the same treatment. The run points TMPDIR at a private directory (`argus-test-run-*`, created under the real
 * temp dir) before any worker starts, so every `os.tmpdir()` in tests and in the code under test lands inside it. Anything
 * still there after the run is a leak: it fails the run and is removed. A second run has its own directory and is never
 * looked at. The private directory itself is always removed, so a clean run leaves nothing in the temp dir.
 */
const CLK_TCK = 100; // USER_HZ is 100 on every Linux ABI node runs on

interface Found {
  pid: number;
  cmdline: string;
}

/** Live (non-zombie) processes recorded in `dir` that are still the processes that were recorded (not a reused pid). */
export function leakedIn(dir: string): Found[] {
  const found: Found[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const recorded = Number(readFileSync(`${dir}/${entry}`, "utf8"));
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      // /proc/<pid>/stat: "pid (comm) state ... starttime" with starttime the 22nd field; comm may hold spaces and parentheses.
      if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] === "Z") continue;
      if (startTicks(Number(entry)) !== recorded) continue;
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").join(" ").trim();
      found.push({ pid: Number(entry), cmdline });
    } catch {
      // gone while being read
    }
  }
  return found;
}

const COMPILE_CACHE = "node-compile-cache"; // Node's own cache for the run's child processes; swept with the run, not a leak

/** Removes the run's private temp dir; throws, naming what was left in it, when the run did not clean up after itself. */
export function sweepTempRoot(root: string): void {
  let left: string[] = [];
  try {
    left = readdirSync(root).filter((n) => n !== COMPILE_CACHE);
  } catch {
    // never created
  }
  rmSync(root, { recursive: true, force: true });
  if (left.length > 0) throw new Error(`The test run left ${left.length} temp entr${left.length === 1 ? "y" : "ies"} behind (removed now):\n${left.map((e) => `  ${e}`).join("\n")}`);
}

function isolateTmpdir(): () => void {
  const saved = { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE };
  const root = mkdtempSync(join(tmpdir(), "argus-test-run-"));
  process.env.TMPDIR = root;
  process.env.NODE_COMPILE_CACHE = join(root, COMPILE_CACHE);
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    sweepTempRoot(root);
  };
}

export default function setup(): () => Promise<void> {
  const restoreTmpdir = isolateTmpdir();
  if (process.platform !== "linux") return async () => restoreTmpdir();
  const dir = registryDirFor(process.pid); // on the home disk, found by the fakes without any env
  rmSync(dir, { recursive: true, force: true }); // a crashed earlier run whose pid was reused
  mkdirSync(dir, { recursive: true });
  return async () => {
    try {
      await failOnLeakedFakes(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreTmpdir();
    }
  };
}

async function failOnLeakedFakes(dir: string): Promise<void> {
  // A process just killed may take a moment to disappear.
  let leaked = leakedIn(dir);
  for (let i = 0; i < 100 && leaked.length > 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
    leaked = leakedIn(dir);
  }
  if (leaked.length === 0) return;
  for (const l of leaked) {
    try {
      process.kill(l.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  throw new Error(`The test run left ${leaked.length} fake process(es) running (killed now):\n${leaked.map((l) => `  ${l.pid} ${l.cmdline}`).join("\n")}`);
}
