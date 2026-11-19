import type { DatabaseSync } from "node:sqlite";
import type { TokenSource } from "./store.ts";

/**
 * Storage for the chain-sourced creates job (phase 3 ticket 20): the run log, the credit ledger, the daily comparison sample's draw and
 * the per-mint lookup state. The create fields themselves go into `study_tokens` (see `fillCreate`), so a mint reached by two paths is
 * one row. Nothing here reads a chain; the worker writes, the War Room may read.
 */

export type ChainJob = "migrated_creates" | "sample_listing" | "sample_reads";

/** A migrated mint is looked up at most this many times (a lookup that failed or found nothing is retried the next day). */
export const MAX_MINT_ATTEMPTS = 3;
/** A drawn sample signature is read at most this many times. */
export const MAX_SAMPLE_ATTEMPTS = 3;

export interface ChainCreateFields {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  uri: string;
  pool: string;
  signature: string;
  /** Chain block time, ISO. */
  createdAt: string;
  mayhem: boolean;
  cashback: boolean;
}

export type FillResult = "inserted" | "filled" | "unchanged";

export interface SampleDay {
  day: string;
  runId: number;
  /** The seed of the RNG that drew the sample: the same list and seed give the same draw. */
  seed: number;
  /** Successful signatures on the mint-authority address that day. */
  listed: number;
  sampleSize: number;
  drawn: number;
  /** listed / drawn: how many creates of the day each sampled row stands for. */
  weight: number;
  /** Drawn signatures that were read and stored, and those that turned out not to be a create. */
  stored: number;
  skipped: number;
  /** Of the creates read, how many PumpPortal had also delivered (a row with PumpPortal create data); null until a read finished. */
  pumpportalSeen: number;
  coverage: number | null;
}

export interface CreditLine {
  job: ChainJob;
  verb: string;
  calls: number;
  credits: number;
}

export interface PendingSample {
  day: string;
  signature: string;
  weight: number;
  attempts: number;
}

export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

type Row = Record<string, string | number | null>;

