// The Chrome directory's lock and safety checks, shared by every job that opens the dedicated X profile (the capture spike, the Moment
// scanner, later the Study's capture). Plain Node, no browser, so it can be tested offline.

import { existsSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";

// One process per directory. Chrome's SingletonLock is a symlink "host-pid".
// Returns null (no lock), { pid, alive: true } (held), or a stale holder ({ alive: false, stale: true }).
export function lockHolder(dir) {
  const lock = join(dir, "SingletonLock");
  let target;
  try {
    target = readlinkSync(lock);
  } catch {
    return null;
  }
  const pid = Number(target.split("-").pop());
  if (!Number.isInteger(pid)) return { pid: null, alive: false, stale: true };
  try {
    process.kill(pid, 0);
    return { pid, alive: true, stale: false };
  } catch (e) {
    return { pid, alive: e.code === "EPERM", stale: e.code !== "EPERM" };
  }
}

// Throws unless the directory is mode 700 and outside the repository (cwd with a .git). Returns the mode as an octal string.
export function assertDirSafe(dir, cwd = process.cwd()) {
  const st = statSync(dir);
  const mode = st.mode & 0o777;
  if (mode !== 0o700) throw new Error(`refusing: ${dir} has mode ${mode.toString(8)}, expected 700`);
  if (dir.startsWith(cwd) && existsSync(join(cwd, ".git"))) {
    throw new Error("refusing: the Chrome directory must be outside the repository");
  }
  return mode.toString(8);
}
