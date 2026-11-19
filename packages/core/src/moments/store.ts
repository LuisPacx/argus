import type { DatabaseSync } from "node:sqlite";
import { cleanLine } from "../meme/ideas.ts";
import { MOMENT_CONFIG } from "./config.ts";
import type { PostCounts } from "./counts.ts";
import { isRising, recentRate, viewsPerHour } from "./rate.ts";
import { isStatusId, statusIdTime } from "./status-id.ts";
import type { XSessionState } from "../x-session/state.ts";

/**
 * The Moment scanner's storage (ticket 01): one row per scan, one per post, and an append-only reading of the post's five counts for each scan
 * that saw it, so a rate between two readings can be worked out later. Every post, handle and text is third-party: the text is flattened,
 * cut to 600 characters and stripped of `<` and `>` before it is stored. The worker writes; the War Room reads through `Datastore.momentsView`.
 */

/** What became of a scan. `ok`: it loaded and read what it was asked. `stopped`: a STOP signal ended it. `skipped`: nothing was loaded (the reason says why). `selectors_found_nothing`: a page had no readable posts and the scan stopped. `error`: the child failed. */
export type ScanStatus = "ok" | "stopped" | "skipped" | "selectors_found_nothing" | "error";

export interface NewScan {
  at: string;
  /** The topic's label (cleaned). */
  topic: string;
  status: ScanStatus;
  /** Page loads the scan made. */
  loads: number;
  /** The signals the pages carried (the STOP signal among them). */
  signals: string[];
  reason: string;
}

export interface ScanRow extends NewScan {
  id: number;
}

/** One post as the child read it (already parsed from the page's facts). */
export interface ScannedPost {
  statusId: string;
  handle: string;
  text: string;
  hasVideo: boolean;
  counts: PostCounts;
}

/** A rising post as the page lists it. Text is untrusted and already cleaned; the link is built from the handle and the ID, both checked. */
export interface RisingPost {
  statusId: string;
  handle: string;
  url: string;
  text: string;
  postedAt: string;
  views: number | null;
  likes: number | null;
  /** Views an hour since posting at the newest reading; null when the post does not rate. */
  viewsPerHour: number | null;
  /** Views gained an hour since the reading before; null when there is no earlier reading or it does not rate. */
  recentRate: number | null;
  readings: number;
  lastSeenAt: string;
}

export interface MomentsView {
  /** The topic of the newest scan; null before any scan. */
  topic: string | null;
  lastScan: { at: string; status: ScanStatus; reason: string; loads: number } | null;
  lastGoodScanAt: string | null;
  session: XSessionState;
  rising: RisingPost[];
}

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const BRACKETS_RE = /[<>]/g;

/** Third-party post text as it is stored and shown: one flat line of at most 600 characters, with no angle brackets. */
export function storedText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return cleanLine(raw.replace(BRACKETS_RE, " "), MOMENT_CONFIG.textChars);
}

