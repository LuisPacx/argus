import type { DatabaseSync } from "node:sqlite";
import { DomainError } from "../lifecycle.ts";
import { MOMENT_CONFIG } from "../moments/config.ts";

/**
 * The X session's shared stop state (Moment scanner ticket 01, item 7a; ADR 0009 as amended 2026-11-19). The account is the Operator's one
 * logged-in X profile, so the state belongs to the account, not to the scanner: any X job (the scanner now, the Study's capture later)
 * reads it first and loads nothing while it is `stopped`.
 *
 *  - A STOP signal (a login wall, a challenge, a lock, an own-account suspension, a rate limit) sets `stopped` until 00:00 UTC.
 *  - The first X job after that makes exactly one probe load (the topic's own search address, never a profile page); a clean probe clears it.
 *  - A second STOP within 7 days of the last one sets `stopped` with no resume time: only the Operator's Resume clears it.
 *  - Resume is one request row the War Room inserts (every press recorded); the worker clears the state on its next tick.
 * `not_found` and `target_suspended` pages are not STOP signals and never reach this module.
 */

export const X_STOP_SIGNALS = ["login_wall", "challenge", "locked", "own_suspended", "rate_limited"] as const;
export type XStopSignal = (typeof X_STOP_SIGNALS)[number];
export const isXStopSignal = (s: unknown): s is XStopSignal => (X_STOP_SIGNALS as readonly unknown[]).includes(s);

export type XSessionStatus = "ok" | "stopped";

/** What the Moments page and any X job may see of the state. */
export interface XSessionState {
  status: XSessionStatus;
  /** The STOP signal that set it; empty when `ok`. */
  reason: string;
  stoppedAt: string | null;
  /** When the next UTC day starts and one probe load is allowed; null means only the Operator's Resume clears it. */
  resumeAt: string | null;
  /** STOP signals inside the current 7-day window (1 = first, 2 or more = repeated). */
  strikes: number;
  /** True when the day has come and the one probe load has not been made yet. Worked out from the stored times, never stored itself. */
  probeDue: boolean;
}

/** What an X job may do right now. */
export type XSessionGate = { mode: "go" } | { mode: "probe" } | { mode: "stopped"; reason: string; resumeAt: string | null };

/** The War Room asked for a Resume that the state does not allow. */
export class XSessionRefusedError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "XSessionRefusedError";
  }
}

export interface ResumeRequest {
  id: number;
  createdAt: string;
  status: "pending" | "applied";
  appliedAt: string | null;
}

