import type { DatabaseSync } from "node:sqlite";
import { sourceAlerts } from "./alert.ts";
import { RADAR_CONFIG } from "./config.ts";
import type { Candidate } from "./readers/google-trends.ts";
import type { ScoreReading } from "./score.ts";
import type { CheckResult, Lookalike, SourceAlert, SourceState, SourceStatus, Trace, TracedToken, TrendSide, TrendWhy, WorkerState } from "./types.ts";

/**
 * The trend radar's storage (ticket 01): the readings (append only), the 14-day seen-set, one row per Trend, and each source's state. Every term,
 * headline and token name is third-party text: the readers and the check clean and cut it before it gets here. The worker writes; the War Room
 * reads through `Datastore.radarView` and cannot write.
 */

const DAY_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

export function migrateRadar(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS radar_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    key TEXT NOT NULL,
    term TEXT NOT NULL,
    traffic_text TEXT NOT NULL DEFAULT '',
    traffic_min INTEGER NOT NULL DEFAULT 0,
    news_title TEXT NOT NULL DEFAULT '',
    news_url TEXT NOT NULL DEFAULT '',
    seen_at TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS radar_readings_seen ON radar_readings (seen_at)");
  db.exec("CREATE INDEX IF NOT EXISTS radar_readings_key ON radar_readings (key, seen_at)");
  db.exec(`CREATE TABLE IF NOT EXISTS radar_meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  )`);
  // Append only: a reading is never changed. It is removed only by the retention prune (30 days, ADR 0016), which sets a flag row for the length of
  // its own transaction; any other DELETE is refused.
  db.exec("CREATE TRIGGER IF NOT EXISTS radar_readings_no_update BEFORE UPDATE ON radar_readings BEGIN SELECT RAISE(ABORT, 'radar readings are append only'); END");
  db.exec("DROP TRIGGER IF EXISTS radar_readings_no_delete");
  db.exec(
    "CREATE TRIGGER IF NOT EXISTS radar_readings_delete_by_prune_only BEFORE DELETE ON radar_readings WHEN NOT EXISTS (SELECT 1 FROM radar_meta WHERE k = 'pruning') BEGIN SELECT RAISE(ABORT, 'radar readings are append only; only the retention prune removes them'); END",
  );
  db.exec(`CREATE TABLE IF NOT EXISTS radar_seen (
    key TEXT PRIMARY KEY,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS radar_seen_last ON radar_seen (last_seen)");
  db.exec(`CREATE TABLE IF NOT EXISTS radar_trends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    shown INTEGER NOT NULL DEFAULT 0,
    traffic_text TEXT NOT NULL DEFAULT '',
    traffic_min INTEGER NOT NULL DEFAULT 0,
    news_title TEXT NOT NULL DEFAULT '',
    news_url TEXT NOT NULL DEFAULT '',
    side TEXT NOT NULL DEFAULT 'unchecked',
    side_at TEXT,
    trace TEXT,
    local_creates INTEGER,
    local_creators INTEGER,
    last_checked TEXT
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS radar_trends_listing ON radar_trends (shown, last_seen)");
  db.exec(`CREATE TABLE IF NOT EXISTS radar_source_state (
    source TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    last_ok TEXT,
    since TEXT NOT NULL
  )`);
  // Ticket 02: why a Trend is shown, when it last changed, and a source's label. Additive, for databases that ticket 01 already created.
  ensureColumn(db, "radar_trends", "why", "TEXT");
  ensureColumn(db, "radar_trends", "changed_at", "TEXT");
  ensureColumn(db, "radar_trends", "changed_why", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "radar_source_state", "label", "TEXT NOT NULL DEFAULT ''");
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

type Row = Record<string, string | number | null>;

/** A Trend as the worker reads it for its checks. */
export interface TrendRow {
  id: number;
  key: string;
  label: string;
  firstSeen: string;
  lastSeen: string;
  score: number;
  shown: boolean;
  side: TrendSide;
  sideAt: string | null;
  trace: Trace | null;
  localCreates: number | null;
  localCreators: number | null;
  lastChecked: string | null;
  trafficText: string;
  trafficMin: number;
  newsTitle: string;
  newsUrl: string;
  why: TrendWhy | null;
  changedAt: string | null;
  changedWhy: string;
}

export interface NewTrend {
  key: string;
  label: string;
  firstSeen: string;
  score: number;
  candidate: Pick<Candidate, "trafficText" | "trafficMin" | "newsTitle" | "newsUrl">;
  why?: TrendWhy;
}

/** A feed's reading of a phrase, as stored. `title` and `url` were cleaned (`cleanTerm`, `safeUrl`) by the reader. */
export interface FeedReading {
  source: string;
  key: string;
  term: string;
  title: string;
  url: string;
  /** The item's own date (ISO). */
  at: string;
}

/** A Trend as the page lists it (the API sends exactly these fields). */
export interface RadarTrendView {
  id: number;
  term: string;
  firstSeen: string;
  lastSeen: string;
  score: number;
  side: TrendSide;
  sideAt: string | null;
  trafficText: string;
  trafficMin: number;
  newsTitle: string;
  newsUrl: string;
  lastChecked: string | null;
  localCreates: number | null;
  localCreators: number | null;
  /** When the trace below was made; null when there is none yet. */
  traceAt: string | null;
  liveCount: number;
  /** The live token with the biggest cap. */
  biggest: TracedToken | null;
  /** At most 50, as stored (the biggest caps first); `lookalikeCount` is how many there are. */
  lookalikes: Lookalike[];
  lookalikeCount: number;
  /** Why it is shown: the sources and the parts of the score (ticket 02). Null for a Trend made before ticket 02. */
  why: TrendWhy | null;
  /** When the score crossed 70 or the coin-side state changed, and what changed; null until it does. */
  changedAt: string | null;
  changedWhy: string;
}

export interface RadarView {
  /** At most 30, highest score first. */
  trends: RadarTrendView[];
  sources: SourceState[];
  alerts: SourceAlert[];
  /** The newest good poll of any source (ISO), or null. */
  lastGoodPollAt: string | null;
  /** Over all listed Trends, not only the first 30. */
  counts: { shown: number; untokenized: number };
  /** What the worker says about itself; null when it has never written (an older worker, or never started). */
  worker: WorkerState | null;
  /** The worker is on and not in a dry run: what the page calls "enabled". */
  enabled: boolean;
}

const SIDES: readonly TrendSide[] = ["unchecked", "not traced", "taken", "contested", "tokenizing", "untokenized"];
const sideOf = (v: unknown): TrendSide => (SIDES.includes(v as TrendSide) ? (v as TrendSide) : "not traced");

function parseTrace(raw: unknown): Trace | null {
  if (typeof raw !== "string") return null;
  try {
    const t = JSON.parse(raw) as Partial<Trace> | null;
    if (!t || typeof t.at !== "string" || !Array.isArray(t.live) || !Array.isArray(t.lookalikes)) return null;
    return { at: t.at, phrases: Array.isArray(t.phrases) ? t.phrases : [], live: t.live, lookalikes: t.lookalikes };
  } catch {
    return null;
  }
}

function parseWhy(raw: unknown): TrendWhy | null {
  if (typeof raw !== "string") return null;
  try {
    const w = JSON.parse(raw) as Partial<TrendWhy> | null;
    if (!w || typeof w.at !== "string" || !Array.isArray(w.parts) || !Array.isArray(w.geos) || !Array.isArray(w.feeds)) return null;
    return { at: w.at, since: typeof w.since === "string" ? w.since : null, parts: w.parts, geos: w.geos, feeds: w.feeds, trafficText: typeof w.trafficText === "string" ? w.trafficText : "" };
  } catch {
    return null;
  }
}

function parseWorker(raw: unknown): WorkerState | null {
  if (typeof raw !== "string") return null;
  try {
    const w = JSON.parse(raw) as Partial<WorkerState> | null;
    if (!w || typeof w.enabled !== "boolean" || typeof w.startedAt !== "string") return null;
    const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : 0);
    return { enabled: w.enabled, dryRun: w.dryRun === true, startedAt: w.startedAt, lastTickAt: typeof w.lastTickAt === "string" ? w.lastTickAt : null, geos: num(w.geos), feeds: num(w.feeds) };
  } catch {
    return null;
  }
}

const toTrend = (r: Row): TrendRow => ({
  id: r.id as number,
  key: r.key as string,
  label: r.label as string,
  firstSeen: r.first_seen as string,
  lastSeen: r.last_seen as string,
  score: r.score as number,
  shown: r.shown === 1,
  side: sideOf(r.side),
  sideAt: (r.side_at as string | null) ?? null,
  trace: parseTrace(r.trace),
  localCreates: (r.local_creates as number | null) ?? null,
  localCreators: (r.local_creators as number | null) ?? null,
  lastChecked: (r.last_checked as string | null) ?? null,
  trafficText: r.traffic_text as string,
  trafficMin: r.traffic_min as number,
  newsTitle: r.news_title as string,
  newsUrl: r.news_url as string,
  why: parseWhy(r.why),
  changedAt: (r.changed_at as string | null) ?? null,
  changedWhy: (r.changed_why as string | null) ?? "",
});

const toSource = (r: Row): SourceState => ({
  source: r.source as string,
  label: (r.label as string | null) ?? "",
  status: r.status as SourceStatus,
  reason: r.reason as string,
  lastOk: (r.last_ok as string | null) ?? null,
  since: r.since as string,
});

/** The radar's tables. Reached as `datastore.radar`; the worker writes. */
export class RadarStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** WORKER ONLY. One reading, appended. */
  recordReading(c: Candidate, seenAt: string): void {
    this.db
      .prepare("INSERT INTO radar_readings (source, key, term, traffic_text, traffic_min, news_title, news_url, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(c.sourceId, c.key, c.term, c.trafficText, c.trafficMin, c.newsTitle, c.newsUrl, seenAt);
  }

  /**
   * WORKER ONLY. The seen-set: a key seen again within 14 days updates `last_seen` and is not new; a key not seen for 14 days (or never) is new
   * and starts over, and a Trend row it had is dropped so the key can become a Trend again. Returns whether the key is new.
   */
  touchSeen(key: string, now: Date): boolean {
    const at = now.toISOString();
    const keepSince = new Date(now.getTime() - RADAR_CONFIG.seenDays * DAY_MS).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT last_seen FROM radar_seen WHERE key = ?").get(key) as { last_seen: string } | undefined;
      let isNew: boolean;
      if (row && row.last_seen >= keepSince) {
        // Never moves back: a clock that reads earlier than the stored time leaves it.
        this.db.prepare("UPDATE radar_seen SET last_seen = ? WHERE key = ? AND last_seen < ?").run(at, key, at);
        isNew = false;
      } else {
        this.db.prepare("DELETE FROM radar_trends WHERE key = ?").run(key);
        this.db.prepare("INSERT OR REPLACE INTO radar_seen (key, first_seen, last_seen) VALUES (?, ?, ?)").run(key, at, at);
        isNew = true;
      }
      this.db.exec("COMMIT");
      return isNew;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * WORKER ONLY. `touchSeen` for many keys in one transaction (the headline phrases): each key's `last_seen` moves up, a key not seen for 14 days
   * starts over with a new `first_seen` and loses its Trend row, as `touchSeen` does.
   */
  touchSeenMany(keys: readonly string[], now: Date): void {
    if (keys.length === 0) return;
    const at = now.toISOString();
    const keepSince = new Date(now.getTime() - RADAR_CONFIG.seenDays * DAY_MS).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const expired = this.db.prepare("SELECT 1 FROM radar_seen WHERE key = ? AND last_seen < ?");
      const dropTrend = this.db.prepare("DELETE FROM radar_trends WHERE key = ?");
      const upsert = this.db.prepare(
        `INSERT INTO radar_seen (key, first_seen, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET first_seen = CASE WHEN last_seen < ? THEN excluded.first_seen ELSE first_seen END, last_seen = MAX(last_seen, excluded.last_seen)`,
      );
      for (const key of keys) {
        if (expired.get(key, keepSince)) dropTrend.run(key);
        upsert.run(key, at, at, keepSince);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** When a key was first seen, if it is in the seen-set and was seen in the last 14 days; else null. READ ONLY. */
  seenSince(key: string, now: Date): string | null {
    const keepSince = new Date(now.getTime() - RADAR_CONFIG.seenDays * DAY_MS).toISOString();
    const r = this.db.prepare("SELECT first_seen FROM radar_seen WHERE key = ? AND last_seen >= ?").get(key, keepSince) as { first_seen: string } | undefined;
    return r?.first_seen ?? null;
  }

  /** WORKER ONLY. A shown Trend, made once for a new key. Returns its id. */
  createTrend(t: NewTrend): number {
    const res = this.db
      .prepare("INSERT INTO radar_trends (key, label, first_seen, last_seen, score, shown, traffic_text, traffic_min, news_title, news_url, why) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)")
      .run(t.key, t.label, t.firstSeen, t.firstSeen, t.score, t.candidate.trafficText, t.candidate.trafficMin, t.candidate.newsTitle, t.candidate.newsUrl, t.why ? JSON.stringify(t.why) : null);
    return Number(res.lastInsertRowid);
  }

  /**
   * WORKER ONLY. A new reading of a key that already has a Trend: it updates the row and never makes a second one. The traffic figure only goes up
   * (the biggest country's counts), the headline is the newest one that has one.
   */
  touchTrend(key: string, c: Pick<Candidate, "trafficText" | "trafficMin" | "newsTitle" | "newsUrl">, now: Date): void {
    this.db
      .prepare(
        `UPDATE radar_trends SET last_seen = MAX(last_seen, ?),
           traffic_text = CASE WHEN ? >= traffic_min THEN ? ELSE traffic_text END, traffic_min = MAX(traffic_min, ?),
           news_title = CASE WHEN ? <> '' THEN ? ELSE news_title END, news_url = CASE WHEN ? <> '' THEN ? ELSE news_url END
         WHERE key = ?`,
      )
      .run(now.toISOString(), c.trafficMin, c.trafficText, c.trafficMin, c.newsTitle, c.newsTitle, c.newsUrl, c.newsUrl, key);
  }

  /**
   * WORKER ONLY. The score of a Trend that has been read again. The score and its "why" are the highest the Trend has reached, so the page shows
   * the strongest agreement and not the moment a feed aged out of the window. A Trend crossing the strong score (70) is flagged changed once, at the
   * crossing, and not on every tick after it.
   */
  rescore(key: string, score: number, why: TrendWhy, now: Date): void {
    const have = this.db.prepare("SELECT score FROM radar_trends WHERE key = ?").get(key) as { score: number } | undefined;
    if (!have || score < have.score) return;
    const crossed = have.score < RADAR_CONFIG.strongScore && score >= RADAR_CONFIG.strongScore;
    this.db
      .prepare("UPDATE radar_trends SET score = ?, why = ?, changed_at = CASE WHEN ? THEN ? ELSE changed_at END, changed_why = CASE WHEN ? THEN ? ELSE changed_why END WHERE key = ?")
      .run(score, JSON.stringify(why), crossed ? 1 : 0, now.toISOString(), crossed ? 1 : 0, `score rose to ${score}`, key);
  }

  /** The keys, labels and first headlines of the Trends seen in the last 24 hours (the live ones). READ ONLY. */
  liveTrends(now: Date): Array<{ key: string; label: string; newsTitle: string }> {
    const live = new Date(now.getTime() - RADAR_CONFIG.liveHours * HOUR_MS).toISOString();
    return (this.db.prepare("SELECT key, label, news_title FROM radar_trends WHERE last_seen >= ?").all(live) as Array<{ key: string; label: string; news_title: string }>).map((r) => ({ key: r.key, label: r.label, newsTitle: r.news_title }));
  }

  /** How many Trends were made since `since` (ISO): the hourly limit reads this. READ ONLY. */
  trendsCreatedSince(since: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM radar_trends WHERE first_seen >= ?").get(since) as { n: number }).n;
  }

  /** The Google readings of a key since `since` (ISO), for the score. The feeds' readings come from the in-memory counter. READ ONLY. */
  googleReadings(key: string, since: string): ScoreReading[] {
    const rows = this.db.prepare("SELECT source, traffic_min, seen_at FROM radar_readings WHERE key = ? AND seen_at >= ? AND source LIKE 'radar:google:%'").all(key, since) as Array<{ source: string; traffic_min: number; seen_at: string }>;
    return rows.map((r) => ({ source: r.source, trafficMin: r.traffic_min, at: r.seen_at }));
  }

  /**
   * WORKER ONLY. The feeds' readings of a phrase that became (or is) a Trend, one per feed and phrase inside the agreement window: a reading that is
   * already there is not written twice. Returns how many were written.
   */
  recordFeedReadings(rows: readonly FeedReading[], now: Date): number {
    if (rows.length === 0) return 0;
    const since = new Date(now.getTime() - RADAR_CONFIG.agreementWindowMs).toISOString();
    let written = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const have = this.db.prepare("SELECT 1 FROM radar_readings WHERE key = ? AND source = ? AND seen_at >= ? LIMIT 1");
      const insert = this.db.prepare("INSERT INTO radar_readings (source, key, term, traffic_text, traffic_min, news_title, news_url, seen_at) VALUES (?, ?, ?, '', 0, ?, ?, ?)");
      for (const r of rows) {
        if (have.get(r.key, r.source, since)) continue;
        insert.run(r.source, r.key, r.term, r.title, r.url, r.at);
        written++;
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return written;
  }

  /** WORKER ONLY. What the worker says about itself. */
  recordWorker(state: WorkerState): void {
    this.db.prepare("INSERT OR REPLACE INTO radar_meta (k, v) VALUES ('worker', ?)").run(JSON.stringify(state));
  }

  /** WORKER ONLY. A tick ran at `now`. Keeps the rest of what the worker said at start; a no-op until it said anything. */
  recordWorkerTick(now: Date): void {
    const have = this.workerState();
    if (have) this.recordWorker({ ...have, lastTickAt: now.toISOString() });
  }

  /** What the worker last said about itself, or null. READ ONLY. */
  workerState(): WorkerState | null {
    const r = this.db.prepare("SELECT v FROM radar_meta WHERE k = 'worker'").get() as { v: string } | undefined;
    return parseWorker(r?.v);
  }

  /** WORKER ONLY. The time the news feeds were first polled, kept from the first call on. Returns it (ISO). */
  feedsStartedAt(now: Date): string {
    this.db.prepare("INSERT OR IGNORE INTO radar_meta (k, v) VALUES ('feeds_started', ?)").run(now.toISOString());
    return (this.db.prepare("SELECT v FROM radar_meta WHERE k = 'feeds_started'").get() as { v: string }).v;
  }

  /** WORKER ONLY. A source's state after a poll. `since` moves only when the status goes to or from `ok`. */
  recordSource(source: string, status: SourceStatus, reason: string, now: Date, label = ""): void {
    const at = now.toISOString();
    const have = this.db.prepare("SELECT status, last_ok, since FROM radar_source_state WHERE source = ?").get(source) as Row | undefined;
    const lastOk = status === "ok" ? at : ((have?.last_ok as string | null | undefined) ?? null);
    const wasOk = have?.status === "ok";
    const since = !have || wasOk !== (status === "ok") ? at : (have.since as string);
    this.db
      .prepare("INSERT OR REPLACE INTO radar_source_state (source, status, reason, last_ok, since, label) VALUES (?, ?, ?, ?, ?, ?)")
      .run(source, status, status === "ok" ? "" : reason.slice(0, 200), lastOk, since, label.slice(0, 60));
  }

  /** The sources' states, by name. READ ONLY. */
  sourceStates(): SourceState[] {
    return (this.db.prepare("SELECT * FROM radar_source_state ORDER BY source").all() as Row[]).map(toSource);
  }

  /** The Trend of a key, or undefined. READ ONLY. */
  trendByKey(key: string): TrendRow | undefined {
    const r = this.db.prepare("SELECT * FROM radar_trends WHERE key = ?").get(key) as Row | undefined;
    return r && toTrend(r);
  }

  trend(id: number): TrendRow | undefined {
    const r = this.db.prepare("SELECT * FROM radar_trends WHERE id = ?").get(id) as Row | undefined;
    return r && toTrend(r);
  }

  /**
   * The shown Trends whose check is due at `now`, at most `limit`: those never checked first (a new Trend first), then live ones last checked at
   * least an hour ago, the oldest check first. Live is seen in the last 24 hours. READ ONLY.
   */
  dueChecks(now: Date, limit: number): TrendRow[] {
    const live = new Date(now.getTime() - RADAR_CONFIG.liveHours * HOUR_MS).toISOString();
    const recheck = new Date(now.getTime() - RADAR_CONFIG.recheckMinutes * MIN_MS).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM radar_trends WHERE shown = 1 AND last_seen >= ? AND (last_checked IS NULL OR last_checked <= ?)
         ORDER BY (last_checked IS NULL) DESC, last_checked ASC, first_seen ASC, id ASC LIMIT ?`,
      )
      .all(live, recheck, Math.max(0, Math.trunc(limit))) as Row[];
    return rows.map(toTrend);
  }

  /**
   * WORKER ONLY. The answer of one check. A failed check (`not traced`, no trace) keeps the last good trace and local counts and only moves the
   * state and the check time. The state's time moves only when the state changes.
   */
  recordCheck(id: number, r: CheckResult, now: Date): void {
    const at = now.toISOString();
    const have = this.db.prepare("SELECT side, side_at FROM radar_trends WHERE id = ?").get(id) as Row | undefined;
    if (!have) return;
    const sideAt = have.side === r.side && have.side_at ? (have.side_at as string) : at;
    // A change between two real coin-side states is flagged "changed" (spec 5.3). `unchecked` and `not traced` are not states of the coin side: a
    // failed check and its recovery are not a change.
    const real = (s: unknown) => s === "taken" || s === "contested" || s === "tokenizing" || s === "untokenized";
    const changed = have.side !== r.side && real(have.side) && real(r.side);
    const changedWhy = `${have.side as string} to ${r.side}`;
    if (r.trace === null || r.localCreates === null || r.localCreators === null) {
      this.db.prepare("UPDATE radar_trends SET side = ?, side_at = ?, last_checked = ? WHERE id = ?").run(r.side, sideAt, at, id);
      return;
    }
    this.db
      .prepare(
        `UPDATE radar_trends SET side = ?, side_at = ?, trace = ?, local_creates = ?, local_creators = ?, last_checked = ?,
           changed_at = CASE WHEN ? THEN ? ELSE changed_at END, changed_why = CASE WHEN ? THEN ? ELSE changed_why END WHERE id = ?`,
      )
      .run(r.side, sideAt, JSON.stringify(r.trace), r.localCreates, r.localCreators, at, changed ? 1 : 0, at, changed ? 1 : 0, changedWhy, id);
  }

  /**
   * WORKER ONLY. Keys not seen for 14 days leave the seen-set, with their Trend. Readings older than 30 days are deleted (ADR 0016 retention): the
   * one place a reading is removed, under a flag row the delete trigger looks for, inside one transaction. Returns the seen-set rows removed.
   */
  prune(now: Date): number {
    const keepSince = new Date(now.getTime() - RADAR_CONFIG.seenDays * DAY_MS).toISOString();
    const readingsSince = new Date(now.getTime() - RADAR_CONFIG.readingsKeepDays * DAY_MS).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM radar_trends WHERE last_seen < ?").run(keepSince);
      const removed = Number(this.db.prepare("DELETE FROM radar_seen WHERE last_seen < ?").run(keepSince).changes);
      this.db.exec("INSERT OR REPLACE INTO radar_meta (k, v) VALUES ('pruning', '1')");
      this.db.prepare("DELETE FROM radar_readings WHERE seen_at < ?").run(readingsSince);
      this.db.exec("DELETE FROM radar_meta WHERE k = 'pruning'");
      this.db.exec("COMMIT");
      return removed;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** The Trends listed now (shown, seen in the last 24 hours): how many, and how many are `untokenized`. READ ONLY. */
  counts(now: Date): { shown: number; untokenized: number } {
    const since = new Date(now.getTime() - RADAR_CONFIG.listWindowHours * HOUR_MS).toISOString();
    const r = this.db
      .prepare("SELECT COUNT(*) AS shown, COALESCE(SUM(side = 'untokenized'), 0) AS untokenized FROM radar_trends WHERE shown = 1 AND last_seen >= ?")
      .get(since) as { shown: number; untokenized: number };
    return { shown: r.shown, untokenized: r.untokenized };
  }

  /** What the home page's strip shows: the counts and the banners due, without reading any trace. READ ONLY. */
  strip(now: Date): { shown: number; untokenized: number; alerts: SourceAlert[]; enabled: boolean } {
    return { ...this.counts(now), alerts: sourceAlerts(this.sourceStates(), now), enabled: radarEnabled(this.workerState()) };
  }

  /** What the Radar page shows: at most 30 Trends, 50 lookalikes each, highest score first, then the newest. READ ONLY. */
  view(now: Date): RadarView {
    const since = new Date(now.getTime() - RADAR_CONFIG.listWindowHours * HOUR_MS).toISOString();
    const rows = this.db
      .prepare("SELECT * FROM radar_trends WHERE shown = 1 AND last_seen >= ? ORDER BY score DESC, last_seen DESC, id DESC LIMIT ?")
      .all(since, RADAR_CONFIG.apiMaxTrends) as Row[];
    const sources = this.sourceStates();
    const worker = this.workerState();
    const good = sources.map((s) => s.lastOk).filter((t): t is string => t !== null);
    return {
      trends: rows.map(toTrend).map(toView),
      sources,
      alerts: sourceAlerts(sources, now),
      lastGoodPollAt: good.length === 0 ? null : good.reduce((a, b) => (b > a ? b : a)),
      counts: this.counts(now),
      worker,
      enabled: radarEnabled(worker),
    };
  }
}

/** "Enabled" is what the worker says: it was started with ARGUS_RADAR=1 and not in a dry run. The War Room's own environment says nothing about it. */
export function radarEnabled(worker: WorkerState | null): boolean {
  return worker !== null && worker.enabled && !worker.dryRun;
}

function toView(t: TrendRow): RadarTrendView {
  const live = t.trace?.live ?? [];
  const lookalikes = t.trace?.lookalikes ?? [];
  const biggest = live.reduce<TracedToken | null>((a, b) => (a === null || (b.marketCapUsd ?? 0) > (a.marketCapUsd ?? 0) ? b : a), null);
  return {
    id: t.id,
    term: t.label,
    firstSeen: t.firstSeen,
    lastSeen: t.lastSeen,
    score: t.score,
    side: t.side,
    sideAt: t.sideAt,
    trafficText: t.trafficText,
    trafficMin: t.trafficMin,
    newsTitle: t.newsTitle,
    newsUrl: t.newsUrl,
    lastChecked: t.lastChecked,
    localCreates: t.localCreates,
    localCreators: t.localCreators,
    traceAt: t.trace?.at ?? null,
    liveCount: live.length,
    biggest,
    lookalikes: lookalikes.slice(0, RADAR_CONFIG.apiMaxLookalikes),
    lookalikeCount: lookalikes.length,
    why: t.why,
    changedAt: t.changedAt,
    changedWhy: t.changedWhy,
  };
}
