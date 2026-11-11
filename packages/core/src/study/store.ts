import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DomainError } from "../lifecycle.ts";
import type { PumpConnectionEvent, PumpTokenEvent } from "../sources/pumpportal.ts";
import { MAX_CAPTURE_RUNS_PER_DAY, STUDY_CAPTURE_RULE } from "./config.ts";
import type { WebsiteFetch } from "./website.ts";

/**
 * The Study's storage: tokens seen (with the PumpPortal create fields, event times and a status), the capture run ledger, gap markers
 * and the frozen Snapshots. A Snapshot is written once (a primary key on the mint and triggers that refuse UPDATE and DELETE) and only
 * for a token that is still `pending` and whose age is inside the fixed-age window, so a missed or late token can never get one.
 */

export type TokenStatus =
  /** A create was seen; waiting for the Snapshot age. */
  | "pending"
  /** The Snapshot is written. */
  | "captured"
  /** Metadata was read and names neither a website nor an X link: counted for the base rate, not studied. */
  | "counted"
  /** A migration was seen for a pump token whose create was never seen. No valid fixed-age Snapshot exists and none is made later. */
  | "missed"
  /** The create was seen but the worker was not able to capture inside the window (down, or behind). Never backfilled. */
  | "late"
  /** The daily capture run cap was reached before this token's turn. */
  | "capped"
  /** The metadata could not be read inside the window. */
  | "unreadable"
  /** Not a pump.fun launch (another launchpad) or no metadata uri: outside the Study and the base rate. */
  | "out-of-scope";

export interface StudyToken {
  mint: string;
  status: TokenStatus;
  statusReason: string;
  name: string;
  symbol: string;
  creator: string;
  uri: string;
  pool: string;
  /** The create event time: PumpPortal receipt time, which ticket 01 measured within about 1 s of the chain time. Null for a missed token. */
  createdAt: string | null;
  /** The migrate event time (receipt), once seen. */
  migratedAt: string | null;
  metadataAttempts: number;
  /** Null until the metadata has been read. */
  inPopulation: boolean | null;
  firstSeenAt: string;
}

/** The hard maximum of migrated-token examples the propose prompt can carry (ticket 22). */
export const MAX_MIGRATED_EXAMPLES = 20;

/** A migrated token as the propose prompt's examples see it: untrusted text, empty when there is no Snapshot. */
export interface MigratedExample {
  mint: string;
  name: string;
  symbol: string;
  /** PumpPortal receipt time of the migrate event; not chain time, not bot-filtered. */
  migratedAt: string;
  description: string;
  siteTitle: string;
}

/** A pump.fun token as the Meta ranking reads it: untrusted text, a create time, and the migrate time when one was seen. */
export interface LaunchedToken {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  createdAt: string;
  migratedAt: string | null;
}

export interface NewSnapshot {
  mint: string;
  description: string;
  imageUrl: string | null;
  websiteUrl: string | null;
  xUrl: string | null;
  telegramUrl: string | null;
  /** Why this token was captured (the population rule's reason). */
  selectionReason: string;
  /** The one website fetch, or null when the metadata named no website. */
  website: WebsiteFetch | null;
}

export interface StudySnapshot {
  mint: string;
  captureRuleVersion: number;
  capturedAt: string;
  /** Capture time minus create event time, in seconds. */
  ageSec: number;
  selectionReason: string;
  name: string;
  symbol: string;
  creator: string;
  uri: string;
  createEventAt: string;
  description: string;
  imageUrl: string | null;
  websiteUrl: string | null;
  xUrl: string | null;
  telegramUrl: string | null;
  /** `none` when the metadata named no website, else the fetch status. */
  siteStatus: string;
  siteDetail: string;
  siteHttpStatus: number | null;
  siteFinalUrl: string | null;
  siteContentType: string | null;
  siteTitle: string;
  siteText: string;
  siteTruncated: boolean;
  siteResponseMs: number | null;
  /** Null when there is no HTML page. */
  siteEmptyShell: boolean | null;
  contentHash: string;
}

export interface StudyGap {
  startedAt: string;
  endedAt: string | null;
  reason: "disconnect" | "restart";
}

