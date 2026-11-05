// Shared by the fakes (claude, gh, wrangler, podman) and the leak guard (no-leaked-fakes.ts). A test run's guard makes a
// registry directory named after its own pid; every fake looks for such a directory named after one of its ancestors and, if it
// finds one, records itself there (its pid and start time). So the guard knows exactly which fakes its own run started, and a
// second vitest run in the same checkout, which has another pid and another directory, is never mistaken for it.
// Nothing is read from the environment: the fakes run with whatever env the code under test hands them. A fake that finds a
// registry but cannot write to it throws, so the run fails instead of the guard passing without having seen the fake.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The registry lives on the home disk, under the repo's gitignored node_modules/.cache, found from this file's own location:
// it depends on no environment variable (a fake started with a reduced env, or a TMPDIR of its own, finds the same place) and
// never on /tmp.
const REGISTRY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "node_modules", ".cache", "argus-fakes");

/** The registry directory of the test run whose guard process has this pid. */
export const registryDirFor = (guardPid) => join(REGISTRY_ROOT, String(guardPid));

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
  // A registry exists, so a guard is waiting for this fake: failing to record it must not pass silently.
  writeFileSync(join(dir, String(pid)), String(ticks));
}

/** Records this process. */
export const registerFake = () => registerPid(process.pid);
