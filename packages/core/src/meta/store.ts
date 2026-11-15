import type { DatabaseSync } from "node:sqlite";
import { META_WINDOWS, META_WINDOW_HOURS, type MetaConfig, type MetaWindow } from "./config.ts";
import { MARKET_SOURCE_IDS } from "../sources/source-class.ts";
import type { MetaCoverage } from "./coverage.ts";
import { summaryFresh } from "./summary.ts";
import { TRENDING_SOURCE_ID, type TrendingSignalRow } from "./candidates.ts";

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

/** The token that leads a current Meta or Watching subject: the one of any age with the highest market cap that carries the subject. */
export interface CurrentLeader {
  mint: string;
  /** Creator-written text: untrusted. */
  name: string;
  symbol: string;
  marketCapUsd: number;
  /** When the token (its pair) was created, when known. */
  createdAt?: string;
  /** Where the candidate came from: DexScreener's trending feed, or the biggest token of a top launch theme. */
  source: "trending" | "theme";
  /** True when this run's lookup did not answer: `marketCapUsd` is the last known figure. */
  stale: boolean;
}

/** A subject led by a token's market cap (ADR 0014): a Meta, or a Watching subject. `key` is the launch-theme group key. */
export interface CurrentMeta {
  key: string;
  /** Creator-written text, cleaned and cut: still untrusted. */
  label: string;
  leader: CurrentLeader;
  /** A Meta whose leader is between the stay and the enter market cap. Always false for Watching. */
  holding: boolean;
  /** When the subject entered its present state (Meta or Watching), carried from run to run. */
  enteredAt: string;
  /** The subject's launch-theme counts now (zero when no copy was launched in 24 h). */
  counts: Record<MetaWindow, MetaCounts>;
  topTokens: MetaTopToken[];
}

export interface NewMetaCurrent {
  /** Highest leader market cap first. */
  metas: CurrentMeta[];
  watching: CurrentMeta[];
}

