import type { DatabaseSync } from "node:sqlite";
import { META_WINDOWS, type MetaConfig, type MetaWindow } from "./config.ts";

/**
 * Meta runs and rows (ticket 03, slice 3): each recompute is stored additively so a day's ranking can be replayed and the Study can
 * later ask whether a Meta was live when a token launched. Tables only; nothing existing is altered. Runs older than the retention
 * (14 days) are deleted, with their rows, whenever a new run is saved.
 */

export interface MetaCounts {
  /** Distinct mints created in the window. */
  tokens: number;
  /** Distinct creators among them. */
  creators: number;
  /** Migrated by the as-of time, unfiltered: PumpPortal receipt time, no bot filter (Phase 3 ticket 04 is not built). */
  migrations: number;
  /** Of those, migrated more than 60 s after the create: the crude organic proxy. */
  migrationsAfter60s: number;
}

export interface MetaTopToken {
  mint: string;
  /** Creator-written text: untrusted. */
  name: string;
  symbol: string;
  marketCapUsd?: number;
}

/** A ranked group as the compute step hands it over; the store adds the rank (its position in the list). */
export interface NewMetaRow {
  key: string;
  /** Creator-written text, cleaned and cut: still untrusted. */
  label: string;
  /** Earliest create time among the group's tokens read for the run (the 24 h window). */
  firstSeenAt: string;
  counts: Record<MetaWindow, MetaCounts>;
  /** Up to three tokens, highest market cap first where known. */
  topTokens: MetaTopToken[];
  /** The largest market cap among the looked-up tokens; absent when DexScreener gave none. */
  topMarketCapUsd?: number;
  /** The summed market cap of the top tokens that have one; absent when none has. */
  marketCapUsd?: number;
}

export interface NewMetaRun {
  /** The as-of time: the run describes the market at this moment. */
  computedAt: string;
  /** Plain statement of what the figures are and are not (cohort, unfiltered). */
  note: string;
  rule: MetaConfig;
  dexCalls: number;
  dexFailures: number;
  /** All tokens created in each window (every group, singletons included) and how many of them migrated by the as-of time. */
  base: Record<MetaWindow, { tokens: number; migrations: number }>;
  /** Ranked, best first, per window. */
  rows: Record<MetaWindow, NewMetaRow[]>;
}

export interface MetaRow extends NewMetaRow {
  rank: number;
  window: MetaWindow;
  /** migrations / tokens in the ranked window. */
  migrationRate: number;
  /** tokens / migrations in the ranked window; null when none migrated. */
  createsPerMigration: number | null;
  /** The stored one-line LLM summary for this group (meta_summaries); absent until one was made. Model text from creator-written input: untrusted. */
  summary?: string;
  /** When that summary was made. */
  summaryAt?: string;
}

/** One group's summary state: the line, the input it was made for, and the last attempt (kept even when the answer was refused, so a poison input is not retried at once). */
export interface MetaSummaryRecord {
  key: string;
  /** The accepted line; null when no attempt has produced one yet. */
  summary: string | null;
  summaryAt: string | null;
  /** Hash of the input the summary was made for. */
  inputHash: string;
  /** Last attempt, accepted or refused. */
  triedAt: string;
}

export interface MetaRun {
  id: number;
  computedAt: string;
  window: MetaWindow;
  note: string;
  dexCalls: number;
  dexFailures: number;
  /** Tokens created in the window, all groups together. */
  windowTokens: number;
  windowMigrations: number;
  /** windowMigrations / windowTokens; null when no token was created in the window. */
  baseMigrationRate: number | null;
  rows: MetaRow[];
}

/** The most rows one read returns. */
export const MAX_META_READ = 200;
const DAY_MS = 24 * 3_600_000;