export function migrateMoments(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS moment_scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    topic TEXT NOT NULL,
    status TEXT NOT NULL,
    loads INTEGER NOT NULL DEFAULT 0,
    signals TEXT NOT NULL DEFAULT '[]',
    reason TEXT NOT NULL DEFAULT ''
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS moment_scans_at ON moment_scans (at)");
  db.exec(`CREATE TABLE IF NOT EXISTS moment_posts (
    status_id TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    posted_at TEXT NOT NULL,
    has_video INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS moment_post_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status_id TEXT NOT NULL,
    scan_id INTEGER NOT NULL,
    seen_at TEXT NOT NULL,
    replies INTEGER,
    reposts INTEGER,
    likes INTEGER,
    bookmarks INTEGER,
    views INTEGER,
    UNIQUE (status_id, scan_id)
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS moment_post_readings_seen ON moment_post_readings (seen_at)");
  // Append only: a reading is never changed or removed.
  db.exec("CREATE TRIGGER IF NOT EXISTS moment_post_readings_no_update BEFORE UPDATE ON moment_post_readings BEGIN SELECT RAISE(ABORT, 'moment readings are append only'); END");
  db.exec("CREATE TRIGGER IF NOT EXISTS moment_post_readings_no_delete BEFORE DELETE ON moment_post_readings BEGIN SELECT RAISE(ABORT, 'moment readings are append only'); END");
}

type Row = Record<string, string | number | null>;

const toScan = (r: Row): ScanRow => ({ id: r.id as number, at: r.at as string, topic: r.topic as string, status: r.status as ScanStatus, loads: r.loads as number, signals: JSON.parse(r.signals as string) as string[], reason: r.reason as string });

/** The scanner's tables. Reached as `datastore.moments`; the worker writes. */
export class MomentStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** WORKER ONLY. One row per scan, whatever became of it. Returns its id. */
  recordScan(s: NewScan): number {
    const res = this.db
      .prepare("INSERT INTO moment_scans (at, topic, status, loads, signals, reason) VALUES (?, ?, ?, ?, ?, ?)")
      .run(s.at, storedText(s.topic).slice(0, MOMENT_CONFIG.labelChars), s.status, Math.max(0, Math.trunc(s.loads)), JSON.stringify(s.signals.slice(0, 10).map((x) => String(x).slice(0, 40))), storedText(s.reason).slice(0, 300));
    return Number(res.lastInsertRowid);
  }

  /**
   * WORKER ONLY. Stores the posts of one scan: a new post once (its first text and time stay), and one reading of its counts for this scan.
   * A post that is already read for this scan id adds nothing. A post whose ID or handle is not well-formed is skipped. Returns what was added.
   */
  recordPosts(scanId: number, seenAt: string, posts: readonly ScannedPost[]): { posts: number; readings: number; skipped: number } {
    let added = 0;
    let readings = 0;
    let skipped = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const p of posts) {
        const posted = isStatusId(p.statusId) ? statusIdTime(p.statusId) : null;
        if (posted === null || !HANDLE_RE.test(p.handle)) {
          skipped++;
          continue;
        }
        const ins = this.db
          .prepare("INSERT OR IGNORE INTO moment_posts (status_id, handle, text, posted_at, has_video, first_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(p.statusId, p.handle, storedText(p.text), posted.toISOString(), p.hasVideo ? 1 : 0, seenAt);
        added += Number(ins.changes);
        const c = p.counts;
        const r = this.db
          .prepare("INSERT OR IGNORE INTO moment_post_readings (status_id, scan_id, seen_at, replies, reposts, likes, bookmarks, views) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(p.statusId, scanId, seenAt, c.replies, c.reposts, c.likes, c.bookmarks, c.views);
        readings += Number(r.changes);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { posts: added, readings, skipped };
  }

  /** Page loads the scanner made in scans that began at or after `since` (ISO). READ ONLY. */
  loadsSince(since: string): number {
    return (this.db.prepare("SELECT COALESCE(SUM(loads), 0) AS n FROM moment_scans WHERE at >= ?").get(since) as { n: number }).n;
  }

  /** The newest scan, or undefined. READ ONLY. */
  lastScan(): ScanRow | undefined {
    const r = this.db.prepare("SELECT * FROM moment_scans ORDER BY id DESC LIMIT 1").get() as Row | undefined;
    return r && toScan(r);
  }

  /** The newest scans, newest first. READ ONLY. */
  scans(limit = 50): ScanRow[] {
    return (this.db.prepare("SELECT * FROM moment_scans ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map(toScan);
  }

  /** The time of the newest `ok` scan, or null. READ ONLY. */
  lastGoodScanAt(): string | null {
    return ((this.db.prepare("SELECT at FROM moment_scans WHERE status = 'ok' ORDER BY id DESC LIMIT 1").get() as Row | undefined)?.at as string | undefined) ?? null;
  }

  /**
   * The posts of `topic` that are rising: a post read in the last 24 hours whose views an hour since posting (at its newest reading), or whose
   * recent rate against the reading before, is at least 50,000. Newest reading first, then the faster. READ ONLY.
   */
  rising(topic: string, now: Date, limit: number = MOMENT_CONFIG.listLimit): RisingPost[] {
    const since = new Date(now.getTime() - MOMENT_CONFIG.listWindowMs).toISOString();
    const ids = this.db
      .prepare("SELECT r.status_id AS id FROM moment_post_readings r JOIN moment_scans s ON s.id = r.scan_id WHERE s.topic = ? AND r.seen_at >= ? GROUP BY r.status_id ORDER BY MAX(r.seen_at) DESC LIMIT 500")
      .all(topic, since) as { id: string }[];
    const post = this.db.prepare("SELECT * FROM moment_posts WHERE status_id = ?");
    const readingsOf = this.db.prepare("SELECT r.* FROM moment_post_readings r JOIN moment_scans s ON s.id = r.scan_id WHERE r.status_id = ? AND s.topic = ? ORDER BY r.seen_at DESC, r.id DESC");
    const out: RisingPost[] = [];
    for (const { id } of ids) {
      const p = post.get(id) as Row | undefined;
      const rs = readingsOf.all(id, topic) as Row[];
      const latest = rs[0];
      if (!p || !latest) continue;
      const posted = new Date(p.posted_at as string);
      const at = new Date(latest.seen_at as string);
      const views = (latest.views as number | null) ?? null;
      const avg = viewsPerHour(views, posted, at);
      const prior = rs[1];
      const recent = prior ? recentRate({ at: new Date(prior.seen_at as string), views: (prior.views as number | null) ?? null }, { at, views }, posted) : null;
      if (!isRising(avg, recent)) continue;
      const handle = p.handle as string;
      out.push({
        statusId: id,
        handle,
        url: `https://x.com/${handle}/status/${id}`,
        text: p.text as string,
        postedAt: p.posted_at as string,
        views,
        likes: (latest.likes as number | null) ?? null,
        viewsPerHour: avg,
        recentRate: recent,
        readings: rs.length,
        lastSeenAt: latest.seen_at as string,
      });
    }
    out.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || Math.max(b.viewsPerHour ?? 0, b.recentRate ?? 0) - Math.max(a.viewsPerHour ?? 0, a.recentRate ?? 0));
    return out.slice(0, limit);
  }

  /** What the Moments page shows (the scanner's side; the caller adds the X session state). READ ONLY. */
  view(now: Date, session: XSessionState): MomentsView {
    const last = this.lastScan();
    return {
      topic: last?.topic ?? null,
      lastScan: last ? { at: last.at, status: last.status, reason: last.reason, loads: last.loads } : null,
      lastGoodScanAt: this.lastGoodScanAt(),
      session,
      rising: last ? this.rising(last.topic, now) : [],
    };
  }
}
