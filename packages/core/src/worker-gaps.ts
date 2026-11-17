import type { DatabaseSync } from "node:sqlite";

/** A silence between two heartbeats longer than this is a stop (the tick is about 30 s; a slow tick or a `--once` run beside the daemon stays well under it). */
export const WORKER_GAP_MS = 10 * 60_000;

/** A time the worker was not running, as ISO times. */
export interface WorkerGap {
  start: string;
  end: string;
}

/**
 * Additive tables (no data to carry over): `worker_alive` is one row, the newest heartbeat any worker wrote; `worker_gaps` is the ledger of
 * stops. A meme Proposal's 12 h life and the 12 h meme refresh count running time only, so they read the ledger.
 */
export function migrateWorkerGaps(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS worker_alive (id INTEGER PRIMARY KEY CHECK (id = 1), at TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS worker_gaps (start_at TEXT PRIMARY KEY, end_at TEXT NOT NULL)");
}

/**
 * Writes the heartbeat and returns the gap it recorded, if any. One shared row, never moved backwards: the daemon and a `--once` run
 * both write it, so a gap can only span a time when neither was alive. A clock that went backwards, or an unreadable heartbeat, records
 * no gap. The caller wraps this in a transaction.
 */
export function recordWorkerAlive(db: DatabaseSync, now: Date): WorkerGap | null {
  const t = now.getTime();
  if (!Number.isFinite(t)) return null;
  const row = db.prepare("SELECT at FROM worker_alive WHERE id = 1").get() as { at: unknown } | undefined;
  const prev = typeof row?.at === "string" ? Date.parse(row.at) : Number.NaN;
  if (Number.isFinite(prev) && t < prev) return null;
  db.prepare("INSERT INTO worker_alive (id, at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET at = excluded.at").run(now.toISOString());
  if (!Number.isFinite(prev) || t - prev <= WORKER_GAP_MS) return null;
  const gap = { start: new Date(prev).toISOString(), end: now.toISOString() };
  db.prepare("INSERT OR IGNORE INTO worker_gaps (start_at, end_at) VALUES (?, ?)").run(gap.start, gap.end);
  return gap;
}

/** The timer functions and clock the heartbeat uses, so a test drives them without real time. */
export interface HeartbeatDeps {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  now: () => Date;
}

/**
 * Writes the heartbeat every `everyMs` from a timer of its own, so a tick that waits on a slow Spec run (up to the brain timeout, as long
 * as `WORKER_GAP_MS`) never looks like a stop. Returns the function that stops it. A failed write is passed to `onError`, never thrown.
 */
export function startWorkerHeartbeat(
  store: { recordWorkerAlive(now: Date): WorkerGap | null },
  everyMs: number,
  onGap: (gap: WorkerGap) => void,
  onError: (e: unknown) => void,
  deps: HeartbeatDeps = { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>), now: () => new Date() },
): () => void {
  const handle = deps.setInterval(() => {
    try {
      const gap = store.recordWorkerAlive(deps.now());
      if (gap) onGap(gap);
    } catch (e) {
      onError(e);
    }
  }, everyMs);
  return () => deps.clearInterval(handle);
}

export function readWorkerGaps(db: DatabaseSync): WorkerGap[] {
  return (db.prepare("SELECT start_at, end_at FROM worker_gaps ORDER BY start_at").all() as Array<{ start_at: string; end_at: string }>).map((r) => ({ start: r.start_at, end: r.end_at }));
}

/**
 * How many ms of stops push out a life of `ttlMs` that began at `since` (ISO): the stops after `since` (one that began before counts only
 * from `since`), but only those that began before the life ran out. A stop that began at or after the running deadline holds nothing: the
 * idea was already due, so downtime never keeps alive one that had spent its time. No cap. Gaps never overlap (one shared heartbeat).
 */
export function gapMsHeld(gaps: readonly WorkerGap[], since: string, ttlMs: number): number {
  const from = Date.parse(since);
  if (!Number.isFinite(from)) return 0;
  let held = 0;
  for (const g of [...gaps].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
    const start = Math.max(Date.parse(g.start), from);
    const end = Date.parse(g.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (start >= from + ttlMs + held) break;
    held += end - start;
  }
  return held;
}