export function migrateMeta(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meta_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    computed_at TEXT NOT NULL,
    note TEXT NOT NULL,
    rule TEXT NOT NULL,
    dex_calls INTEGER NOT NULL,
    dex_failures INTEGER NOT NULL,
    base_tokens_6h INTEGER NOT NULL,
    base_migrations_6h INTEGER NOT NULL,
    base_tokens_24h INTEGER NOT NULL,
    base_migrations_24h INTEGER NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS meta_runs_computed_at ON meta_runs (computed_at)");
  db.exec(`CREATE TABLE IF NOT EXISTS meta_rows (
    run_id INTEGER NOT NULL,
    win TEXT NOT NULL,
    rank INTEGER NOT NULL,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    tokens_6h INTEGER NOT NULL,
    creators_6h INTEGER NOT NULL,
    migrations_6h INTEGER NOT NULL,
    after60_6h INTEGER NOT NULL,
    tokens_24h INTEGER NOT NULL,
    creators_24h INTEGER NOT NULL,
    migrations_24h INTEGER NOT NULL,
    after60_24h INTEGER NOT NULL,
    top_tokens TEXT NOT NULL,
    top_market_cap_usd REAL,
    market_cap_usd REAL,
    PRIMARY KEY (run_id, win, rank)
  )`);
  // Ticket 03, slice 5: the one-line summary of a Meta, by group key, so it survives from one run to the next while its input holds.
  db.exec(`CREATE TABLE IF NOT EXISTS meta_summaries (
    key TEXT PRIMARY KEY,
    summary TEXT,
    summary_at TEXT,
    input_hash TEXT NOT NULL,
    tried_at TEXT NOT NULL
  )`);
}

type Row = Record<string, string | number | null>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseTopTokens(text: string): MetaTopToken[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: MetaTopToken[] = [];
  for (const t of data) {
    if (!isRecord(t) || typeof t.mint !== "string") continue;
    out.push({
      mint: t.mint,
      name: typeof t.name === "string" ? t.name : "",
      symbol: typeof t.symbol === "string" ? t.symbol : "",
      ...(typeof t.marketCapUsd === "number" ? { marketCapUsd: t.marketCapUsd } : {}),
    });
  }
  return out;
}

const counts = (r: Row, w: "6h" | "24h"): MetaCounts => ({
  tokens: r[`tokens_${w}`] as number,
  creators: r[`creators_${w}`] as number,
  migrations: r[`migrations_${w}`] as number,
  migrationsAfter60s: r[`after60_${w}`] as number,
});

function toRow(r: Row, window: MetaWindow): MetaRow {
  const c = counts(r, window);
  return {
    rank: r.rank as number,
    window,
    key: r.key as string,
    label: r.label as string,
    firstSeenAt: r.first_seen_at as string,
    counts: { "6h": counts(r, "6h"), "24h": counts(r, "24h") },
    topTokens: parseTopTokens(r.top_tokens as string),
    ...(r.top_market_cap_usd !== null ? { topMarketCapUsd: r.top_market_cap_usd as number } : {}),
    ...(r.market_cap_usd !== null ? { marketCapUsd: r.market_cap_usd as number } : {}),
    migrationRate: c.tokens > 0 ? c.migrations / c.tokens : 0,
    createsPerMigration: c.migrations > 0 ? c.tokens / c.migrations : null,
  };
}

