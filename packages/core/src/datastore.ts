import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeEvidenceLinks } from "./evidence-links.ts";
import {
  DomainError,
  ProposalNotFoundError,
  assertTransition,
  type Actor,
  type Command,
  type CommandType,
  type HistoryEntry,
  type ProposalStatus,
} from "./lifecycle.ts";

export interface Proposal {
  id: number;
  slug: string;
  status: ProposalStatus;
  narrativeSummary: string;
  techOneLiner: string;
  whyNow: string;
  name: string;
  ticker: string;
  description: string;
  evidenceLinks: string[];
  /** Sum of `total_cost_usd` over the Proposal's brain runs. */
  agentCostUsd: number;
  specPath: string | null;
  specHash: string | null;
  /** Last Spec drafting failure; empty when none. The Proposal stays `shortlisted` while it is set. */
  specError: string;
  /** When set, a rate-limited draft may be retried after this ISO time. */
  specRetryAfter: string | null;
  /** Rate-limited Spec drafts so far; retries stop at MAX_SPEC_RATE_LIMIT_ATTEMPTS. */
  specAttempts: number;
  /**
   * When the oldest open (`in-flight`) brain run started, else null. A Proposal with one is not re-drafted; if the
   * worker is not running it is stale, and the next worker boot marks it `interrupted` and sets `specError`.
   */
  brainRunInFlightSince: string | null;
  /** The Operator's queued "ask the agent to revise" instruction, until the worker runs it. Untrusted text. */
  specRevision: string | null;
  /** When the Operator approved (the FIFO key for the Build queue); null until then. */
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrainRunRecord {
  id: number;
  proposalId: number;
  task: string;
  backend: string;
  model: string;
  sessionId: string | null;
  totalCostUsd: number;
  exitStatus: string;
  createdAt: string;
}

export type NewBrainRun = Omit<BrainRunRecord, "id" | "createdAt">;

/** `brain_runs.exit_status` while the child is running; a crash leaves it behind, see interruptStaleBrainRuns. */
export const BRAIN_RUN_IN_FLIGHT = "in-flight";
export const BRAIN_RUN_INTERRUPTED = "interrupted";

export interface NewProposal {
  narrativeSummary: string;
  techOneLiner: string;
  whyNow: string;
  name: string;
  ticker: string;
  description: string;
  evidenceLinks: string[];
}

/** Non-domain failures tolerated per command before it is marked `failed`. */
export const MAX_COMMAND_ATTEMPTS = 5;

/** Rate-limited Spec drafts tolerated per Proposal before it stops retrying and shows the failure. */
export const MAX_SPEC_RATE_LIMIT_ATTEMPTS = 3;

export const DEFAULT_DB_PATH = ".data/argus.db";

/** Adds a column only when missing, so migrations can run repeatedly (helios pattern). */
function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    applied_at TEXT
  )`);
  ensureColumn(db, "proposals", "narrative_summary", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "proposals", "tech_one_liner", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "proposals", "why_now", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "proposals", "name", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "proposals", "ticker", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "proposals", "description", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "proposals", "evidence_links", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "proposals", "agent_cost_usd", "REAL NOT NULL DEFAULT 0");
  db.exec(`CREATE TABLE IF NOT EXISTS brain_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    task TEXT NOT NULL,
    backend TEXT NOT NULL,
    model TEXT NOT NULL,
    session_id TEXT,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    exit_status TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  ensureColumn(db, "proposals", "spec_path", "TEXT");
  ensureColumn(db, "proposals", "spec_hash", "TEXT");
  ensureColumn(db, "proposals", "spec_error", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "proposals", "spec_retry_after", "TEXT");
  ensureColumn(db, "proposals", "spec_attempts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "proposals", "spec_revision", "TEXT");
  ensureColumn(db, "proposals", "approved_at", "TEXT");
  ensureColumn(db, "commands", "attempts", "INTEGER NOT NULL DEFAULT 0");
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface Row {
  id: number;
  slug: string;
  status: ProposalStatus;
  narrative_summary: string;
  tech_one_liner: string;
  why_now: string;
  name: string;
  ticker: string;
  description: string;
  evidence_links: string;
  cost_usd: number;
  spec_path: string | null;
  spec_hash: string | null;
  spec_error: string;
  spec_retry_after: string | null;
  spec_attempts: number;
  in_flight_since: string | null;
  spec_revision: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

const PROPOSAL_SELECT = `SELECT p.*, (SELECT COALESCE(SUM(total_cost_usd), 0) FROM brain_runs b WHERE b.proposal_id = p.id) AS cost_usd, (SELECT MIN(created_at) FROM brain_runs b WHERE b.proposal_id = p.id AND b.exit_status = '${BRAIN_RUN_IN_FLIGHT}') AS in_flight_since FROM proposals p`;

function toProposal(r: Row): Proposal {
  return {
    id: r.id,
    slug: r.slug,
    status: r.status,
    narrativeSummary: r.narrative_summary,
    techOneLiner: r.tech_one_liner,
    whyNow: r.why_now,
    name: r.name,
    ticker: r.ticker,
    description: r.description,
    evidenceLinks: JSON.parse(r.evidence_links) as string[],
    agentCostUsd: r.cost_usd,
    specPath: r.spec_path,
    specHash: r.spec_hash,
    specError: r.spec_error,
    specRetryAfter: r.spec_retry_after,
    specAttempts: r.spec_attempts,
    brainRunInFlightSince: r.in_flight_since,
    specRevision: r.spec_revision,
    approvedAt: r.approved_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * What the War Room may use: reads, `enqueueCommand` and `createProposal`. No `transition` or
 * `resolveCommand`: only the worker writes status (CODING_STANDARDS.md rule 1).
 */
export type WarRoomStore = Pick<
  Datastore,
  | "getProposal"
  | "listProposals"
  | "getCommand"
  | "listCommands"
  | "pendingCommands"
  | "historyFor"
  | "enqueueCommand"
  | "createProposal"
  | "saveSpec"
>;

/** The Spec was changed since the caller loaded it (or spec.md no longer matches the stored hash). */
export class SpecConflictError extends DomainError {
  constructor(message = "The Spec changed since you opened it. Reload to see the current version before saving.") {
    super(message);
    this.name = "SpecConflictError";
  }
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export class Datastore {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Opens (creating if needed) the database in WAL mode and applies migrations. */
  static open(path: string = DEFAULT_DB_PATH): Datastore {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    migrate(db);
    return new Datastore(db);
  }

  close(): void {
    this.db.close();
  }

  /** Inserts a Proposal with status `new` and its first history row, atomically. Not a status transition. */
  createProposal(input: NewProposal): Proposal {
    const evidenceLinks = normalizeEvidenceLinks(input.evidenceLinks);
    const base = slugify(input.name) || "proposal";
    const id = this.inTransaction(() => {
      let slug = base;
      for (let n = 2; this.db.prepare("SELECT 1 FROM proposals WHERE slug = ?").get(slug); n++) {
        slug = `${base}-${n}`;
      }
      const now = new Date().toISOString();
      const res = this.db
        .prepare(
          `INSERT INTO proposals (slug, status, narrative_summary, tech_one_liner, why_now, name, ticker,
             description, evidence_links, created_at, updated_at)
           VALUES (?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          slug,
          input.narrativeSummary,
          input.techOneLiner,
          input.whyNow,
          input.name,
          input.ticker,
          input.description,
          JSON.stringify(evidenceLinks),
          now,
          now,
        );
      const newId = Number(res.lastInsertRowid);
      this.db
        .prepare(
          "INSERT INTO status_history (proposal_id, from_status, to_status, actor, reason, at) VALUES (?, NULL, 'new', 'system', 'Proposal created', ?)",
        )
        .run(newId, now);
      return newId;
    });
    return this.getProposal(id)!;
  }

  getProposal(id: number): Proposal | undefined {
    const row = this.db.prepare(`${PROPOSAL_SELECT} WHERE p.id = ?`).get(id) as unknown as Row | undefined;
    return row && toProposal(row);
  }

  listProposals(): Proposal[] {
    const rows = this.db.prepare(`${PROPOSAL_SELECT} ORDER BY p.id DESC`).all() as unknown as Row[];
    return rows.map(toProposal);
  }

  /** War Room entry point: records a command row. Never touches status. */
  enqueueCommand(proposalId: number, type: CommandType, reason = ""): Command {
    const res = this.db
      .prepare("INSERT INTO commands (proposal_id, type, reason, created_at) VALUES (?, ?, ?, ?)")
      .run(proposalId, type, reason, new Date().toISOString());
    return this.getCommand(Number(res.lastInsertRowid))!;
  }

  getCommand(id: number): Command | undefined {
    const row = this.db.prepare("SELECT * FROM commands WHERE id = ?").get(id) as unknown as CommandRow | undefined;
    return row && toCommand(row);
  }

  /** Most recent commands first. */
  listCommands(limit = 200): Command[] {
    const rows = this.db.prepare("SELECT * FROM commands ORDER BY id DESC LIMIT ?").all(limit) as unknown as CommandRow[];
    return rows.map(toCommand);
  }

  pendingCommands(): Command[] {
    const rows = this.db
      .prepare("SELECT * FROM commands WHERE status = 'pending' ORDER BY id")
      .all() as unknown as CommandRow[];
    return rows.map(toCommand);
  }

  historyFor(proposalId: number): HistoryEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM status_history WHERE proposal_id = ? ORDER BY id")
      .all(proposalId) as unknown as {
      id: number;
      proposal_id: number;
      from_status: ProposalStatus | null;
      to_status: ProposalStatus;
      actor: Actor;
      reason: string;
      at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      proposalId: r.proposal_id,
      from: r.from_status,
      to: r.to_status,
      actor: r.actor,
      reason: r.reason,
      at: r.at,
    }));
  }

  private txDepth = 0;

  private inTransaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.txDepth++;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  /**
   * WORKER ONLY (enforced by lifecycle.test.ts): the sole place status changes.
   * Validates against the transition table and records time, actor and reason.
   */
  transition(proposalId: number, to: ProposalStatus, actor: Actor, reason?: string): void {
    this.inTransaction(() => {
      const current = this.getProposal(proposalId);
      if (!current) throw new ProposalNotFoundError(proposalId);
      const t = assertTransition(current.status, to, actor);
      const now = new Date().toISOString();
      this.db.prepare("UPDATE proposals SET status = ?, updated_at = ? WHERE id = ?").run(to, now, proposalId);
      if (to === "approved") this.db.prepare("UPDATE proposals SET approved_at = ? WHERE id = ?").run(now, proposalId);
      this.db
        .prepare(
          "INSERT INTO status_history (proposal_id, from_status, to_status, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(proposalId, current.status, to, actor, reason?.trim() || t.reason, now);
    });
  }

  /** WORKER ONLY. Stores one brain run (success or not) against a Proposal. */
  recordBrainRun(run: NewBrainRun): void {
    this.db
      .prepare(
        `INSERT INTO brain_runs (proposal_id, task, backend, model, session_id, total_cost_usd, exit_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.proposalId,
        run.task,
        run.backend,
        run.model,
        run.sessionId,
        run.totalCostUsd,
        run.exitStatus,
        new Date().toISOString(),
      );
  }

  brainRunsFor(proposalId: number): BrainRunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM brain_runs WHERE proposal_id = ? ORDER BY id")
      .all(proposalId) as unknown as {
      id: number;
      proposal_id: number;
      task: string;
      backend: string;
      model: string;
      session_id: string | null;
      total_cost_usd: number;
      exit_status: string;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      proposalId: r.proposal_id,
      task: r.task,
      backend: r.backend,
      model: r.model,
      sessionId: r.session_id,
      totalCostUsd: r.total_cost_usd,
      exitStatus: r.exit_status,
      createdAt: r.created_at,
    }));
  }

  /**
   * WORKER ONLY. Opens a brain run before the child is spawned, so a crash leaves a row behind instead of
   * unrecorded spend. Returns its id; close it with finishBrainRun (or discardBrainRun for a dry run).
   */
  startBrainRun(run: Pick<NewBrainRun, "proposalId" | "task" | "backend" | "model">): number {
    const res = this.db
      .prepare(
        `INSERT INTO brain_runs (proposal_id, task, backend, model, session_id, total_cost_usd, exit_status, created_at)
         VALUES (?, ?, ?, ?, NULL, 0, ?, ?)`,
      )
      .run(run.proposalId, run.task, run.backend, run.model, BRAIN_RUN_IN_FLIGHT, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  /** WORKER ONLY. Records what a run cost and how it ended, as soon as the child is done. */
  finishBrainRun(id: number, done: { sessionId: string | null; totalCostUsd: number; exitStatus: string }): void {
    this.db
      .prepare("UPDATE brain_runs SET session_id = ?, total_cost_usd = ?, exit_status = ? WHERE id = ?")
      .run(done.sessionId, done.totalCostUsd, done.exitStatus, id);
  }

  /** WORKER ONLY. Removes a run that never spawned anything (`--dry-run`). */
  discardBrainRun(id: number): void {
    this.db.prepare("DELETE FROM brain_runs WHERE id = ? AND exit_status = ?").run(id, BRAIN_RUN_IN_FLIGHT);
  }

  /** The Proposal's open (`in-flight`) run for a task, if any. */
  openBrainRun(proposalId: number, task: string): BrainRunRecord | undefined {
    return this.brainRunsFor(proposalId).find((r) => r.task === task && r.exitStatus === BRAIN_RUN_IN_FLIGHT);
  }

  /**
   * WORKER ONLY, call at worker boot and on every tick. Marks each open run older than `staleAfterMs(its task)` as `interrupted` (its
   * spend is unknown and recorded as 0) and sets `specError` on a still-shortlisted Proposal whose Spec draft it was.
   * Nothing is retried: the failure shows on the card. `staleAfterMs` is the task's run timeout plus a grace
   * period: a live run is killed at its timeout, so a younger row may belong to a live worker (this process, or a
   * foreground `--once` run beside the daemon) and is left alone. Returns how many
   * runs were marked.
   */
  interruptStaleBrainRuns(staleAfterMs: (task: string) => number, now = new Date()): number {
    return this.inTransaction(() => {
      const rows = this.db
        .prepare("SELECT id, proposal_id, task, created_at FROM brain_runs WHERE exit_status = ?")
        .all(BRAIN_RUN_IN_FLIGHT) as unknown as { id: number; proposal_id: number; task: string; created_at: string }[];
      let n = 0;
      for (const r of rows) {
        if (new Date(r.created_at).getTime() >= now.getTime() - staleAfterMs(r.task)) continue;
        n++;
        this.db.prepare("UPDATE brain_runs SET exit_status = ? WHERE id = ?").run(BRAIN_RUN_INTERRUPTED, r.id);
        if (r.task === "spec-revise") {
          this.db
            .prepare("UPDATE proposals SET spec_error = ?, spec_revision = NULL WHERE id = ? AND status = 'spec-drafted'")
            .run(
              "Spec revision interrupted: the worker stopped during the brain run, so its spend is unknown. The Spec is unchanged; ask again.",
              r.proposal_id,
            );
        }
        if (r.task === "spec") {
          this.db
            .prepare("UPDATE proposals SET spec_error = ?, spec_retry_after = NULL WHERE id = ? AND status = 'shortlisted'")
            .run(
              "Spec draft interrupted: the worker stopped during the brain run, so its spend is unknown. Not retried automatically.",
              r.proposal_id,
            );
        }
      }
      return n;
    });
  }

  /**
   * WORKER ONLY. Stores the Spec path and hash and moves `shortlisted` -> `spec-drafted`, atomically. The brain run is
   * recorded separately (finishBrainRun), before this. Throws IllegalTransitionError if the Proposal moved on.
   */
  completeSpec(proposalId: number, spec: { path: string; hash: string }): void {
    this.inTransaction(() => {
      this.transition(proposalId, "spec-drafted", "system");
      this.db
        .prepare(
          "UPDATE proposals SET spec_path = ?, spec_hash = ?, spec_error = '', spec_retry_after = NULL, spec_attempts = 0 WHERE id = ?",
        )
        .run(spec.path, spec.hash, proposalId);
    });
  }

  /**
   * WORKER ONLY. Records a failed draft; the Proposal stays `shortlisted` with the error visible. A rate-limited
   * failure counts an attempt and schedules a retry `backoffMs` out until MAX_SPEC_RATE_LIMIT_ATTEMPTS, then gives up.
   */
  failSpec(proposalId: number, error: string, opts: { rateLimited?: boolean; backoffMs?: number } = {}): void {
    this.inTransaction(() => {
      const current = this.getProposal(proposalId);
      if (!current) throw new ProposalNotFoundError(proposalId);
      let message = error;
      let retryAfter: string | null = null;
      let attempts = current.specAttempts;
      if (opts.rateLimited) {
        attempts += 1;
        if (attempts < MAX_SPEC_RATE_LIMIT_ATTEMPTS) {
          retryAfter = new Date(Date.now() + (opts.backoffMs ?? 0)).toISOString();
          message = `${error} (attempt ${attempts}/${MAX_SPEC_RATE_LIMIT_ATTEMPTS}, will retry)`;
        } else {
          message = `${error} (gave up after ${attempts} rate-limited attempts)`;
        }
      }
      this.db
        .prepare("UPDATE proposals SET spec_error = ?, spec_retry_after = ?, spec_attempts = ? WHERE id = ?")
        .run(message, retryAfter, attempts, proposalId);
    });
  }

  /**
   * Replaces spec.md with `text` if, and only if, it is still the version the caller saw: the stored hash equals
   * `expectedHash` and so does the file's actual hash. Done under the write lock, so a worker revise and an Operator
   * save cannot both win. Used by the War Room save (the Spec is not status) and the worker's revise.
   * Returns the new hash. Throws SpecConflictError when the version moved, DomainError when the Proposal is not
   * `spec-drafted` or the text is empty.
   */
  saveSpec(proposalId: number, expectedHash: string, text: string, opts: { completesRevision?: boolean } = {}): string {
    if (!text.trim()) throw new DomainError("The Spec is empty");
    const body = text.endsWith("\n") ? text : text + "\n";
    return this.inTransaction(() => {
      const p = this.getProposal(proposalId);
      if (!p) throw new ProposalNotFoundError(proposalId);
      if (p.status !== "spec-drafted") throw new DomainError(`The Spec can only be edited in spec-drafted (Proposal is ${p.status})`);
      if (!p.specPath || !p.specHash) throw new DomainError("Proposal has no Spec");
      if (p.specHash !== expectedHash) throw new SpecConflictError();
      let onDisk: string;
      try {
        onDisk = readFileSync(p.specPath, "utf8");
      } catch {
        throw new SpecConflictError("spec.md is missing on disk; the Spec cannot be saved over it.");
      }
      if (sha256(onDisk) !== p.specHash) throw new SpecConflictError("spec.md was changed outside the War Room. Reload to see the current version.");
      const tmp = `${p.specPath}.${process.pid}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, p.specPath);
      const hash = sha256(body);
      this.db
        .prepare(
          `UPDATE proposals SET spec_hash = ?, updated_at = ?${opts.completesRevision ? ", spec_revision = NULL, spec_error = ''" : ""} WHERE id = ?`,
        )
        .run(hash, new Date().toISOString(), proposalId);
      return hash;
    });
  }

  /** WORKER ONLY. Queues the Operator's revise instruction for the next worker pass. */
  queueRevision(proposalId: number, instruction: string): void {
    this.db.prepare("UPDATE proposals SET spec_revision = ?, spec_error = '' WHERE id = ?").run(instruction, proposalId);
  }

  /** WORKER ONLY. A revision that did not produce a Spec: shows the error, clears the queue, leaves spec.md alone. */
  failRevision(proposalId: number, error: string): void {
    this.db.prepare("UPDATE proposals SET spec_error = ?, spec_revision = NULL WHERE id = ?").run(error, proposalId);
  }

  /** The session of the Proposal's newest successful Spec run (draft or revise), the one a revise resumes. */
  latestSpecSession(proposalId: number): string | undefined {
    return this.brainRunsFor(proposalId)
      .filter((r) => (r.task === "spec" || r.task === "spec-revise") && r.exitStatus === "success" && r.sessionId)
      .at(-1)?.sessionId ?? undefined;
  }

  /**
   * WORKER ONLY. Runs `apply` for a pending command and marks it applied, or rejected when `apply`
   * throws a DomainError. Any other error rolls the command's writes back, records the attempt and
   * the error (`error`), and is rethrown. After MAX_COMMAND_ATTEMPTS such failures the command is
   * marked `failed` and never retried.
   */
  resolveCommand(id: number, apply: () => void): void {
    let failure: { error: unknown } | undefined;
    this.inTransaction(() => {
      const c = this.getCommand(id);
      if (!c || c.status !== "pending") return;
      const now = new Date().toISOString();
      this.db.exec("SAVEPOINT cmd");
      try {
        apply();
      } catch (e) {
        this.db.exec("ROLLBACK TO cmd");
        this.db.exec("RELEASE cmd");
        if (e instanceof DomainError) {
          this.db.prepare("UPDATE commands SET status = 'rejected', error = ?, applied_at = ? WHERE id = ?").run(e.message, now, id);
          return;
        }
        const attempts = c.attempts + 1;
        const message = e instanceof Error ? e.message : String(e);
        if (attempts >= MAX_COMMAND_ATTEMPTS) {
          this.db
            .prepare("UPDATE commands SET status = 'failed', attempts = ?, error = ?, applied_at = ? WHERE id = ?")
            .run(attempts, message, now, id);
        } else {
          this.db.prepare("UPDATE commands SET attempts = ?, error = ? WHERE id = ?").run(attempts, message, id);
        }
        failure = { error: e };
        return;
      }
      this.db.exec("RELEASE cmd");
      this.db.prepare("UPDATE commands SET status = 'applied', applied_at = ? WHERE id = ?").run(now, id);
    });
    if (failure) throw failure.error;
  }
}

interface CommandRow {
  id: number;
  proposal_id: number;
  type: CommandType;
  reason: string;
  status: Command["status"];
  error: string;
  attempts: number;
  created_at: string;
  applied_at: string | null;
}

function toCommand(r: CommandRow): Command {
  return {
    id: r.id,
    proposalId: r.proposal_id,
    type: r.type,
    reason: r.reason,
    status: r.status,
    error: r.error,
    attempts: r.attempts,
    createdAt: r.created_at,
    appliedAt: r.applied_at,
  };
}
