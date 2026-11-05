import { readdirSync, readFileSync } from "node:fs";

/**
 * Vitest globalSetup: the suite must not leave a fake `claude`, `gh` or `wrangler` (or a grandchild one of them started)
 * running. Such a leak means a kill path did not reach a whole process group, which is the bug class the process-group tests
 * guard; leftovers also pile up on the machine (idle fakes were found reparented to the user manager hours later).
 *
 * After the run, any process that matches this checkout's fakes (by the path in its command line) and was started after the
 * run began fails the run and is killed. Linux only (reads /proc); elsewhere it does nothing.
 */
const TESTING_DIR = import.meta.dirname;
const CLK_TCK = 100; // USER_HZ is 100 on every Linux ABI node runs on

const uptimeTicks = (): number => Math.floor(Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * CLK_TCK);

interface Found {
  pid: number;
  cmdline: string;
}

/** Live (non-zombie) processes of this checkout's fakes that started at or after `sinceTicks` of uptime. */
function leakedSince(sinceTicks: number): Found[] {
  const found: Found[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").join(" ").trim();
      if (!cmdline.includes(TESTING_DIR)) continue;
      // /proc/<pid>/stat: "pid (comm) state ... starttime" with starttime the 22nd field; comm may hold spaces and parentheses.
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (rest[0] === "Z") continue;
      if (Number(rest[19]) < sinceTicks) continue;
      found.push({ pid: Number(entry), cmdline });
    } catch {
      // gone while being read
    }
  }
  return found;
}

export default function setup(): () => Promise<void> {
  if (process.platform !== "linux") return async () => {};
  const since = uptimeTicks();
  return async () => {
    // A process just killed may take a moment to disappear.
    let leaked = leakedSince(since);
    for (let i = 0; i < 100 && leaked.length > 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      leaked = leakedSince(since);
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
  };
}
