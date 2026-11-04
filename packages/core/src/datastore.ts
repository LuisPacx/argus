import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeEvidenceLinks } from "./evidence-links.ts";
import {
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
  agentCostUsd: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewProposal {
  narrativeSummary: string;
  techOneLiner: string;
  whyNow: string;
  name: string;
  ticker: string;
  description: string;
  evidenceLinks: string[];
}

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
  agent_cost_usd: number;
  created_at: string;
  updated_at: string;
}

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
    agentCostUsd: r.agent_cost_usd,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class Datastore {
  private constructor(private readonly db: DatabaseSync) {}

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

  /** Inserts a Proposal with status `new`. Not a status transition. */
  createProposal(input: NewProposal): Proposal {
    const evidenceLinks = normalizeEvidenceLinks(input.evidenceLinks);
    const base = slugify(input.name) || "proposal";
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
    const id = Number(res.lastInsertRowid);
    this.db
      .prepare(
        "INSERT INTO status_history (proposal_id, from_status, to_status, actor, reason, at) VALUES (?, NULL, 'new', 'system', 'Proposal created', ?)",
      )
      .run(id, now);
    return this.getProposal(id)!;
  }

  getProposal(id: number): Proposal | undefined {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as unknown as Row | undefined;
    return row && toProposal(row);
  }

  listProposals(): Proposal[] {
    const rows = this.db.prepare("SELECT * FROM proposals ORDER BY id DESC").all() as unknown as Row[];
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
      if (!current) throw new Error(`Proposal ${proposalId} not found`);
      const t = assertTransition(current.status, to, actor);
      const now = new Date().toISOString();
      this.db.prepare("UPDATE proposals SET status = ?, updated_at = ? WHERE id = ?").run(to, now, proposalId);
      this.db
        .prepare(
          "INSERT INTO status_history (proposal_id, from_status, to_status, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(proposalId, current.status, to, actor, reason?.trim() || t.reason, now);
    });
  }

  /** WORKER ONLY. Runs `apply` for a pending command and marks it applied, or rejected with the error. */
  resolveCommand(id: number, apply: () => void): void {
    this.inTransaction(() => {
      const c = this.getCommand(id);
      if (!c || c.status !== "pending") return;
      const now = new Date().toISOString();
      try {
        this.db.exec("SAVEPOINT cmd");
        apply();
        this.db.exec("RELEASE cmd");
        this.db.prepare("UPDATE commands SET status = 'applied', applied_at = ? WHERE id = ?").run(now, id);
      } catch (e) {
        this.db.exec("ROLLBACK TO cmd");
        this.db.exec("RELEASE cmd");
        const error = e instanceof Error ? e.message : String(e);
        this.db.prepare("UPDATE commands SET status = 'rejected', error = ?, applied_at = ? WHERE id = ?").run(error, now, id);
      }
    });
  }
}

interface CommandRow {
  id: number;
  proposal_id: number;
  type: CommandType;
  reason: string;
  status: Command["status"];
  error: string;
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
    createdAt: r.created_at,
    appliedAt: r.applied_at,
  };
}