export interface StudyStats {
  /** Creates seen on pump.fun (the base-rate denominator). */
  seen: number;
  /** Creates on other launchpads or without a uri: not counted in `seen`. */
  outOfScope: number;
  inPopulation: number;
  captured: number;
  /** Read and found to have neither link. */
  counted: number;
  pending: number;
  /** Migrations whose create the worker never saw. */
  missed: number;
  late: number;
  capped: number;
  unreadable: number;
  /** Migrations seen for pump tokens, with or without their create. */
  migrations: number;
  /** missed / migrations; null when there are none. */
  missedShare: number | null;
  /** Snapshots whose website answered with an HTML page. */
  websiteFetched: number;
  emptyShell: number;
  /** emptyShell / websiteFetched; null while no page has been fetched. */
  emptyShellShare: number | null;
  gapCount: number;
  gapSeconds: number;
  captureRuns24h: number;
  captureRunCap: number;
}

export class SnapshotNotAllowedError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotNotAllowedError";
  }
}

const DAY_MS = 24 * 3_600_000;
const MINT_PUMP_RE = /pump$/;
/** Dedupe key for names and symbols: NFKC, lowercase, letters and digits only. */
const NON_KEY_CHARS_RE = /[^\p{L}\p{Nd}]/gu;
const normaliseKey = (s: string): string => s.normalize("NFKC").toLowerCase().replace(NON_KEY_CHARS_RE, "");

