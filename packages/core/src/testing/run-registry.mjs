// Shared by the fakes (claude, gh, wrangler, podman) and the leak guard (no-leaked-fakes.ts). A test run's guard makes a
// registry directory named after its own pid; every fake looks for such a directory named after one of its ancestors and, if it
// finds one, records itself there (its pid and start time). So the guard knows exactly which fakes its own run started, and a
// second vitest run in the same checkout, which has another pid and another directory, is never mistaken for it.
// Nothing is read from the environment: the fakes run with whatever env the code under test hands them.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The registry directory of the test run whose guard process has this pid. */
export const registryDirFor = (guardPid) => join(tmpdir(), `argus-fakes-${guardPid}`);

/** Ticks since boot at which `pid` started (field 22 of /proc/<pid>/stat), or undefined if it is gone or this is not Linux. */
export function startTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
  } catch {
    return undefined;
  }
}

const parentOf = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return 0;
  }
};

let registry; // undefined: not looked up yet; null: no run owns this process
function registryDir() {
  if (registry !== undefined) return registry;
  registry = null;
  for (let pid = process.ppid, n = 0; pid > 1 && n < 64; pid = parentOf(pid), n++) {
    if (existsSync(registryDirFor(pid))) {
      registry = registryDirFor(pid);
      break;
    }
  }
  return registry;
}

/** Records `pid` (a process this fake started) with the run that owns this fake, if any. */
export function registerPid(pid) {
  const dir = registryDir();
  const ticks = startTicks(pid);
  if (!dir || ticks === undefined) return;
  try {
    writeFileSync(join(dir, String(pid)), String(ticks));
  } catch {
    // the run is over and its registry gone
  }
}

/** Records this process. */
export const registerFake = () => registerPid(process.pid);