/** One run's Metas and Watching subjects, as stored (rank is the position in each list). */
export interface MetaCurrent extends NewMetaCurrent {
  runId: number;
  computedAt: string;
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
  /** Covered hours of each window (coverage.ts); absent stores null (unknown). */
  coverage?: MetaCoverage;
  /** The market-led Metas and Watching subjects of this run (ADR 0014). Absent stores none. */
  current?: NewMetaCurrent;
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
  /** The 24 h token and creator counts the summary was written from; null on a row from before ticket 06 (unknown, so stale). */
  baseTokens: number | null;
  baseCreators: number | null;
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
  /** Covered hours of each window when the run was made; null for a run from before ticket 05 (unknown, no note). */
  coverage: MetaCoverage | null;
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
  // Missed ideas ticket 03: one row per Meta per Hot now trigger, so a later reader (meme idea generation) asks "which Metas were hot, and when" without recomputing.
  db.exec(`CREATE TABLE IF NOT EXISTS meta_hot_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    raised_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    rank INTEGER NOT NULL,
    creators INTEGER NOT NULL,
    run_id INTEGER NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS meta_hot_events_key ON meta_hot_events (key, raised_at)");
  // Meta redesign ticket 01 (ADR 0014): the Metas and Watching subjects of each run, led by a token's market cap. Additive; the launch-theme tables above are untouched.
  db.exec(`CREATE TABLE IF NOT EXISTS meta_current (
    run_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    rank INTEGER NOT NULL,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    leader_mint TEXT NOT NULL,
    leader_name TEXT NOT NULL,
    leader_symbol TEXT NOT NULL,
    leader_market_cap_usd REAL NOT NULL,
    leader_created_at TEXT,
    leader_source TEXT NOT NULL,
    stale INTEGER NOT NULL,
    holding INTEGER NOT NULL,
    entered_at TEXT NOT NULL,
    counts TEXT NOT NULL,
    top_tokens TEXT NOT NULL,
    PRIMARY KEY (run_id, kind, rank)
  )`);
}

/** A Meta that triggered Hot now: when, why, and where it stood in the 24 h ranking then. Label and reason are creator-derived or code-written text. */
export interface MetaHotEvent {
  id: number;
  key: string;
  label: string;
  raisedAt: string;
  /** "entered top 5" or "creators 70 to 148 in 1 h": written by code. */
  reason: string;
  rank: number;
  creators: number;
  runId: number;
}

export type NewMetaHotEvent = Omit<MetaHotEvent, "id">;

/** A context-class headline as the matcher reads it: the title is third-party text, the url is only safe to link after `safeHttpUrl`. */
export interface ContextHeadline {
  sourceId: string;
  sourceLabel: string;
  title: string;
  url: string;
  publishedAt: string;
}

/** The most headlines one read returns. */
export const MAX_HEADLINES_READ = 3_000;

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

function parseCounts(text: string): Record<MetaWindow, MetaCounts> {
  const zero: MetaCounts = { tokens: 0, creators: 0, migrations: 0, migrationsAfter60s: 0 };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { "6h": zero, "24h": zero };
  }
  const one = (v: unknown): MetaCounts => {
    if (!isRecord(v)) return zero;
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    return { tokens: n(v.tokens), creators: n(v.creators), migrations: n(v.migrations), migrationsAfter60s: n(v.migrationsAfter60s) };
  };
  return isRecord(data) ? { "6h": one(data["6h"]), "24h": one(data["24h"]) } : { "6h": zero, "24h": zero };
}

function toCurrent(r: Row): CurrentMeta {
  return {
    key: r.key as string,
    label: r.label as string,
    leader: {
      mint: r.leader_mint as string,
      name: r.leader_name as string,
      symbol: r.leader_symbol as string,
      marketCapUsd: r.leader_market_cap_usd as number,
      ...(r.leader_created_at !== null ? { createdAt: r.leader_created_at as string } : {}),
      source: r.leader_source === "theme" ? "theme" : "trending",
      stale: r.stale === 1,
    },
    holding: r.holding === 1,
    enteredAt: r.entered_at as string,
    counts: parseCounts(r.counts as string),
    topTokens: parseTopTokens(r.top_tokens as string),
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
      `INSERT INTO meta_runs (computed_at, note, rule, dex_calls, dex_failures, base_tokens_6h, base_migrations_6h, base_tokens_24h, base_migrations_24h, coverage_hours_6h, coverage_hours_24h)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertRow = this.db.prepare(
      `INSERT INTO meta_rows (run_id, win, rank, key, label, first_seen_at, tokens_6h, creators_6h, migrations_6h, after60_6h,
         tokens_24h, creators_24h, migrations_24h, after60_24h, top_tokens, top_market_cap_usd, market_cap_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertCurrent = this.db.prepare(
      `INSERT INTO meta_current (run_id, kind, rank, key, label, leader_mint, leader_name, leader_symbol, leader_market_cap_usd, leader_created_at, leader_source,
         stale, holding, entered_at, counts, top_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    let id: number;
    try {
      const r = insertRun.run(run.computedAt, run.note, JSON.stringify(run.rule), run.dexCalls, run.dexFailures, run.base["6h"].tokens, run.base["6h"].migrations, run.base["24h"].tokens, run.base["24h"].migrations, run.coverage?.["6h"].covered ?? null, run.coverage?.["24h"].covered ?? null);
      id = Number(r.lastInsertRowid);
      for (const win of META_WINDOWS) {
        run.rows[win].forEach((row, i) => {
          const a = row.counts["6h"];
          const b = row.counts["24h"];
          insertRow.run(id, win, i + 1, row.key, row.label, row.firstSeenAt, a.tokens, a.creators, a.migrations, a.migrationsAfter60s, b.tokens, b.creators, b.migrations, b.migrationsAfter60s, JSON.stringify(row.topTokens), row.topMarketCapUsd ?? null, row.marketCapUsd ?? null);
        });
      }
      for (const kind of ["meta", "watching"] as const) {
        const list = kind === "meta" ? run.current?.metas : run.current?.watching;
        (list ?? []).forEach((m, i) => {
          const l = m.leader;
          insertCurrent.run(id, kind, i + 1, m.key, m.label, l.mint, l.name, l.symbol, l.marketCapUsd, l.createdAt ?? null, l.source, l.stale ? 1 : 0, m.holding ? 1 : 0, m.enteredAt, JSON.stringify(m.counts), JSON.stringify(m.topTokens));
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
    this.db.prepare("DELETE FROM meta_current WHERE run_id IN (SELECT id FROM meta_runs WHERE computed_at < ?)").run(cutoff);
    this.db.prepare("DELETE FROM meta_runs WHERE computed_at < ?").run(cutoff);
    this.db.prepare("DELETE FROM meta_summaries WHERE tried_at < ?").run(cutoff);
    this.db.prepare("DELETE FROM meta_hot_events WHERE raised_at < ?").run(cutoff);
  }

  /** WORKER ONLY. Stores one Hot now event. */
  saveHot(e: NewMetaHotEvent): void {
    this.db.prepare("INSERT INTO meta_hot_events (key, label, raised_at, reason, rank, creators, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(e.key, e.label, e.raisedAt, e.reason, e.rank, e.creators, e.runId);
  }

  /** When this group was last raised, or undefined. READ ONLY. */
  lastHotAt(key: string): string | undefined {
    const r = this.db.prepare("SELECT MAX(raised_at) AS at FROM meta_hot_events WHERE key = ?").get(key) as { at: string | null };
    return r.at ?? undefined;
  }

  /** Events raised at or after `since` (ISO), newest first. READ ONLY. */
  hotSince(since: string): MetaHotEvent[] {
    const rows = this.db.prepare("SELECT * FROM meta_hot_events WHERE raised_at >= ? ORDER BY raised_at DESC, id DESC LIMIT 200").all(since) as Row[];
    return rows.map((r) => ({ id: r.id as number, key: r.key as string, label: r.label as string, raisedAt: r.raised_at as string, reason: r.reason as string, rank: r.rank as number, creators: r.creators as number, runId: r.run_id as number }));
  }

  /**
   * Context-class headlines (ADR 0011: every Signal whose Source is not a market one) published in [`since`, `until`], newest first, at most
   * `limit` (capped). Only the columns the matcher needs. READ ONLY.
   */
  contextHeadlines(since: string, until: string, limit = MAX_HEADLINES_READ): ContextHeadline[] {
    const n = Math.max(0, Math.min(MAX_HEADLINES_READ, Math.floor(limit)));
    const marks = MARKET_SOURCE_IDS.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT source_id, source_label, title, url, published_at FROM signals WHERE published_at >= ? AND published_at <= ? AND source_id NOT IN (${marks}) ORDER BY published_at DESC, id LIMIT ?`)
      .all(since, until, ...MARKET_SOURCE_IDS, n) as Row[];
    return rows.map((r) => ({ sourceId: r.source_id as string, sourceLabel: r.source_label as string, title: r.title as string, url: r.url as string, publishedAt: r.published_at as string }));
  }

  /**
   * `dexscreener:trending` Signals first seen in [`since`, `until`] (ISO), newest first, at most `limit` (capped at 2,000): the candidate
   * list of the market-led Meta rule. Uses the (source_id, ingested_at) index. READ ONLY.
   */
  trendingSignals(since: string, until: string, limit = 2_000): TrendingSignalRow[] {
    const n = Math.max(0, Math.min(2_000, Math.floor(limit)));
    const rows = this.db
      .prepare("SELECT id, title, summary, published_at FROM signals WHERE source_id = ? AND ingested_at >= ? AND ingested_at <= ? ORDER BY ingested_at DESC, id LIMIT ?")
      .all(TRENDING_SOURCE_ID, since, until, n) as Row[];
    return rows.map((r) => ({ id: r.id as string, title: r.title as string, summary: r.summary as string, publishedAt: r.published_at as string }));
  }

  /**
   * The Metas and Watching subjects of the newest run, or of the newest run computed at or before `asOf` (ISO). Undefined before the
   * first run; a run from before ADR 0014 has the empty lists. READ ONLY.
   */
  current(asOf?: string): MetaCurrent | undefined {
    const run = (asOf === undefined
      ? this.db.prepare("SELECT id, computed_at FROM meta_runs ORDER BY computed_at DESC, id DESC LIMIT 1").get()
      : this.db.prepare("SELECT id, computed_at FROM meta_runs WHERE computed_at <= ? ORDER BY computed_at DESC, id DESC LIMIT 1").get(asOf)) as Row | undefined;
    if (!run) return undefined;
    const rows = this.db.prepare("SELECT * FROM meta_current WHERE run_id = ? ORDER BY kind, rank").all(run.id as number) as Row[];
    const out: MetaCurrent = { runId: run.id as number, computedAt: run.computed_at as string, metas: [], watching: [] };
    for (const r of rows) (r.kind === "meta" ? out.metas : out.watching).push(toCurrent(r));
    return out;
  }

  /** The summary records of these group keys (those that have one). READ ONLY. */
  summaries(keys: readonly string[]): Map<string, MetaSummaryRecord> {
    const out = new Map<string, MetaSummaryRecord>();
    const get = this.db.prepare("SELECT * FROM meta_summaries WHERE key = ?");
    for (const key of new Set(keys)) {
      const r = get.get(key) as Row | undefined;
      if (r) out.set(key, { key, summary: r.summary as string | null, summaryAt: r.summary_at as string | null, inputHash: r.input_hash as string, triedAt: r.tried_at as string, baseTokens: (r.base_tokens as number | null) ?? null, baseCreators: (r.base_creators as number | null) ?? null });
    }
    return out;
  }

  /** WORKER ONLY. Stores an accepted summary for a group, replacing the earlier one, with the 24 h counts it was written from. */
  saveSummary(key: string, summary: string, inputHash: string, at: string, base: { tokens: number; creators: number }): void {
    this.db
      .prepare(
        `INSERT INTO meta_summaries (key, summary, summary_at, input_hash, tried_at, base_tokens, base_creators) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET summary = excluded.summary, summary_at = excluded.summary_at, input_hash = excluded.input_hash, tried_at = excluded.tried_at,
           base_tokens = excluded.base_tokens, base_creators = excluded.base_creators`,
      )
      .run(key, summary, at, inputHash, at, base.tokens, base.creators);
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

  /** The newest run's top `limit` rows for one window, ranked; undefined before the first run. With `asOf` (ISO), the newest run computed at or before it. READ ONLY. */
  latest(window: MetaWindow, limit: number, asOf?: string): MetaRun | undefined {
    const n = Math.max(0, Math.min(MAX_META_READ, Math.floor(limit)));
    const r = (asOf === undefined
      ? this.db.prepare("SELECT * FROM meta_runs ORDER BY computed_at DESC, id DESC LIMIT 1").get()
      : this.db.prepare("SELECT * FROM meta_runs WHERE computed_at <= ? ORDER BY computed_at DESC, id DESC LIMIT 1").get(asOf)) as Row | undefined;
    if (!r) return undefined;
    const rows = (this.db.prepare("SELECT * FROM meta_rows WHERE run_id = ? AND win = ? AND rank <= ? ORDER BY rank").all(r.id as number, window, n) as Row[]).map((x) => toRow(x, window));
    const windowTokens = r[`base_tokens_${window}`] as number;
    const windowMigrations = r[`base_migrations_${window}`] as number;
    const summaries = this.summaries(rows.map((x) => x.key));
    const nowMs = Date.parse(r.computed_at as string); // the run's own time: a summary's age is judged as of the ranking it sits on
    for (const row of rows) {
      const s = summaries.get(row.key);
      // Ticket 06: a stored line is shown only while the row is still close to the counts it was written from.
      if (s?.summary != null && s.summaryAt != null && summaryFresh(row, s, nowMs)) {
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
      coverage:
        typeof r.coverage_hours_6h === "number" && typeof r.coverage_hours_24h === "number"
          ? {
              "6h": { covered: r.coverage_hours_6h, of: META_WINDOW_HOURS["6h"] },
              "24h": { covered: r.coverage_hours_24h, of: META_WINDOW_HOURS["24h"] },
            }
          : null,
      rows,
    };
  }
}
