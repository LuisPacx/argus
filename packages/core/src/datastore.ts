import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeEvidenceLinks } from "./evidence-links.ts";

export type ProposalStatus =
  | "new"
  | "shortlisted"
  | "spec-drafted"
  | "approved"
  | "building"
  | "built"
  | "build-failed"
  | "needs-human"
  | "launched"
  | "closed"
  | "dismissed";

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
    return this.getProposal(Number(res.lastInsertRowid))!;
  }

  getProposal(id: number): Proposal | undefined {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as unknown as Row | undefined;
    return row && toProposal(row);
  }

  listProposals(): Proposal[] {
    const rows = this.db.prepare("SELECT * FROM proposals ORDER BY id DESC").all() as unknown as Row[];
    return rows.map(toProposal);
  }
}