export function migrateXSession(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS x_session_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL DEFAULT 'ok',
    reason TEXT NOT NULL DEFAULT '',
    stopped_at TEXT,
    resume_at TEXT,
    strikes INTEGER NOT NULL DEFAULT 0,
    last_stop_at TEXT,
    probe_started_at TEXT
  )`);
  db.exec("INSERT OR IGNORE INTO x_session_state (id) VALUES (1)");
  db.exec(`CREATE TABLE IF NOT EXISTS x_session_resume_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    applied_at TEXT
  )`);
}

type Row = Record<string, string | number | null>;

/** 00:00 UTC of the day after `now`. */
export const nextUtcMidnight = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

/** The one Telegram text of a STOP: plain text, nothing from X in it. */
export function xStopText(signal: XStopSignal, resumeAt: string | null): string {
  const what: Record<XStopSignal, string> = {
    login_wall: "X showed a login wall",
    challenge: "X asked for a challenge",
    locked: "X says the account is locked",
    own_suspended: "X says the account is suspended",
    rate_limited: "X rate-limited the account",
  };
  const until = resumeAt === null ? "until you press Resume on the Moments page (this is the second stop within 7 days)" : "until 00:00 UTC, then one probe load decides whether to go on";
  return `X session stopped: ${what[signal]} (${signal}). Argus loads nothing from X ${until}.`;
}

/** The X session's state table. Reached as `datastore.xSession`. The War Room may only read the state and insert a Resume request. */
export class XSessionStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private row(): Row {
    return this.db.prepare("SELECT * FROM x_session_state WHERE id = 1").get() as Row;
  }

  /** The state as of `now`; `probeDue` is worked out here and written nowhere. READ ONLY. */
  state(now: Date): XSessionState {
    const r = this.row();
    const stopped = r.status === "stopped";
    const resumeAt = (r.resume_at as string | null) ?? null;
    const probeStarted = (r.probe_started_at as string | null) ?? null;
    const probeDue = stopped && resumeAt !== null && now.getTime() >= Date.parse(resumeAt) && (probeStarted === null || Date.parse(probeStarted) < Date.parse(resumeAt));
    return { status: stopped ? "stopped" : "ok", reason: r.reason as string, stoppedAt: (r.stopped_at as string | null) ?? null, resumeAt, strikes: r.strikes as number, probeDue };
  }

  /** What an X job may do now. READ ONLY. */
  gate(now: Date): XSessionGate {
    const s = this.state(now);
    if (s.status === "ok") return { mode: "go" };
    if (s.probeDue) return { mode: "probe" };
    return { mode: "stopped", reason: s.reason, resumeAt: s.resumeAt };
  }

  /**
   * WORKER ONLY. Records a STOP signal: `stopped` until the next 00:00 UTC, or with no resume time when the last STOP was within 7 days.
   * Returns the state and whether this was a repeat. A signal that is not a STOP changes nothing and returns null.
   */
  recordStop(signal: string, now: Date): { state: XSessionState; repeated: boolean } | null {
    if (!isXStopSignal(signal)) return null;
    const r = this.row();
    const last = (r.last_stop_at as string | null) ?? null;
    const repeated = last !== null && now.getTime() - Date.parse(last) <= MOMENT_CONFIG.repeatStopMs;
    const strikes = repeated ? (r.strikes as number) + 1 : 1;
    const resumeAt = repeated ? null : nextUtcMidnight(now).toISOString();
    this.db
      .prepare("UPDATE x_session_state SET status = 'stopped', reason = ?, stopped_at = ?, resume_at = ?, strikes = ?, last_stop_at = ?, probe_started_at = NULL WHERE id = 1")
      .run(signal, now.toISOString(), resumeAt, strikes, now.toISOString());
    return { state: this.state(now), repeated };
  }

  /** WORKER ONLY. The one probe load is about to be made: it is spent whatever comes of it. */
  beginProbe(now: Date): void {
    this.db.prepare("UPDATE x_session_state SET probe_started_at = ? WHERE id = 1").run(now.toISOString());
  }

  /** WORKER ONLY. A probe page loaded clean: the state is `ok` again (the 7-day window of the last STOP stays). */
  clearOnCleanProbe(): void {
    this.db.prepare("UPDATE x_session_state SET status = 'ok', reason = '', resume_at = NULL, probe_started_at = NULL WHERE id = 1").run();
  }

  /** WORKER ONLY. The probe loaded but was not clean (and was not a STOP): stay stopped, try again after the next 00:00 UTC. */
  probeNotClean(now: Date): void {
    this.db.prepare("UPDATE x_session_state SET resume_at = ? WHERE id = 1").run(nextUtcMidnight(now).toISOString());
  }

  /** The War Room's one write. Insert only, refused unless the state is `stopped`; every press is a row. */
  requestResume(now: Date = new Date()): ResumeRequest {
    if (this.row().status !== "stopped") throw new XSessionRefusedError("The X session is not stopped: there is nothing to resume");
    const res = this.db.prepare("INSERT INTO x_session_resume_requests (created_at, status) VALUES (?, 'pending')").run(now.toISOString());
    return { id: Number(res.lastInsertRowid), createdAt: now.toISOString(), status: "pending", appliedAt: null };
  }

  /** The Resume presses the worker has not applied yet. READ ONLY. */
  pendingResumes(): ResumeRequest[] {
    return (this.db.prepare("SELECT * FROM x_session_resume_requests WHERE status = 'pending' ORDER BY id").all() as Row[]).map((r) => ({
      id: r.id as number,
      createdAt: r.created_at as string,
      status: "pending" as const,
      appliedAt: null,
    }));
  }

  /** All Resume presses, newest first, for the test and the page's audit line. READ ONLY. */
  resumeRequests(limit = 20): ResumeRequest[] {
    return (this.db.prepare("SELECT * FROM x_session_resume_requests ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map((r) => ({
      id: r.id as number,
      createdAt: r.created_at as string,
      status: r.status as "pending" | "applied",
      appliedAt: (r.applied_at as string | null) ?? null,
    }));
  }

  /**
   * WORKER ONLY. Applies every waiting Resume and marks the presses applied. Only a press made after the current stop began clears it: an
   * earlier press (one that was never applied before a newer stop) can never clear that newer stop, least of all a second stop that
   * waits for the Operator. Returns whether it cleared a stop.
   */
  applyResumes(now: Date): boolean {
    const pending = this.pendingResumes();
    if (pending.length === 0) return false;
    const r = this.row();
    const stoppedAt = (r.stopped_at as string | null) ?? null;
    const wasStopped = r.status === "stopped";
    const fresh = wasStopped && pending.some((p) => stoppedAt === null || Date.parse(p.createdAt) > Date.parse(stoppedAt));
    if (fresh) this.clearOnCleanProbe();
    for (const p of pending) this.db.prepare("UPDATE x_session_resume_requests SET status = 'applied', applied_at = ? WHERE id = ?").run(now.toISOString(), p.id);
    return fresh;
  }
}

/**
 * Every X job goes through this first. It runs `job` only when the account is `ok` ("go") or when the one probe load is due ("probe": the
 * job must make that one load, the topic's own search address, and nothing more). While the state is `stopped` the job is not called, so it
 * loads nothing. The scanner and any later X job (the Study's capture) use the same gate, so each pauses with the other.
 */
export async function runXJob<T>(xs: Pick<XSessionStore, "gate">, now: Date, job: (mode: "go" | "probe") => Promise<T>): Promise<{ ran: true; mode: "go" | "probe"; result: T } | { ran: false; reason: string; resumeAt: string | null }> {
  const gate = xs.gate(now);
  if (gate.mode === "stopped") return { ran: false, reason: gate.reason, resumeAt: gate.resumeAt };
  return { ran: true, mode: gate.mode, result: await job(gate.mode) };
}
