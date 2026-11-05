import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

export default function setup(): () => Promise<void> {
  if (process.platform !== "linux") return async () => {};
  const dir = registryDirFor(process.pid);
  rmSync(dir, { recursive: true, force: true }); // a crashed earlier run whose pid was reused
  mkdirSync(dir, { recursive: true });
  return async () => {
    try {
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
