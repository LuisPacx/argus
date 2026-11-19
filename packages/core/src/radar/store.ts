import type { DatabaseSync } from "node:sqlite";
import { sourceAlerts } from "./alert.ts";
import { RADAR_CONFIG } from "./config.ts";
import type { Candidate } from "./readers/google-trends.ts";
import type { CheckResult, Lookalike, SourceAlert, SourceState, SourceStatus, Trace, TracedToken, TrendSide } from "./types.ts";

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
  // Append only: a reading is never changed or removed.
  db.exec("CREATE TRIGGER IF NOT EXISTS radar_readings_no_update BEFORE UPDATE ON radar_readings BEGIN SELECT RAISE(ABORT, 'radar readings are append only'); END");
  db.exec("CREATE TRIGGER IF NOT EXISTS radar_readings_no_delete BEFORE DELETE ON radar_readings BEGIN SELECT RAISE(ABORT, 'radar readings are append only'); END");
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
}

export interface NewTrend {
  key: string;
  label: string;
  firstSeen: string;
  score: number;
  candidate: Pick<Candidate, "trafficText" | "trafficMin" | "newsTitle" | "newsUrl">;
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
}

export interface RadarView {
  /** At most 100, highest score first. */
  trends: RadarTrendView[];
  sources: SourceState[];
  alerts: SourceAlert[];
  /** The newest good poll of any source (ISO), or null. */
  lastGoodPollAt: string | null;
  /** Over all listed Trends, not only the first 100. */
  counts: { shown: number; untokenized: number };
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
});

const toSource = (r: Row): SourceState => ({ source: r.source as string, status: r.status as SourceStatus, reason: r.reason as string, lastOk: (r.last_ok as string | null) ?? null, since: r.since as string });

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

  /** WORKER ONLY. A shown Trend, made once for a new key. Returns its id. */
  createTrend(t: NewTrend): number {
    const res = this.db
      .prepare("INSERT INTO radar_trends (key, label, first_seen, last_seen, score, shown, traffic_text, traffic_min, news_title, news_url) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)")
      .run(t.key, t.label, t.firstSeen, t.firstSeen, t.score, t.candidate.trafficText, t.candidate.trafficMin, t.candidate.newsTitle, t.candidate.newsUrl);
    return Number(res.lastInsertRowid);
  }

  /** WORKER ONLY. A new reading of a key that already has a Trend: it updates the row and never makes a second one. */
  touchTrend(key: string, c: Pick<Candidate, "trafficText" | "trafficMin" | "newsTitle" | "newsUrl">, score: number, now: Date): void {
    this.db
      .prepare(
        `UPDATE radar_trends SET last_seen = ?, traffic_text = ?, traffic_min = ?, score = ?,
           news_title = CASE WHEN ? <> '' THEN ? ELSE news_title END, news_url = CASE WHEN ? <> '' THEN ? ELSE news_url END
         WHERE key = ? AND last_seen < ?`,
      )
      .run(now.toISOString(), c.trafficText, c.trafficMin, score, c.newsTitle, c.newsTitle, c.newsUrl, c.newsUrl, key, now.toISOString());
  }

  /** WORKER ONLY. A source's state after a poll. `since` moves only when the status goes to or from `ok`. */
  recordSource(source: string, status: SourceStatus, reason: string, now: Date): void {
    const at = now.toISOString();
    const have = this.db.prepare("SELECT status, last_ok, since FROM radar_source_state WHERE source = ?").get(source) as Row | undefined;
    const lastOk = status === "ok" ? at : ((have?.last_ok as string | null | undefined) ?? null);
    const wasOk = have?.status === "ok";
    const since = !have || wasOk !== (status === "ok") ? at : (have.since as string);
    this.db
      .prepare("INSERT OR REPLACE INTO radar_source_state (source, status, reason, last_ok, since) VALUES (?, ?, ?, ?, ?)")
      .run(source, status, status === "ok" ? "" : reason.slice(0, 200), lastOk, since);
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
    if (r.trace === null || r.localCreates === null || r.localCreators === null) {
      this.db.prepare("UPDATE radar_trends SET side = ?, side_at = ?, last_checked = ? WHERE id = ?").run(r.side, sideAt, at, id);
      return;
    }
    this.db
      .prepare("UPDATE radar_trends SET side = ?, side_at = ?, trace = ?, local_creates = ?, local_creators = ?, last_checked = ? WHERE id = ?")
      .run(r.side, sideAt, JSON.stringify(r.trace), r.localCreates, r.localCreators, at, id);
  }

  /** WORKER ONLY. Keys not seen for 14 days leave the seen-set, with their Trend. Readings are append only and stay. */
  prune(now: Date): number {
    const keepSince = new Date(now.getTime() - RADAR_CONFIG.seenDays * DAY_MS).toISOString();
    this.db.prepare("DELETE FROM radar_trends WHERE last_seen < ?").run(keepSince);
    return Number(this.db.prepare("DELETE FROM radar_seen WHERE last_seen < ?").run(keepSince).changes);
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
  strip(now: Date): { shown: number; untokenized: number; alerts: SourceAlert[] } {
    return { ...this.counts(now), alerts: sourceAlerts(this.sourceStates(), now) };
  }

  /** What the Radar page shows: at most 100 Trends, 50 lookalikes each, highest score first, then the newest. READ ONLY. */
  view(now: Date): RadarView {
    const since = new Date(now.getTime() - RADAR_CONFIG.listWindowHours * HOUR_MS).toISOString();
    const rows = this.db
      .prepare("SELECT * FROM radar_trends WHERE shown = 1 AND last_seen >= ? ORDER BY score DESC, last_seen DESC, id DESC LIMIT ?")
      .all(since, RADAR_CONFIG.apiMaxTrends) as Row[];
    const sources = this.sourceStates();
    const good = sources.map((s) => s.lastOk).filter((t): t is string => t !== null);
    return {
      trends: rows.map(toTrend).map(toView),
      sources,
      alerts: sourceAlerts(sources, now),
      lastGoodPollAt: good.length === 0 ? null : good.reduce((a, b) => (b > a ? b : a)),
      counts: this.counts(now),
    };
  }
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
  };
}