export function migrateChain(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS study_chain_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    dry_run INTEGER NOT NULL DEFAULT 0,
    stopped_by TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT ''
  )`);
  // One row per run, UTC day, job and RPC verb: credits are counted in code from the cost table, never read back from the provider.
  db.exec(`CREATE TABLE IF NOT EXISTS study_chain_credits (
    day TEXT NOT NULL,
    run_id INTEGER NOT NULL,
    job TEXT NOT NULL,
    verb TEXT NOT NULL,
    calls INTEGER NOT NULL,
    credits INTEGER NOT NULL,
    PRIMARY KEY (day, run_id, job, verb)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS study_chain_days (
    day TEXT PRIMARY KEY,
    run_id INTEGER NOT NULL,
    seed INTEGER NOT NULL,
    listed INTEGER NOT NULL,
    sample_size INTEGER NOT NULL,
    drawn INTEGER NOT NULL,
    weight REAL NOT NULL,
    drawn_at TEXT NOT NULL,
    stored INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    pumpportal_seen INTEGER NOT NULL DEFAULT 0,
    coverage REAL
  )`);
  // The draw is kept: a read that fails is retried for the same signature, never replaced by another draw (that would favour what is easy to read).
  db.exec(`CREATE TABLE IF NOT EXISTS study_chain_sample (
    day TEXT NOT NULL,
    signature TEXT NOT NULL,
    ord INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    mint TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (day, signature)
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS study_chain_sample_pending ON study_chain_sample (status, day, ord)");
  db.exec(`CREATE TABLE IF NOT EXISTS study_chain_mints (
    mint TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL
  )`);
}

export class ChainStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---- runs and credits

  startRun(now: Date, dryRun: boolean): number {
    const res = this.db.prepare("INSERT INTO study_chain_runs (started_at, dry_run) VALUES (?, ?)").run(now.toISOString(), Number(dryRun));
    return Number(res.lastInsertRowid);
  }

  finishRun(id: number, now: Date, stoppedBy: string, summary: string): void {
    this.db.prepare("UPDATE study_chain_runs SET finished_at = ?, stopped_by = ?, summary = ? WHERE id = ?").run(now.toISOString(), stoppedBy, summary.slice(0, 1000), id);
  }

  recordCredits(day: string, runId: number, job: ChainJob, verb: string, credits: number): void {
    this.db
      .prepare(
        `INSERT INTO study_chain_credits (day, run_id, job, verb, calls, credits) VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(day, run_id, job, verb) DO UPDATE SET calls = calls + 1, credits = credits + excluded.credits`,
      )
      .run(day, runId, job, verb, credits);
  }

  creditsOnDay(day: string): number {
    return (this.db.prepare("SELECT COALESCE(SUM(credits), 0) AS n FROM study_chain_credits WHERE day = ?").get(day) as { n: number }).n;
  }

  /** Credits in the UTC month of `now` up to and including its day. */
  creditsInMonth(now: Date): number {
    const month = utcDay(now).slice(0, 7);
    return (this.db.prepare("SELECT COALESCE(SUM(credits), 0) AS n FROM study_chain_credits WHERE day >= ? AND day <= ?").get(`${month}-01`, utcDay(now)) as { n: number }).n;
  }

  /** One UTC day's credits split by job and RPC verb (all runs). */
  creditsByJob(day: string): CreditLine[] {
    const rows = this.db
      .prepare("SELECT job, verb, SUM(calls) AS calls, SUM(credits) AS credits FROM study_chain_credits WHERE day = ? GROUP BY job, verb ORDER BY job, verb")
      .all(day) as Row[];
    return rows.map((r) => ({ job: r.job as ChainJob, verb: r.verb as string, calls: r.calls as number, credits: r.credits as number }));
  }

  /** The credits one run spent, split by job and RPC verb. */
  creditsOfRun(runId: number): CreditLine[] {
    const rows = this.db
      .prepare("SELECT job, verb, SUM(calls) AS calls, SUM(credits) AS credits FROM study_chain_credits WHERE run_id = ? GROUP BY job, verb ORDER BY job, verb")
      .all(runId) as Row[];
    return rows.map((r) => ({ job: r.job as ChainJob, verb: r.verb as string, calls: r.calls as number, credits: r.credits as number }));
  }

  // ---- migrated creates

  /**
   * Migrated pump tokens whose create fields are still empty (no create time, no uri, no creator or no name) and that have not been
   * looked up successfully or given up on. Newest migration first. A token PumpPortal delivered whole is never a candidate.
   */
  migratedCandidates(limit: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT t.mint FROM study_tokens t
         WHERE t.migrated_at IS NOT NULL AND t.mint LIKE '%pump'
           AND (t.created_at IS NULL OR t.uri = '' OR t.creator = '' OR t.name = '')
           AND NOT EXISTS (SELECT 1 FROM study_chain_mints c WHERE c.mint = t.mint AND (c.status IN ('done', 'not_create') OR c.attempts >= ?))
         ORDER BY t.migrated_at DESC, t.mint LIMIT ?`,
      )
      .all(MAX_MINT_ATTEMPTS, Math.max(0, Math.floor(limit))) as Row[];
    return rows.map((r) => r.mint as string);
  }

  /** Records the outcome of one lookup. `retry` counts an attempt and keeps the mint a candidate; the other statuses are final. */
  markMint(mint: string, now: Date, status: "done" | "not_create" | "retry", reason = ""): void {
    this.db
      .prepare(
        `INSERT INTO study_chain_mints (mint, status, attempts, reason, at) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(mint) DO UPDATE SET status = excluded.status, attempts = attempts + 1, reason = excluded.reason, at = excluded.at`,
      )
      .run(mint, status, reason.slice(0, 200), now.toISOString());
  }

  // ---- the daily sample

  dayDrawn(day: string): boolean {
    return this.db.prepare("SELECT 1 FROM study_chain_days WHERE day = ?").get(day) !== undefined;
  }

  getDay(day: string): SampleDay | undefined {
    const r = this.db.prepare("SELECT * FROM study_chain_days WHERE day = ?").get(day) as Row | undefined;
    return r && toDay(r);
  }

  days(limit = 30): SampleDay[] {
    return (this.db.prepare("SELECT * FROM study_chain_days ORDER BY day DESC LIMIT ?").all(limit) as Row[]).map(toDay);
  }

  /** The signatures a day listed last time it was drawn, as a count: a guide to how many pages the next listing costs. */
  lastListed(): number | undefined {
    return (this.db.prepare("SELECT listed FROM study_chain_days ORDER BY day DESC LIMIT 1").get() as { listed: number } | undefined)?.listed;
  }

  /** Stores the draw in one transaction: the day's row and every drawn signature, in drawn order. Nothing is stored on a throw. */
  saveDraw(d: { day: string; runId: number; seed: number; listed: number; sampleSize: number; signatures: string[]; now: Date }): void {
    const drawn = d.signatures.length;
    if (drawn === 0) throw new Error("a draw of no signatures is not stored");
    this.tx(() => {
      this.db
        .prepare("INSERT INTO study_chain_days (day, run_id, seed, listed, sample_size, drawn, weight, drawn_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(d.day, d.runId, d.seed, d.listed, d.sampleSize, drawn, d.listed / drawn, d.now.toISOString());
      const ins = this.db.prepare("INSERT INTO study_chain_sample (day, signature, ord) VALUES (?, ?, ?)");
      d.signatures.forEach((s, i) => ins.run(d.day, s, i));
    });
  }

  /** The oldest days' unread drawn signatures first, in drawn order. */
  pendingSample(limit: number): PendingSample[] {
    const rows = this.db
      .prepare(
        `SELECT s.day, s.signature, s.attempts, d.weight FROM study_chain_sample s JOIN study_chain_days d ON d.day = s.day
         WHERE s.status = 'pending' AND s.attempts < ? ORDER BY s.day, s.ord LIMIT ?`,
      )
      .all(MAX_SAMPLE_ATTEMPTS, Math.max(0, Math.floor(limit))) as Row[];
    return rows.map((r) => ({ day: r.day as string, signature: r.signature as string, weight: r.weight as number, attempts: r.attempts as number }));
  }

  pendingSampleCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM study_chain_sample WHERE status = 'pending' AND attempts < ?").get(MAX_SAMPLE_ATTEMPTS) as { n: number }).n;
  }

  /** A read that could not be finished: counts an attempt and leaves the signature pending (a final failure after MAX_SAMPLE_ATTEMPTS). */
  bumpSample(day: string, signature: string): void {
    this.db.prepare("UPDATE study_chain_sample SET attempts = attempts + 1 WHERE day = ? AND signature = ? AND status = 'pending'").run(day, signature);
  }

  /** Closes one drawn signature: `stored` (a create now in study_tokens) or `skipped` (failed on chain, or not a create). */
  closeSample(day: string, signature: string, status: "stored" | "skipped", mint: string, reason: string): void {
    this.db.prepare("UPDATE study_chain_sample SET status = ?, mint = ?, reason = ? WHERE day = ? AND signature = ? AND status = 'pending'").run(status, mint, reason.slice(0, 200), day, signature);
  }

  /** Recomputes a day's counts and PumpPortal coverage from what has been read so far. */
  refreshDay(day: string): void {
    const c = this.db
      .prepare(
        `SELECT COALESCE(SUM(s.status = 'stored'), 0) AS stored, COALESCE(SUM(s.status = 'skipped'), 0) AS skipped,
                COALESCE(SUM(s.status = 'stored' AND t.source = 'pumpportal'), 0) AS seen
         FROM study_chain_sample s LEFT JOIN study_tokens t ON t.mint = s.mint WHERE s.day = ?`,
      )
      .get(day) as { stored: number; skipped: number; seen: number };
    this.db
      .prepare("UPDATE study_chain_days SET stored = ?, skipped = ?, pumpportal_seen = ?, coverage = ? WHERE day = ?")
      .run(c.stored, c.skipped, c.seen, c.stored === 0 ? null : c.seen / c.stored, day);
  }

  // ---- the create fields

  /**
   * Writes a create read from chain into `study_tokens`. A mint already there keeps every field it has (PumpPortal's data wins) and gets
   * only the empty ones; the other path is recorded in `also_sources`. A row that held only a migration takes the chain source as its own.
   * A mint not there yet is inserted with status `chain`. One transaction: a throw leaves the row as it was.
   */
  fillCreate(f: ChainCreateFields, source: Exclude<TokenSource, "pumpportal">, now: Date, sample?: { day: string; weight: number }, after?: () => void): FillResult {
    // `after` runs inside the same transaction, so the row and the bookkeeping of the lookup that produced it are written together or not at all.
    return this.tx(() => {
      const result = this.fill(f, source, now, sample);
      after?.();
      return result;
    });
  }

  private fill(f: ChainCreateFields, source: Exclude<TokenSource, "pumpportal">, now: Date, sample?: { day: string; weight: number }): FillResult {
    const row = this.db.prepare("SELECT * FROM study_tokens WHERE mint = ?").get(f.mint) as Row | undefined;
    if (!row) {
      this.db
        .prepare(
          `INSERT INTO study_tokens (mint, status, status_reason, name, symbol, creator, uri, pool, signature, created_at, first_seen_at, source, sample_day, sample_weight, mayhem, cashback)
           VALUES (?, 'chain', 'create read from chain after the fact', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(f.mint, f.name, f.symbol, f.creator, f.uri, f.pool, f.signature, f.createdAt, now.toISOString(), source, sample?.day ?? null, sample?.weight ?? null, Number(f.mayhem), Number(f.cashback));
      return "inserted";
    }
    const hadCreate = row.created_at !== null;
    const own = (row.source as string | null) ?? "pumpportal";
    const newSource = hadCreate ? own : source;
    const others = new Set(((row.also_sources as string | null) ?? "").split(",").filter((s) => s !== ""));
    for (const s of [own, source]) if (s !== newSource) others.add(s);
    const empty = (key: string) => row[key] === "" || row[key] === null;
    const next = {
      name: empty("name") ? f.name : (row.name as string),
      symbol: empty("symbol") ? f.symbol : (row.symbol as string),
      creator: empty("creator") ? f.creator : (row.creator as string),
      uri: empty("uri") ? f.uri : (row.uri as string),
      // a row that held only a migration carries PumpPortal's migration pool tag, not the launchpad's
      pool: hadCreate && !empty("pool") ? (row.pool as string) : f.pool,
      signature: empty("signature") ? f.signature : (row.signature as string),
      createdAt: (row.created_at as string | null) ?? f.createdAt,
      mayhem: (row.mayhem as number | null) ?? Number(f.mayhem),
      cashback: (row.cashback as number | null) ?? Number(f.cashback),
      sampleDay: (row.sample_day as string | null) ?? sample?.day ?? null,
      sampleWeight: (row.sample_weight as number | null) ?? sample?.weight ?? null,
      also: [...others].sort().join(","),
    };
    const changed =
      next.name !== row.name || next.symbol !== row.symbol || next.creator !== row.creator || next.uri !== row.uri || next.pool !== row.pool || next.signature !== row.signature ||
      next.createdAt !== row.created_at || next.mayhem !== row.mayhem || next.cashback !== row.cashback || next.sampleDay !== row.sample_day || next.sampleWeight !== row.sample_weight ||
      next.also !== row.also_sources || newSource !== own;
    if (!changed) return "unchanged";
    this.db
      .prepare(
        `UPDATE study_tokens SET name = ?, symbol = ?, creator = ?, uri = ?, pool = ?, signature = ?, created_at = ?, mayhem = ?, cashback = ?,
           sample_day = ?, sample_weight = ?, also_sources = ?, source = ? WHERE mint = ?`,
      )
      .run(next.name, next.symbol, next.creator, next.uri, next.pool, next.signature, next.createdAt, next.mayhem, next.cashback, next.sampleDay, next.sampleWeight, next.also, newSource, f.mint);
    return "filled";
  }
}

const toDay = (r: Row): SampleDay => ({
  day: r.day as string,
  runId: r.run_id as number,
  seed: r.seed as number,
  listed: r.listed as number,
  sampleSize: r.sample_size as number,
  drawn: r.drawn as number,
  weight: r.weight as number,
  stored: r.stored as number,
  skipped: r.skipped as number,
  pumpportalSeen: r.pumpportal_seen as number,
  coverage: r.coverage as number | null,
});