/** The Meta tables. Reached as `datastore.meta`; the worker writes, readers use `Datastore.latestMetas`. */
export class MetaStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * WORKER ONLY. Stores one run and its ranked rows in one short transaction (the inserts only; the compute and the DexScreener
   * calls happen before it), then prunes runs older than the retention. Returns the run id.
   */
  saveRun(run: NewMetaRun, retentionDays = run.rule.retentionDays): number {
    const insertRun = this.db.prepare(
      `INSERT INTO meta_runs (computed_at, note, rule, dex_calls, dex_failures, base_tokens_6h, base_migrations_6h, base_tokens_24h, base_migrations_24h)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertRow = this.db.prepare(
      `INSERT INTO meta_rows (run_id, win, rank, key, label, first_seen_at, tokens_6h, creators_6h, migrations_6h, after60_6h,
         tokens_24h, creators_24h, migrations_24h, after60_24h, top_tokens, top_market_cap_usd, market_cap_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    let id: number;
    try {
      const r = insertRun.run(run.computedAt, run.note, JSON.stringify(run.rule), run.dexCalls, run.dexFailures, run.base["6h"].tokens, run.base["6h"].migrations, run.base["24h"].tokens, run.base["24h"].migrations);
      id = Number(r.lastInsertRowid);
      for (const win of META_WINDOWS) {
        run.rows[win].forEach((row, i) => {
          const a = row.counts["6h"];
          const b = row.counts["24h"];
          insertRow.run(id, win, i + 1, row.key, row.label, row.firstSeenAt, a.tokens, a.creators, a.migrations, a.migrationsAfter60s, b.tokens, b.creators, b.migrations, b.migrationsAfter60s, JSON.stringify(row.topTokens), row.topMarketCapUsd ?? null, row.marketCapUsd ?? null);
        });
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.prune(Date.parse(run.computedAt) - retentionDays * DAY_MS);
    return id;
  }

  private prune(beforeMs: number): void {
    if (!Number.isFinite(beforeMs)) return;
    const cutoff = new Date(beforeMs).toISOString();
    this.db.prepare("DELETE FROM meta_rows WHERE run_id IN (SELECT id FROM meta_runs WHERE computed_at < ?)").run(cutoff);
    this.db.prepare("DELETE FROM meta_runs WHERE computed_at < ?").run(cutoff);
    this.db.prepare("DELETE FROM meta_summaries WHERE tried_at < ?").run(cutoff);
  }

  /** The summary records of these group keys (those that have one). READ ONLY. */
  summaries(keys: readonly string[]): Map<string, MetaSummaryRecord> {
    const out = new Map<string, MetaSummaryRecord>();
    const get = this.db.prepare("SELECT * FROM meta_summaries WHERE key = ?");
    for (const key of new Set(keys)) {
      const r = get.get(key) as Row | undefined;
      if (r) out.set(key, { key, summary: r.summary as string | null, summaryAt: r.summary_at as string | null, inputHash: r.input_hash as string, triedAt: r.tried_at as string });
    }
    return out;
  }

  /** WORKER ONLY. Stores an accepted summary for a group, replacing the earlier one. */
  saveSummary(key: string, summary: string, inputHash: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO meta_summaries (key, summary, summary_at, input_hash, tried_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET summary = excluded.summary, summary_at = excluded.summary_at, input_hash = excluded.input_hash, tried_at = excluded.tried_at`,
      )
      .run(key, summary, at, inputHash, at);
  }

  /** WORKER ONLY. Records a refused attempt without touching an earlier accepted line, so the same input is not tried again before the retry gap. */
  markTried(key: string, inputHash: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO meta_summaries (key, summary, summary_at, input_hash, tried_at) VALUES (?, NULL, NULL, ?, ?)
         ON CONFLICT(key) DO UPDATE SET tried_at = excluded.tried_at`,
      )
      .run(key, inputHash, at);
  }

  /** The newest run's top `limit` rows for one window, ranked; undefined before the first run. READ ONLY. */
  latest(window: MetaWindow, limit: number): MetaRun | undefined {
    const n = Math.max(0, Math.min(MAX_META_READ, Math.floor(limit)));
    const r = this.db.prepare("SELECT * FROM meta_runs ORDER BY computed_at DESC, id DESC LIMIT 1").get() as Row | undefined;
    if (!r) return undefined;
    const rows = (this.db.prepare("SELECT * FROM meta_rows WHERE run_id = ? AND win = ? AND rank <= ? ORDER BY rank").all(r.id as number, window, n) as Row[]).map((x) => toRow(x, window));
    const windowTokens = r[`base_tokens_${window}`] as number;
    const windowMigrations = r[`base_migrations_${window}`] as number;
    const summaries = this.summaries(rows.map((x) => x.key));
    for (const row of rows) {
      const s = summaries.get(row.key);
      if (s?.summary != null && s.summaryAt != null) {
        row.summary = s.summary;
        row.summaryAt = s.summaryAt;
      }
    }
    return {
      id: r.id as number,
      computedAt: r.computed_at as string,
      window,
      note: r.note as string,
      dexCalls: r.dex_calls as number,
      dexFailures: r.dex_failures as number,
      windowTokens,
      windowMigrations,
      baseMigrationRate: windowTokens > 0 ? windowMigrations / windowTokens : null,
      rows,
    };
  }
}