export function migrateStudy(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS study_tokens (
    mint TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    status_reason TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    symbol TEXT NOT NULL DEFAULT '',
    creator TEXT NOT NULL DEFAULT '',
    uri TEXT NOT NULL DEFAULT '',
    pool TEXT NOT NULL DEFAULT '',
    signature TEXT NOT NULL DEFAULT '',
    created_at TEXT,
    migrated_at TEXT,
    first_seen_at TEXT NOT NULL,
    metadata_attempts INTEGER NOT NULL DEFAULT 0,
    in_population INTEGER
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS study_tokens_due ON study_tokens (status, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS study_tokens_first_seen ON study_tokens (first_seen_at)");
  db.exec("CREATE INDEX IF NOT EXISTS study_tokens_migrated_at ON study_tokens (migrated_at)");
  db.exec(`CREATE TABLE IF NOT EXISTS study_capture_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT NOT NULL,
    at TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS study_capture_runs_at ON study_capture_runs (at)");
  db.exec(`CREATE TABLE IF NOT EXISTS study_gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    reason TEXT NOT NULL
  )`);
  db.exec("CREATE TABLE IF NOT EXISTS study_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.exec(`CREATE TABLE IF NOT EXISTS study_snapshots (
    mint TEXT PRIMARY KEY REFERENCES study_tokens(mint),
    capture_rule_version INTEGER NOT NULL,
    captured_at TEXT NOT NULL,
    age_sec REAL NOT NULL,
    selection_reason TEXT NOT NULL,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    creator TEXT NOT NULL,
    uri TEXT NOT NULL,
    create_event_at TEXT NOT NULL,
    description TEXT NOT NULL,
    image_url TEXT,
    website_url TEXT,
    x_url TEXT,
    telegram_url TEXT,
    site_status TEXT NOT NULL,
    site_detail TEXT NOT NULL,
    site_http_status INTEGER,
    site_final_url TEXT,
    site_content_type TEXT,
    site_title TEXT NOT NULL,
    site_text TEXT NOT NULL,
    site_truncated INTEGER NOT NULL,
    site_response_ms INTEGER,
    site_empty_shell INTEGER,
    content_hash TEXT NOT NULL
  )`);
  // A Snapshot is frozen: analysis must be able to trust that what it reads is what was captured at the fixed age.
  db.exec("CREATE TRIGGER IF NOT EXISTS study_snapshots_no_update BEFORE UPDATE ON study_snapshots BEGIN SELECT RAISE(ABORT, 'study snapshots are immutable'); END");
  db.exec("CREATE TRIGGER IF NOT EXISTS study_snapshots_no_delete BEFORE DELETE ON study_snapshots BEGIN SELECT RAISE(ABORT, 'study snapshots are immutable'); END");
}

/** The hash stored with a Snapshot: sha256 over every stored field except the hash, in a fixed order. */
export function snapshotHash(s: Omit<StudySnapshot, "contentHash"> & { contentHash?: string }): string {
  const fields = [
    s.mint, s.captureRuleVersion, s.capturedAt, s.ageSec, s.selectionReason, s.name, s.symbol, s.creator, s.uri, s.createEventAt,
    s.description, s.imageUrl, s.websiteUrl, s.xUrl, s.telegramUrl, s.siteStatus, s.siteDetail, s.siteHttpStatus, s.siteFinalUrl,
    s.siteContentType, s.siteTitle, s.siteText, s.siteTruncated, s.siteResponseMs, s.siteEmptyShell,
  ];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

type Row = Record<string, string | number | null>;

const toToken = (r: Row): StudyToken => ({
  mint: r.mint as string,
  status: r.status as TokenStatus,
  statusReason: r.status_reason as string,
  name: r.name as string,
  symbol: r.symbol as string,
  creator: r.creator as string,
  uri: r.uri as string,
  pool: r.pool as string,
  createdAt: r.created_at as string | null,
  migratedAt: r.migrated_at as string | null,
  metadataAttempts: r.metadata_attempts as number,
  inPopulation: r.in_population === null ? null : r.in_population === 1,
  firstSeenAt: r.first_seen_at as string,
});

const toSnapshot = (r: Row): StudySnapshot => ({
  mint: r.mint as string,
  captureRuleVersion: r.capture_rule_version as number,
  capturedAt: r.captured_at as string,
  ageSec: r.age_sec as number,
  selectionReason: r.selection_reason as string,
  name: r.name as string,
  symbol: r.symbol as string,
  creator: r.creator as string,
  uri: r.uri as string,
  createEventAt: r.create_event_at as string,
  description: r.description as string,
  imageUrl: r.image_url as string | null,
  websiteUrl: r.website_url as string | null,
  xUrl: r.x_url as string | null,
  telegramUrl: r.telegram_url as string | null,
  siteStatus: r.site_status as string,
  siteDetail: r.site_detail as string,
  siteHttpStatus: r.site_http_status as number | null,
  siteFinalUrl: r.site_final_url as string | null,
  siteContentType: r.site_content_type as string | null,
  siteTitle: r.site_title as string,
  siteText: r.site_text as string,
  siteTruncated: r.site_truncated === 1,
  siteResponseMs: r.site_response_ms as number | null,
  siteEmptyShell: r.site_empty_shell === null ? null : r.site_empty_shell === 1,
  contentHash: r.content_hash as string,
});

/** The Study's tables. Reached as `datastore.study`; the worker writes, the War Room reads `stats` through `Datastore.studyStats`. */
export class StudyStore {
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

  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO study_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  private getMeta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM study_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  /** The newest event time the worker has had; a restart's gap starts here. */
  private alive(at: string): void {
    const last = this.getMeta("last_alive_at");
    if (last === undefined || at > last) this.setMeta("last_alive_at", at);
  }

  /** WORKER ONLY. Records one create or migrate event. Repeats are ignored; the first create and the first migrate are kept. */
  recordTokenEvent(e: PumpTokenEvent): void {
    this.alive(e.receivedAt);
    if (e.kind === "create") {
      const status: TokenStatus = e.pool !== "pump" ? "out-of-scope" : e.uri === "" ? "out-of-scope" : "pending";
      const reason = e.pool !== "pump" ? `not a pump.fun launch (pool ${e.pool || "unknown"})` : e.uri === "" ? "create carried no metadata uri" : "";
      this.db
        .prepare(
          `INSERT OR IGNORE INTO study_tokens (mint, status, status_reason, name, symbol, creator, uri, pool, signature, created_at, first_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(e.mint, status, reason, e.name, e.symbol, e.creator, e.uri, e.pool, e.signature, e.receivedAt, e.receivedAt);
      return;
    }
    if (!MINT_PUMP_RE.test(e.mint)) return; // another launchpad's migration: outside the Study
    this.tx(() => {
      const known = this.db.prepare("SELECT 1 FROM study_tokens WHERE mint = ?").get(e.mint);
      if (known) this.db.prepare("UPDATE study_tokens SET migrated_at = ? WHERE mint = ? AND migrated_at IS NULL").run(e.receivedAt, e.mint);
      else
        this.db
          .prepare("INSERT INTO study_tokens (mint, status, status_reason, pool, migrated_at, first_seen_at) VALUES (?, 'missed', 'migrate seen, create never seen', ?, ?, ?)")
          .run(e.mint, e.pool, e.receivedAt, e.receivedAt);
    });
  }

  /** WORKER ONLY. A down opens a gap (unless one is open); an up closes the open ones. */
  recordConnection(e: PumpConnectionEvent): void {
    this.alive(e.at);
    if (e.state === "down") {
      if (!this.db.prepare("SELECT 1 FROM study_gaps WHERE ended_at IS NULL").get()) this.db.prepare("INSERT INTO study_gaps (started_at, ended_at, reason) VALUES (?, NULL, 'disconnect')").run(e.at);
    } else this.db.prepare("UPDATE study_gaps SET ended_at = ? WHERE ended_at IS NULL").run(e.at);
  }

  /** WORKER ONLY, at start-up. The time since the last event the previous worker saw is a gap (reason restart), closed when the connection comes up. */
  recordBoot(_now: Date): void {
    const last = this.getMeta("last_alive_at");
    if (last === undefined) return;
    if (this.db.prepare("SELECT 1 FROM study_gaps WHERE ended_at IS NULL").get()) return;
    this.db.prepare("INSERT INTO study_gaps (started_at, ended_at, reason) VALUES (?, NULL, 'restart')").run(last);
  }

  gaps(): StudyGap[] {
    const rows = this.db.prepare("SELECT started_at, ended_at, reason FROM study_gaps ORDER BY id").all() as Row[];
    return rows.map((r) => ({ startedAt: r.started_at as string, endedAt: r.ended_at as string | null, reason: r.reason as StudyGap["reason"] }));
  }

  getToken(mint: string): StudyToken | undefined {
    const r = this.db.prepare("SELECT * FROM study_tokens WHERE mint = ?").get(mint) as Row | undefined;
    return r && toToken(r);
  }

  getSnapshot(mint: string): StudySnapshot | undefined {
    const r = this.db.prepare("SELECT * FROM study_snapshots WHERE mint = ?").get(mint) as Row | undefined;
    return r && toSnapshot(r);
  }

  /**
   * The most recently migrated tokens that have a name, newest `migrated_at` first, with the Snapshot's description and website title
   * when a Snapshot exists (about 8% do). READ ONLY; the propose prompt's examples (ticket 22). `migrated_at` is PumpPortal receipt
   * time and not bot-filtered; every text here was written by the token's creator. `limit` is clamped to 0..MAX_MIGRATED_EXAMPLES.
   */
  recentMigrated(limit: number): MigratedExample[] {
    const n = Math.max(0, Math.min(MAX_MIGRATED_EXAMPLES, Math.floor(limit)));
    if (!(n > 0)) return [];
    const rows = this.db
      .prepare(
        `SELECT t.mint, t.name, t.symbol, t.creator, t.migrated_at, s.description, s.site_title FROM study_tokens t LEFT JOIN study_snapshots s ON s.mint = t.mint
         WHERE t.migrated_at IS NOT NULL AND TRIM(t.name) <> '' ORDER BY t.migrated_at DESC, t.mint LIMIT ?`,
      )
      .all(Math.min(100, n * 5)) as Row[];
    // One example per creator, per normalised name and per normalised symbol (ticket 22); empty keys are not deduped.
    const seenCreators = new Set<string>();
    const seenNames = new Set<string>();
    const seenSymbols = new Set<string>();
    const out: MigratedExample[] = [];
    for (const r of rows) {
      if (out.length >= n) break;
      const creator = r.creator as string;
      const name = normaliseKey(r.name as string);
      const symbol = normaliseKey(r.symbol as string);
      if ((creator !== "" && seenCreators.has(creator)) || (name !== "" && seenNames.has(name)) || (symbol !== "" && seenSymbols.has(symbol))) continue;
      if (creator !== "") seenCreators.add(creator);
      if (name !== "") seenNames.add(name);
      if (symbol !== "") seenSymbols.add(symbol);
      out.push({ mint: r.mint as string, name: r.name as string, symbol: r.symbol as string, migratedAt: r.migrated_at as string, description: (r.description as string | null) ?? "", siteTitle: (r.site_title as string | null) ?? "" });
    }
    return out;
  }

  /**
   * READ ONLY. The pump.fun tokens whose create was seen from `fromIso` to `toIso` (both ISO, inclusive), for the Meta ranking (viral
   * sources ticket 03). Other launchpads' creates (`out-of-scope`) and migrations whose create was never seen (`missed`, no create time)
   * are left out. Text fields are creator-written. One indexed pass; nothing is written.
   */
  createdBetween(fromIso: string, toIso: string): LaunchedToken[] {
    const rows = this.db
      .prepare(
        `SELECT mint, name, symbol, creator, created_at, migrated_at FROM study_tokens
         WHERE first_seen_at >= ? AND created_at >= ? AND created_at <= ? AND status <> 'out-of-scope'`,
      )
      .all(fromIso, fromIso, toIso) as Row[];
    return rows.map((r) => ({
      mint: r.mint as string,
      name: r.name as string,
      symbol: r.symbol as string,
      creator: r.creator as string,
      createdAt: r.created_at as string,
      migratedAt: r.migrated_at as string | null,
    }));
  }

  /** Pending tokens whose age has reached the Snapshot age at `now`, oldest create first. */
  dueTokens(now: Date, limit: number, rule = STUDY_CAPTURE_RULE): StudyToken[] {
    const cutoff = new Date(now.getTime() - rule.snapshotAgeSec * 1000).toISOString();
    const rows = this.db.prepare("SELECT * FROM study_tokens WHERE status = 'pending' AND created_at <= ? ORDER BY created_at, mint LIMIT ?").all(cutoff, limit) as Row[];
    return rows.map(toToken);
  }

  /**
   * Starts one capture run if fewer than `cap` have started in the 24 hours before `now`; the cap can only be lower than
   * MAX_CAPTURE_RUNS_PER_DAY. Returns false (and records nothing) when the cap is reached.
   */
  beginCaptureRun(mint: string, now: Date, cap: number): boolean {
    const max = Math.min(MAX_CAPTURE_RUNS_PER_DAY, cap);
    return this.tx(() => {
      if (this.captureRunsSince(new Date(now.getTime() - DAY_MS)) >= max) return false;
      this.db.prepare("INSERT INTO study_capture_runs (mint, at) VALUES (?, ?)").run(mint, now.toISOString());
      return true;
    });
  }

  captureRunsSince(since: Date): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM study_capture_runs WHERE at > ?").get(since.toISOString()) as { n: number }).n;
  }

  /** Counts one metadata fetch attempt against a pending token; returns the attempts so far. */
  bumpMetadataAttempts(mint: string): number {
    this.db.prepare("UPDATE study_tokens SET metadata_attempts = metadata_attempts + 1 WHERE mint = ? AND status = 'pending'").run(mint);
    return this.getToken(mint)?.metadataAttempts ?? 0;
  }

  /** Moves a pending token to a final status other than captured (counted, late, capped, unreadable). Throws if it is not pending. */
  markToken(mint: string, status: Exclude<TokenStatus, "pending" | "captured" | "missed" | "out-of-scope">, reason: string, patch: { inPopulation?: boolean } = {}): void {
    const res = this.db
      .prepare("UPDATE study_tokens SET status = ?, status_reason = ?, in_population = COALESCE(?, in_population) WHERE mint = ? AND status = 'pending'")
      .run(status, reason.slice(0, 200), patch.inPopulation === undefined ? null : Number(patch.inPopulation), mint);
    if (Number(res.changes) === 0) throw new SnapshotNotAllowedError(`token ${mint} is not pending`);
  }

  /**
   * WORKER ONLY. Writes the token's Snapshot, once. The token must be pending (so not missed, late, captured or out of scope) and `now`
   * must be inside the fixed-age window after its create event; otherwise it throws and writes nothing.
   */
  recordSnapshot(input: NewSnapshot, now: Date, rule = STUDY_CAPTURE_RULE): StudySnapshot {
    return this.tx(() => {
      const t = this.getToken(input.mint);
      if (!t) throw new SnapshotNotAllowedError(`no token ${input.mint}`);
      if (t.status !== "pending" || t.createdAt === null) throw new SnapshotNotAllowedError(`token ${input.mint} is ${t.status}, not pending: no Snapshot`);
      const ageSec = Math.round(((now.getTime() - Date.parse(t.createdAt)) / 1000) * 10) / 10;
      if (ageSec < rule.snapshotAgeSec || ageSec > rule.snapshotAgeSec + rule.captureGraceSec) {
        throw new SnapshotNotAllowedError(`age ${ageSec} s is outside the fixed capture age (${rule.snapshotAgeSec} to ${rule.snapshotAgeSec + rule.captureGraceSec} s)`);
      }
      const w = input.website;
      const body: Omit<StudySnapshot, "contentHash"> = {
        mint: t.mint,
        captureRuleVersion: rule.version,
        capturedAt: now.toISOString(),
        ageSec,
        selectionReason: input.selectionReason,
        name: t.name,
        symbol: t.symbol,
        creator: t.creator,
        uri: t.uri,
        createEventAt: t.createdAt,
        description: input.description,
        imageUrl: input.imageUrl,
        websiteUrl: input.websiteUrl,
        xUrl: input.xUrl,
        telegramUrl: input.telegramUrl,
        siteStatus: w ? w.status : "none",
        siteDetail: w?.detail ?? "",
        siteHttpStatus: w?.httpStatus ?? null,
        siteFinalUrl: w?.finalUrl ?? null,
        siteContentType: w?.contentType ?? null,
        siteTitle: w?.title ?? "",
        siteText: w?.text ?? "",
        siteTruncated: w?.truncated ?? false,
        siteResponseMs: w?.responseMs ?? null,
        siteEmptyShell: w?.emptyShell ?? null,
      };
      const snapshot: StudySnapshot = { ...body, contentHash: snapshotHash(body) };
      this.db
        .prepare(
          `INSERT INTO study_snapshots (mint, capture_rule_version, captured_at, age_sec, selection_reason, name, symbol, creator, uri, create_event_at,
             description, image_url, website_url, x_url, telegram_url, site_status, site_detail, site_http_status, site_final_url, site_content_type,
             site_title, site_text, site_truncated, site_response_ms, site_empty_shell, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshot.mint, snapshot.captureRuleVersion, snapshot.capturedAt, snapshot.ageSec, snapshot.selectionReason, snapshot.name, snapshot.symbol,
          snapshot.creator, snapshot.uri, snapshot.createEventAt, snapshot.description, snapshot.imageUrl, snapshot.websiteUrl, snapshot.xUrl,
          snapshot.telegramUrl, snapshot.siteStatus, snapshot.siteDetail, snapshot.siteHttpStatus, snapshot.siteFinalUrl, snapshot.siteContentType,
          snapshot.siteTitle, snapshot.siteText, Number(snapshot.siteTruncated), snapshot.siteResponseMs,
          snapshot.siteEmptyShell === null ? null : Number(snapshot.siteEmptyShell), snapshot.contentHash,
        );
      this.db
        .prepare("UPDATE study_tokens SET status = 'captured', status_reason = ?, in_population = 1 WHERE mint = ?")
        .run(input.selectionReason, t.mint);
      return snapshot;
    });
  }

  /** The Study page's health numbers; `since` (ISO) limits tokens to those first seen at or after it. */
  stats(now: Date, since?: string, captureRunCap: number = MAX_CAPTURE_RUNS_PER_DAY): StudyStats {
    const from = since ?? "";
    const count = (where: string) => (this.db.prepare(`SELECT COUNT(*) AS n FROM study_tokens WHERE first_seen_at >= ? AND ${where}`).get(from) as { n: number }).n;
    const byStatus = (s: TokenStatus) => count(`status = '${s}'`);
    const snaps = this.db
      .prepare(
        `SELECT COALESCE(SUM(s.site_status = 'ok'), 0) AS fetched, COALESCE(SUM(s.site_empty_shell = 1), 0) AS shells
         FROM study_snapshots s JOIN study_tokens t ON t.mint = s.mint WHERE t.first_seen_at >= ?`,
      )
      .get(from) as { fetched: number; shells: number };
    const migrations = count("migrated_at IS NOT NULL");
    const missed = byStatus("missed");
    const gapRows = this.db.prepare("SELECT started_at, ended_at FROM study_gaps WHERE COALESCE(ended_at, ?) >= ?").all(now.toISOString(), from) as Array<{ started_at: string; ended_at: string | null }>;
    const gapSeconds = gapRows.reduce((sum, g) => sum + Math.max(0, ((g.ended_at ? Date.parse(g.ended_at) : now.getTime()) - Math.max(Date.parse(g.started_at), from ? Date.parse(from) : 0)) / 1000), 0);
    return {
      seen: count("created_at IS NOT NULL AND status != 'out-of-scope'"),
      outOfScope: byStatus("out-of-scope"),
      inPopulation: count("in_population = 1"),
      captured: byStatus("captured"),
      counted: byStatus("counted"),
      pending: byStatus("pending"),
      missed,
      late: byStatus("late"),
      capped: byStatus("capped"),
      unreadable: byStatus("unreadable"),
      migrations,
      missedShare: migrations === 0 ? null : missed / migrations,
      websiteFetched: snaps.fetched,
      emptyShell: snaps.shells,
      emptyShellShare: snaps.fetched === 0 ? null : snaps.shells / snaps.fetched,
      gapCount: gapRows.length,
      gapSeconds: Math.round(gapSeconds),
      captureRuns24h: this.captureRunsSince(new Date(now.getTime() - DAY_MS)),
      captureRunCap: Math.min(MAX_CAPTURE_RUNS_PER_DAY, captureRunCap),
    };
  }
}
