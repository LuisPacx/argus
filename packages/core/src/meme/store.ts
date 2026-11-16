import type { DatabaseSync } from "node:sqlite";

/**
 * The meme ideas' attempts (ADR 0013, missed ideas ticket 06): one row per try for a Meta, so the 6 h trio guard and the 12 h refresh hold
 * across restarts whatever became of the try, and a refusal by a cap keeps its reason. Tables only; nothing existing is altered. The Proposals
 * themselves live in `proposals` (`Datastore.createMemeProposals`).
 */

/**
 * What became of a try. `stored`: three Proposals were made. `refused`: the answer did not fit the schema. `name-copy`: it copied an
 * existing token twice (fails closed). `exists`: the Meta already had a trio. `failed`: the run failed (a transient error or a budget stop).
 * `daily-cap` and `research-cap`: no run was started because a cap was reached; the reason is the `detail`. `withdrawn`: a news story
 * stopped being eligible before its ideas were stored (proposal-routing ticket 04). A news story's `key` is `narrative:<id>`.
 */
export type MemeOutcome = "stored" | "refused" | "name-copy" | "exists" | "failed" | "daily-cap" | "research-cap" | "withdrawn";

/** The outcomes of a try that did not start a run: they are recorded for the reason and never hold a Meta back. */
export const MEME_CAP_OUTCOMES: readonly MemeOutcome[] = ["daily-cap", "research-cap"];

export interface MemeAttempt {
  id: number;
  /** The Meta group key. */
  key: string;
  /** The slot it fills: when the New Meta event was raised, or the start of the 12 h refresh slot (rows from the Hot now era hold that event's time). */
  eventAt: string;
  at: string;
  outcome: MemeOutcome;
  /** Code-written reason or the first refusal problem (cut). */
  detail: string;
  /** Brain runs the try started (the retry included). */
  runs: number;
}

/** Attempts older than this are deleted when a new one is recorded. */
const RETENTION_MS = 30 * 24 * 3_600_000;

export function migrateMeme(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meme_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    event_at TEXT NOT NULL,
    at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    runs INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS meme_attempts_key ON meme_attempts (key, at)");
  // A cap refusal is recorded once per slot (the pass looks again every few minutes and would otherwise add a row each time).
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS meme_attempts_cap ON meme_attempts (key, event_at, outcome) WHERE outcome IN ('daily-cap', 'research-cap')");
}

type Row = Record<string, string | number | null>;

const toAttempt = (r: Row): MemeAttempt => ({ id: r.id as number, key: r.key as string, eventAt: r.event_at as string, at: r.at as string, outcome: r.outcome as MemeOutcome, detail: r.detail as string, runs: r.runs as number });

/** The meme ideas' attempts. Reached as `datastore.meme`; the worker writes. */
export class MemeStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** WORKER ONLY. Records one try (a cap refusal once per event). */
  record(a: Omit<MemeAttempt, "id">): void {
    this.db.prepare("INSERT OR IGNORE INTO meme_attempts (key, event_at, at, outcome, detail, runs) VALUES (?, ?, ?, ?, ?, ?)").run(a.key, a.eventAt, a.at, a.outcome, a.detail.slice(0, 300), a.runs);
    const cutoff = new Date(Date.parse(a.at) - RETENTION_MS).toISOString();
    if (Number.isFinite(Date.parse(a.at))) this.db.prepare("DELETE FROM meme_attempts WHERE at < ?").run(cutoff);
  }

  /** The latest try for a Meta that started a run (a cap refusal does not count), or undefined. READ ONLY. */
  lastTry(key: string): MemeAttempt | undefined {
    const marks = MEME_CAP_OUTCOMES.map(() => "?").join(", ");
    const r = this.db.prepare(`SELECT * FROM meme_attempts WHERE key = ? AND outcome NOT IN (${marks}) ORDER BY at DESC, id DESC LIMIT 1`).get(key, ...MEME_CAP_OUTCOMES) as Row | undefined;
    return r && toAttempt(r);
  }

  /** The attempts at or after `since` (ISO), newest first. READ ONLY. */
  since(since: string): MemeAttempt[] {
    return (this.db.prepare("SELECT * FROM meme_attempts WHERE at >= ? ORDER BY at DESC, id DESC LIMIT 500").all(since) as Row[]).map(toAttempt);
  }
}
