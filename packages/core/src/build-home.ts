import { chmodSync, existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { BRAIN_RUN_IN_FLIGHT, type Datastore } from "./datastore.ts";

/**
 * The per-Build home on disk (claude's config and session transcripts, the package store, caches): where it is, how it is removed,
 * and the sweep for the ones a crash left. A module of its own so that the lifecycle (which removes a dismissed Proposal's home) and
 * the Build Runner (which creates it, and removes it when a Build ends) both use it without either importing the other.
 */

/** The per-Build home: kept for a failed Build so it can be resumed. */
export function buildHomeFor(dataDir: string, proposalId: number): string {
  return join(resolve(dataDir), "proposals", String(proposalId), "home");
}

/**
 * Removes a directory tree that a container wrote to: directories the agent's install scripts left unreadable or unwritable
 * (mode 000, say) are made enterable first, as `chmod -R u+rwX` would, without following a symlink. Never throws; returns the
 * reason it could not remove the tree, or undefined when it is gone.
 */
export function removeTree(path: string): string | undefined {
  const open = (p: string): void => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (!st.isDirectory()) return;
    try {
      chmodSync(p, st.mode | 0o700);
    } catch {
      // not ours to change, or gone: rmSync below says what is left
    }
    let names: string[] = [];
    try {
      names = readdirSync(p);
    } catch {
      return;
    }
    for (const n of names) open(join(p, n));
  };
  try {
    open(path);
    rmSync(path, { recursive: true, force: true });
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** A Build run whose last sign of life (its heartbeat, or its start when it never beat) is this recent may still have a container on the home. */
const RUN_ALIVE_WITHIN_MS = 5 * 60_000;

/**
 * At worker start: removes the home of every dismissed Proposal. Dismissing one removes its home at once, except while its Build is
 * running (the container has the home mounted, and the runner removes it when the Build ends); a worker that crashed in between left
 * it behind. A dismissed Proposal whose Build run is still open and has shown signs of life in the last few minutes (a `--once`
 * worker beside the daemon, say) is left alone, and caught by a later start. Returns the homes removed.
 */
export function sweepDismissedHomes(store: Pick<Datastore, "listProposals" | "brainRunsFor">, dataDir: string, log: (line: string) => void = () => {}, now: Date = new Date()): string[] {
  const removed: string[] = [];
  for (const p of store.listProposals()) {
    if (p.status !== "dismissed") continue;
    const home = buildHomeFor(dataDir, p.id);
    if (!existsSync(home)) continue;
    const alive = store
      .brainRunsFor(p.id)
      .some((r) => r.exitStatus === BRAIN_RUN_IN_FLIGHT && now.getTime() - Date.parse(r.heartbeatAt ?? r.createdAt) < RUN_ALIVE_WITHIN_MS);
    if (alive) {
      log(`[worker] left alone the home of dismissed Proposal ${p.id}: its Build run is still alive`);
      continue;
    }
    const error = removeTree(home);
    if (error) log(`[worker] could not remove the home of dismissed Proposal ${p.id} (${home}): ${error}`);
    else {
      removed.push(home);
      log(`[worker] removed the home of dismissed Proposal ${p.id} (${home})`);
    }
  }
  return removed;
}
