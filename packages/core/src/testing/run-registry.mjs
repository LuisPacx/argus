// Shared by the fakes (claude, gh, wrangler, podman) and the leak guard (no-leaked-fakes.ts). A test run's guard makes a
// registry directory named after its own pid; every fake looks for such a directory named after one of its ancestors and, if it
// finds one, records itself there (its pid and start time). So the guard knows exactly which fakes its own run started, and a
// second vitest run in the same checkout, which has another pid and another directory, is never mistaken for it.
// Nothing is read from the environment: the fakes run with whatever env the code under test hands them. A fake that finds a
// registry but cannot write to it throws, so the run fails instead of the guard passing without having seen the fake.
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

// ---- Reaping the leftovers of a run whose guard died (killed, timed out) before its teardown could run ----

const GUARD_FILE = "guard"; // the guard's own start ticks: tells a live guard from a reused pid
const ROOT_FILE = "tmp-root"; // the run's private temp root (argus-test-run-*)

/** Marks `dir` as the registry of the calling process (the guard) and records its temp root. */
export function recordGuard(dir, tmpRoot) {
  writeFileSync(join(dir, GUARD_FILE), String(startTicks(process.pid)));
  writeFileSync(join(dir, ROOT_FILE), tmpRoot);
}

/** Makes every directory under `path` (and itself) readable and writable so a removal cannot hit EACCES. Never follows symlinks. */
export function makeWritable(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  try {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makeWritable(join(path, name));
  } catch {
    // best effort: the removal reports what still blocks it
  }
}

/** Removes a directory tree after making it writable. */
export function removeTree(path) {
  makeWritable(path);
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/**
 * Reaps registry directories whose guard is gone: SIGKILLs the fakes recorded there that are still the recorded processes (pid and
 * start time match) and removes the recorded temp root. A registry whose guard is alive belongs to a running test run and is never
 * touched. Returns what it found: `{ dir, mtimeMs, killed: [pid], root }` per reaped run.
 */
export function reapDeadRuns(registryRoot = REGISTRY_ROOT) {
  const reaped = [];
  let entries = [];
  try {
    entries = readdirSync(registryRoot);
  } catch {
    return reaped;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const dir = join(registryRoot, entry);
    const guardTicks = (() => {
      try {
        return Number(readFileSync(join(dir, GUARD_FILE), "utf8"));
      } catch {
        return undefined;
      }
    })();
    const live = startTicks(Number(entry));
    // Alive: the pid exists and, when the guard recorded its start time, still has it. A dir with no guard file is an older-format
    // one (or a test's own): judged by whether the pid exists at all.
    if (live !== undefined && (guardTicks === undefined || guardTicks === live)) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    const killed = [];
    for (const name of readdirSync(dir)) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const recorded = Number(readFileSync(join(dir, name), "utf8"));
        if (startTicks(Number(name)) !== recorded) continue;
        process.kill(Number(name), "SIGKILL");
        killed.push(Number(name));
      } catch {
        // gone, or not ours to signal
      }
    }
    let root;
    try {
      root = readFileSync(join(dir, ROOT_FILE), "utf8");
    } catch {
      // none recorded
    }
    if (root && basename(root).startsWith("argus-test-run-") && existsSync(root)) removeTree(root);
    else root = undefined;
    rmSync(dir, { recursive: true, force: true });
    reaped.push({ dir, mtimeMs, killed, root });
  }
  return reaped;
}
