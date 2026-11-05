import type { ChildProcess } from "node:child_process";

/**
 * Children that run agent-written or third-party code (claude, and the git, gh and wrangler the Build Runner runs) are spawned
 * `detached`, which makes each the leader of its own process group. Killing only the leader leaves its grandchildren (a dev
 * server, a `pnpm test` runner, anything the agent started) running; signalling the group reaches all of them.
 */
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // the group is already gone
  }
}

/** Children whose pipes have closed: nothing of their group is left to signal. */
const closed = new WeakSet<ChildProcess>();

/** Call from the child's `close` handler. */
export function markClosed(child: ChildProcess): void {
  closed.add(child);
}

export const isClosed = (child: ChildProcess): boolean => closed.has(child);

/**
 * SIGTERM to the child's whole group, then SIGKILL to the group after `graceMs` unless the child has closed by then. Escalates
 * on the group even if the leader has already exited: a grandchild that holds the output pipes open keeps `close` from firing.
 */
export function killGroup(child: ChildProcess, graceMs: number): void {
  if (isClosed(child)) return;
  signalGroup(child, "SIGTERM");
  const t = setTimeout(() => signalGroup(child, "SIGKILL"), graceMs);
  t.unref();
  child.once("close", () => clearTimeout(t));
}
