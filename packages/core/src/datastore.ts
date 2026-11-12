import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BuildRefusal, BuildRefusalCode, PreflightRefusal } from "./build-refusal.ts";
import type { CollisionResult, CollisionStatus } from "./collision.ts";
import { expiresAtFor } from "./expiry.ts";
import { normalizeEvidenceLinks } from "./evidence-links.ts";
import type { Signal } from "./sources/source.ts";
import { MARKET_SOURCE_IDS, type SourceClass } from "./sources/source-class.ts";
import { MetaStore, migrateMeta, type MetaRun } from "./meta/store.ts";
import type { MetaWindow } from "./meta/config.ts";
import { StudyStore, migrateStudy, type StudyStats } from "./study/store.ts";
import { isMaterialJoin } from "./narratives.ts";
import {
  type DimensionScores,
  type Rubric,
  type RubricInput,
  type RubricRow,
  RubricConflictError,
  migrateRubric,
  toRubric,
  validateRubricInput,
} from "./rubric.ts";
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
  /** The propose model's one-line rationale for this Proposal; empty for hand-entered Proposals and rows from before the column. */
  reason: string;
  /** What the visitor does in the Tech; empty for hand-entered Proposals and rows from before the column. */
  interaction: string;
  name: string;
  ticker: string;
  description: string;
  evidenceLinks: string[];
  /** Sum of `total_cost_usd` over the Proposal's subscription brain runs: Est. usage, not a charge. */
  agentCostUsd: number;
  /** Real dollars its ApiBrain runs cost (backend `api`); kept apart from Est. usage. */
  apiCostUsd: number;
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
  /** The workers.dev preview, set when the Build reaches `built`; null before. */
  previewUrl: string | null;
  /** The mint the Operator recorded when marking the Proposal launched; null before. argus never reads it from a chain. */
  mint: string | null;
  /** The Claude session of the Proposal's latest Build run that has one; what `claude --resume` continues after a `build-failed`. */
  buildSessionId: string | null;
  /** Whether the latest Build deployed the Proposal's Worker to Cloudflare (a leftover the Operator removes before a re-queue). */
  workerDeployed: boolean;
  /** `owner/slug` of the private GitHub repo this Build created (recorded at `gh repo create`); null for a Build from before it was recorded, or none created. */
  buildRepo: string | null;
  /** Whether "Clean up build" last found nothing of the Build's artifacts left to remove. A fresh Build resets it. */
  buildCleaned: boolean;
  /** When the Proposal goes stale and closes (ISO); null for a state that never expires. Counted from the last change (`updatedAt`). */
  expiresAt: string | null;
  /** The Narrative the propose pass made this Proposal from; null for a hand-entered one. A Narrative has at most one Proposal. */
  narrativeId: number | null;
  /** The Score that passed the gate when it was proposed (the card shows the Narrative's latest, see `latestScore`). */
  scoreId: number | null;
  /** When that Narrative started: the card's Narrative age counts from it. */
  narrativeCreatedAt: string | null;
  /** The collision checks run when it was proposed (DexScreener, GitHub); null when it was never checked (a hand-entered Proposal). */
  collisions: CollisionResult | null;
  createdAt: string;
  updatedAt: string;
}

export type ProposalSort = "score" | "newest" | "changed" | "usage";

/** Filters and sort for `queryProposals`; every field is optional. */
export interface ProposalQuery {
  sort?: ProposalSort;
  status?: ProposalStatus;
  /** A Proposal collides when either check collides, is clear only when both are, and is unknown otherwise (also when never checked). */
  collision?: CollisionStatus;
  /** ISO time: only Proposals created at or after it. */
  createdSince?: string;
  limit?: number;
}

export interface BrainRunRecord {
  id: number;
  /** The Proposal the run was for; 0 for a judge run, which is for a Narrative (see `narrativeId`) and no Proposal yet. */
  proposalId: number;
  /** The Narrative a judge run scored; null for every other task. */
  narrativeId: number | null;
  task: string;
  backend: string;
  model: string;
  sessionId: string | null;
  totalCostUsd: number;
  exitStatus: string;
  createdAt: string;
  /** Last time the process running it said it was alive (see touchBrainRun); null if it never did. */
  heartbeatAt: string | null;
}

/** One Source's health for the War Room Activity page. */
export interface SourceHealth {
  sourceId: string;
  label: string;
  /** Null for a Source that has Signals but no poll row (stored before polls were recorded). */
  lastPolledAt: string | null;
  lastOkAt: string | null;
  /** The last failure's message; null after a later success. */
  lastError: string | null;
  lastErrorAt: string | null;
  /** Signals first seen in the rolling 24 h. */
  signals24h: number;
}

/** One judge or propose run for the Activity page. */
export interface BrainRunSummary {
  id: number;
  task: string;
  /** The row's `exit_status`: `in-flight`, `interrupted`, `success`, ... */
  status: string;
  backend: string;
  model: string;
  narrativeId: number | null;
  proposalId: number;
  estCostUsd: number;
  /** `api` runs report real dollars, every other backend an estimate. */
  costKind: "est" | "api";
  startedAt: string;
  finishedAt: string | null;
  /** Whole seconds from start to finish; null while open and for rows from before `finished_at` existed. */
  durationSec: number | null;
}

/** Messages are stored short and without URL credentials, query strings or fragments, which can carry tokens. */
const POLL_ERROR_CHARS = 300;
const cleanPollError = (message: string): string =>
  message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, "$1")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, "$1")
    .replace(/\/bot[^\s/]+/gi, "/bot***")
    .replace(/\bbearer\s+\S+/gi, "Bearer ***")
    .replace(/\b(token|key|api_?key|access_token|secret|password)=[^\s&]+/gi, "$1=***")
    .slice(0, POLL_ERROR_CHARS);

export type NewBrainRun = Omit<BrainRunRecord, "id" | "createdAt" | "heartbeatAt" | "narrativeId">;

/** `brain_runs.exit_status` while the child is running; a crash leaves it behind, see interruptStaleBrainRuns. */
export const BRAIN_RUN_IN_FLIGHT = "in-flight";
export const BRAIN_RUN_INTERRUPTED = "interrupted";

/**
 * How long a "Clean up build" claim on a Proposal holds if the worker that took it never lets go (it died mid-clean-up). A clean-up is
 * three calls bounded by 30 s each plus a directory removal, so this is far more than one takes.
 */
export const CLEANUP_CLAIM_TTL_MS = 10 * 60_000;

/**
 * SQL for "this Narrative holds at least one market Signal" (ticket 24, the Source class table is the only list). Built from constants
 * in source-class.ts, never from input. `n` is the Narrative alias of the query it is placed in.
 */
const HAS_MARKET_SIGNAL = `EXISTS (SELECT 1 FROM signals sg WHERE sg.narrative_id = n.id AND sg.source_id IN (${MARKET_SOURCE_IDS.map((id) => `'${id.replaceAll("'", "''")}'`).join(", ")}))`;

export interface NewProposal {
  narrativeSummary: string;
  techOneLiner: string;
  whyNow: string;
  name: string;
  ticker: string;
  description: string;
  evidenceLinks: string[];
  /** The propose model's one-line "why this Proposal" (which Signals/Narrative, why this Tech). Absent on hand-entered Proposals. */
  reason?: string;
  /** What the visitor does in the Tech (one line from the propose model). Absent on hand-entered Proposals. */
  interaction?: string;
}

/** Per-task per-run spend ceilings (the route's `--max-budget-usd`), used to charge runs that never reported a cost. */
export type RunCaps = Partial<Record<string, number>>;

/** Runs started in a window, the cost they reported, and what they are charged against a budget (never less than the reported cost). */
export interface Spend {
  runs: number;
  costUsd: number;
  chargedUsd: number;
}

/** A Proposal made by the propose pass: the fields plus the Narrative and Score it came from. */
export interface NewResearchProposal extends NewProposal {
  narrativeId: number;
  scoreId: number;
  /** What the collision checks found for its name, ticker and repo name; stored with the Proposal. */
  collisions?: CollisionResult;
}

/**
 * The hard cap on new research Proposals in any rolling 24 hours (architecture section 2). `createResearchProposal` enforces it
 * itself, so no caller can exceed it; config can only lower it.
 */
export const MAX_NEW_PROPOSALS_PER_DAY = 30;

export class ProposalCapReachedError extends DomainError {
  constructor(max: number) {
    super(`The daily cap of ${max} new Proposals is reached`);
    this.name = "ProposalCapReachedError";
  }
}

export class NarrativeAlreadyProposedError extends DomainError {
  constructor(narrativeId: number) {
    super(`Narrative ${narrativeId} already has a Proposal`);
    this.name = "NarrativeAlreadyProposedError";
  }
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
  ensureColumn(db, "proposals", "reason", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "proposals", "interaction", "TEXT NOT NULL DEFAULT ''");
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
  ensureColumn(db, "brain_runs", "heartbeat_at", "TEXT");
  // When the run ended (ISO); null while open and for rows from before this column (their duration is unknown, no backfill).
  ensureColumn(db, "brain_runs", "finished_at", "TEXT");
  // One row per ingest Source, upserted after every poll (phase 2 ticket 16): the War Room's per-Source health.
  db.exec(`CREATE TABLE IF NOT EXISTS source_polls (
    source_id TEXT PRIMARY KEY,
    source_label TEXT,
    last_polled_at TEXT NOT NULL,
    last_ok_at TEXT,
    last_error TEXT,
    last_error_at TEXT
  )`);
  ensureColumn(db, "proposals", "spec_path", "TEXT");
  ensureColumn(db, "proposals", "spec_hash", "TEXT");
  ensureColumn(db, "proposals", "spec_error", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "proposals", "spec_retry_after", "TEXT");
  ensureColumn(db, "proposals", "spec_attempts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "proposals", "spec_revision", "TEXT");
  ensureColumn(db, "proposals", "approved_at", "TEXT");
  ensureColumn(db, "commands", "attempts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "proposals", "preview_url", "TEXT");
  ensureColumn(db, "proposals", "worker_deployed", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "proposals", "mint", "TEXT");
  ensureColumn(db, "proposals", "build_repo", "TEXT");
  ensureColumn(db, "proposals", "build_cleaned", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "proposals", "cleanup_claimed_at", "TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS proposals_mint ON proposals(mint) WHERE mint IS NOT NULL");
  migrateRubric(db);
  // Signals (phase 2 ticket 01): additive and idempotent. `id` is the Source's stable per-item id, so a re-poll cannot duplicate.
  db.exec(`CREATE TABLE IF NOT EXISTS signals (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    source_label TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    url TEXT NOT NULL,
    published_at TEXT NOT NULL,
    ingested_at TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS signals_published_at ON signals (published_at DESC)");
  // Narratives (phase 2 ticket 05). A Signal's `narrative_id` is a single column, so it is in at most one Narrative; null = not clustered yet.
  db.exec(`CREATE TABLE IF NOT EXISTS narratives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    centroid TEXT NOT NULL,
    signal_count INTEGER NOT NULL,
    material_signal_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    last_signal_at TEXT NOT NULL,
    changed_materially_at TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS narratives_last_signal_at ON narratives (last_signal_at)");
  // Which embedder built the centroid (ticket 05c). Rows from before this column are the lexical HashingEmbedder's, hence the defaults.
  // Centroids of different embedders are never compared: clustering only joins Narratives of its own embedder.
  ensureColumn(db, "narratives", "embedder", "TEXT NOT NULL DEFAULT 'hashing-v1'");
  ensureColumn(db, "narratives", "dimension", "INTEGER NOT NULL DEFAULT 256");
  ensureColumn(db, "signals", "narrative_id", "INTEGER");
  db.exec("CREATE INDEX IF NOT EXISTS signals_narrative_id ON signals (narrative_id)");
  db.exec("CREATE INDEX IF NOT EXISTS signals_source_ingested ON signals (source_id, ingested_at)");
  // Scores (ticket 07): one row per judge result, never updated or deleted, so a Narrative's Score history is complete. `rubric_version`
  // names the immutable Rubric version it was computed with; `changed_materially_at` is the Narrative's value when the judge read it
  // (the delta compares against it). A judge run has no Proposal: its brain_runs row has proposal_id 0 and this column.
  ensureColumn(db, "brain_runs", "narrative_id", "INTEGER");
  db.exec(`CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    narrative_id INTEGER NOT NULL,
    rubric_version INTEGER NOT NULL,
    scores TEXT NOT NULL,
    total REAL NOT NULL,
    rationale TEXT NOT NULL,
    signal_count INTEGER NOT NULL,
    changed_materially_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS scores_narrative_id ON scores (narrative_id, id)");
  db.exec("CREATE INDEX IF NOT EXISTS brain_runs_narrative_id ON brain_runs (narrative_id)");
  // Proposals whose Telegram card has been queued (phase 2 ticket 11): one row each, so a restart never announces twice.
  // Proposals that exist when the table is first created count as announced, so turning notifications on does not flood the chat.
  const hadAnnounced = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'telegram_announced'").get();
  // The latest reason a Build was not started, one row per approved Proposal (an upsert, never a log): see build-refusal.ts.
  db.exec("CREATE TABLE IF NOT EXISTS build_refusals (proposal_id INTEGER PRIMARY KEY, code TEXT NOT NULL, message TEXT NOT NULL, at TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS telegram_announced (proposal_id INTEGER PRIMARY KEY, at TEXT NOT NULL)");
  if (!hadAnnounced) db.prepare("INSERT OR IGNORE INTO telegram_announced (proposal_id, at) SELECT id, ? FROM proposals").run(new Date().toISOString());
  // Proposals from the propose pass (ticket 08) name their Narrative and Score; hand-entered ones leave both null. The unique index is
  // what makes "each Narrative at most once" true whatever the caller does.
  ensureColumn(db, "proposals", "narrative_id", "INTEGER");
  ensureColumn(db, "proposals", "score_id", "INTEGER");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS proposals_narrative_id ON proposals (narrative_id) WHERE narrative_id IS NOT NULL");
  // Collision results (ticket 09): JSON of { dex, github }, each with status, detail, source and check time; NULL means never checked.
  ensureColumn(db, "proposals", "collision_checks", "TEXT");
  // The Study (phase 3 ticket 02): additive tables for tokens seen, capture runs, gap markers and frozen Snapshots.
  migrateStudy(db);
  // Meta runs and ranked rows (viral sources ticket 03): additive tables, nothing existing is altered.
  migrateMeta(db);
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
  reason: string;
  interaction: string;
  name: string;
  ticker: string;
  description: string;
  evidence_links: string;
  cost_usd: number;
  api_cost_usd: number;
  spec_path: string | null;
  spec_hash: string | null;
  spec_error: string;
  spec_retry_after: string | null;
  spec_attempts: number;
  in_flight_since: string | null;
  spec_revision: string | null;
  approved_at: string | null;
  preview_url: string | null;
  mint: string | null;
  build_session_id: string | null;
  worker_deployed: number;
  build_repo: string | null;
  build_cleaned: number;
  narrative_id: number | null;
  score_id: number | null;
  narrative_created_at: string | null;
  collision_checks: string | null;
  /** When the latest transition into the current status happened; null only for a row with no history. */
  status_since: string | null;
  created_at: string;
  updated_at: string;
}

const PROPOSAL_SELECT = `SELECT p.*, (SELECT MAX(at) FROM status_history h WHERE h.proposal_id = p.id AND h.to_status = p.status) AS status_since,(SELECT created_at FROM narratives n WHERE n.id = p.narrative_id) AS narrative_created_at,(SELECT COALESCE(SUM(total_cost_usd), 0) FROM brain_runs b WHERE b.proposal_id = p.id AND b.backend != 'api') AS cost_usd, (SELECT COALESCE(SUM(total_cost_usd), 0) FROM brain_runs b WHERE b.proposal_id = p.id AND b.backend = 'api') AS api_cost_usd, (SELECT MIN(created_at) FROM brain_runs b WHERE b.proposal_id = p.id AND b.exit_status = '${BRAIN_RUN_IN_FLIGHT}') AS in_flight_since, (SELECT session_id FROM brain_runs b WHERE b.proposal_id = p.id AND b.task = 'build' AND b.session_id IS NOT NULL ORDER BY b.id DESC LIMIT 1) AS build_session_id FROM proposals p`;

function toProposal(r: Row): Proposal {
  return {
    id: r.id,
    slug: r.slug,
    status: r.status,
    narrativeSummary: r.narrative_summary,
    techOneLiner: r.tech_one_liner,
    whyNow: r.why_now,
    reason: r.reason,
    interaction: r.interaction,
    name: r.name,
    ticker: r.ticker,
    description: r.description,
    evidenceLinks: JSON.parse(r.evidence_links) as string[],
    agentCostUsd: r.cost_usd,
    apiCostUsd: r.api_cost_usd,
    specPath: r.spec_path,
    specHash: r.spec_hash,
    specError: r.spec_error,
    specRetryAfter: r.spec_retry_after,
    specAttempts: r.spec_attempts,
    brainRunInFlightSince: r.in_flight_since,
    specRevision: r.spec_revision,
    approvedAt: r.approved_at,
    previewUrl: r.preview_url,
    mint: r.mint,
    buildSessionId: r.build_session_id,
    workerDeployed: r.worker_deployed === 1,
    buildRepo: r.build_repo,
    buildCleaned: r.build_cleaned === 1,
    // `new` counts from creation: Undo shortlist returns a Proposal to `new` and must not restart its 48 h. `shortlisted` counts from
    // the latest shortlist (a re-shortlist after an undo is a new decision and gets its own 7 days).
    expiresAt: expiresAtFor(r.status, r.status === "new" ? r.created_at : (r.status_since ?? r.updated_at)),
    narrativeId: r.narrative_id,
    scoreId: r.score_id,
    narrativeCreatedAt: r.narrative_created_at,
    collisions: r.collision_checks === null ? null : (JSON.parse(r.collision_checks) as CollisionResult),
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
  | "proposalIdWithMint"
  | "listProposals"
  | "queryProposals"
  | "getCommand"
  | "listCommands"
  | "pendingCommands"
  | "historyFor"
  | "enqueueCommand"
  | "createProposal"
  | "saveSpec"
  | "getRubric"
  | "saveRubric"
  | "listRubricVersions"
  | "latestScore"
  | "researchSpendSince"
  | "apiSpendSince"
  | "brainRunsFor"
  | "judgeRunsFor"
  | "researchProposalsSince"
  | "latestSignals"
  | "listNarratives"
  | "queryNarratives"
  | "getNarrative"
  | "sourceHealth"
  | "newestNarratives"
  | "recentBrainRuns"
  | "studyStats"
  | "latestMetas"
  | "buildRefusalFor"
>;

/** A stored Signal: the Source's item plus when argus first saw it. */
export interface StoredSignal extends Signal {
  ingestedAt: string;
}

/** A cluster of recent Signals that share a subject (GLOSSARY: Narrative). */
export interface Narrative {
  id: number;
  /** The first Signal's title: line one of the two-line summary. */
  title: string;
  /** The first Signal's summary, shortened: line two. May be empty. */
  summary: string;
  signalCount: number;
  createdAt: string;
  lastSignalAt: string;
  /** When the Narrative last changed materially (see `isMaterialJoin`): the input for the judge delta. */
  changedMateriallyAt: string;
}

export type NarrativeSort = "score" | "newest" | "signals" | "active";

/** Filters and sort for `queryNarratives`; every field is optional. */
export interface NarrativeQuery {
  sort?: NarrativeSort;
  scored?: boolean;
  hasProposal?: boolean;
  sourceId?: string;
  /** ISO time: only Narratives that gained a Signal at or after it. */
  activeSince?: string;
  limit?: number;
}

/** A Narrative as the War Room list shows it: its latest Score total and whether a Proposal exists for it. */
export interface NarrativeListItem extends Narrative {
  score: number | null;
  hasProposal: boolean;
  /** `market` when the Narrative holds at least one market Signal (it can be judged and proposed), else `context` (ticket 24). */
  sourceClass: SourceClass;
}

/** One judge result for a Narrative (GLOSSARY: Score). Stored for every judge run that produced a valid answer. */
export interface Score {
  id: number;
  narrativeId: number;
  /** The Rubric version the Score was computed with (versions are immutable). */
  rubricVersion: number;
  scores: DimensionScores;
  /** Weight-averaged under that Rubric version, 0 to 10. */
  total: number;
  rationale: string;
  /** How many Signals the Narrative had when it was judged. */
  signalCount: number;
  /** The Narrative's `changedMateriallyAt` when it was judged: what the judge delta compares against. */
  changedMateriallyAt: string;
  createdAt: string;
}

export type NewScore = Omit<Score, "id">;

export interface NarrativeDetail extends Narrative {
  /** Newest first. */
  signals: StoredSignal[];
  /** Score history, newest first. */
  scores: Score[];
}

/** Names the embedder and vector length that built a Narrative's centroid. */
export interface NarrativeEmbedder {
  id: string;
  dimension: number;
}

/** What clustering needs of a Narrative that can still be joined. */
export interface NarrativeCandidate {
  id: number;
  centroid: number[];
  signalCount: number;
}

interface NarrativeRow {
  id: number;
  title: string;
  summary: string;
  signal_count: number;
  created_at: string;
  last_signal_at: string;
  changed_materially_at: string;
}

const toNarrative = (r: NarrativeRow): Narrative => ({
  id: r.id,
  title: r.title,
  summary: r.summary,
  signalCount: r.signal_count,
  createdAt: r.created_at,
  lastSignalAt: r.last_signal_at,
  changedMateriallyAt: r.changed_materially_at,
});

const toStoredSignal = (r: SignalRow): StoredSignal => ({
  id: r.id,
  sourceId: r.source_id,
  sourceLabel: r.source_label,
  title: r.title,
  summary: r.summary,
  url: r.url,
  publishedAt: r.published_at,
  ingestedAt: r.ingested_at,
});

interface BrainRunRow {
  id: number;
  proposal_id: number;
  narrative_id: number | null;
  task: string;
  backend: string;
  model: string;
  session_id: string | null;
  total_cost_usd: number;
  exit_status: string;
  created_at: string;
  heartbeat_at: string | null;
  finished_at: string | null;
}

const toBrainRun = (r: BrainRunRow): BrainRunRecord => ({
  id: r.id,
  proposalId: r.proposal_id,
  narrativeId: r.narrative_id,
  task: r.task,
  backend: r.backend,
  model: r.model,
  sessionId: r.session_id,
  totalCostUsd: r.total_cost_usd,
  exitStatus: r.exit_status,
  createdAt: r.created_at,
  heartbeatAt: r.heartbeat_at,
});

interface ScoreRow {
  id: number;
  narrative_id: number;
  rubric_version: number;
  scores: string;
  total: number;
  rationale: string;
  signal_count: number;
  changed_materially_at: string;
  created_at: string;
}

const toScore = (r: ScoreRow): Score => ({
  id: r.id,
  narrativeId: r.narrative_id,
  rubricVersion: r.rubric_version,
  scores: JSON.parse(r.scores) as DimensionScores,
  total: r.total,
  rationale: r.rationale,
  signalCount: r.signal_count,
  changedMateriallyAt: r.changed_materially_at,
  createdAt: r.created_at,
});

const NARRATIVE_SUMMARY_CHARS = 200;

interface SignalRow {
  id: string;
  source_id: string;
  source_label: string;
  title: string;
  summary: string;
  url: string;
  published_at: string;
  ingested_at: string;
}

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
  /** The Study's tables (phase 3). The worker writes through this; the War Room reads only `studyStats`. */
  readonly study: StudyStore;
  /** The Meta ranking's tables (viral sources ticket 03). The worker writes through this; readers use `latestMetas`. */
  readonly meta: MetaStore;

  private constructor(db: DatabaseSync) {
    this.db = db;
    this.study = new StudyStore(db);
    this.meta = new MetaStore(db);
  }

  /** The newest Meta ranking run's top `limit` rows for a window; undefined before the first run. */
  latestMetas(window: MetaWindow, limit: number): MetaRun | undefined {
    return this.meta.latest(window, limit);
  }

  /** The Study page's health numbers (see StudyStats); `since` (ISO) limits them to tokens first seen at or after it. */
  studyStats(now: Date = new Date(), since?: string, captureRunCap?: number): StudyStats {
    return this.study.stats(now, since, captureRunCap);
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
    return this.insertProposal(input, new Date(), "Proposal created");
  }

  /**
   * WORKER ONLY, and the one way the propose pass makes a Proposal (a notifier hooks in after it, see `proposePendingNarratives`).
   * Same row and history entry as `createProposal` (status `new`, actor `system`, `updated_at` = now, which Proposal expiry counts
   * from), linked to its Narrative and Score. The two limits are checked in the same transaction as the insert, so they hold under
   * any caller: a Narrative gets one Proposal for good (even if it was dismissed), and at most `MAX_NEW_PROPOSALS_PER_DAY` research
   * Proposals are created in any rolling 24 hours. `maxPerDay` can lower that cap, never raise it. Hand-entered Proposals are not counted.
   */
  createResearchProposal(input: NewResearchProposal, opts: { now?: Date; maxPerDay?: number; attachRunId?: number | number[] } = {}): Proposal {
    const now = opts.now ?? new Date();
    const max = Math.min(MAX_NEW_PROPOSALS_PER_DAY, opts.maxPerDay ?? MAX_NEW_PROPOSALS_PER_DAY);
    return this.inTransaction(() => {
      if (this.db.prepare("SELECT 1 FROM proposals WHERE narrative_id = ?").get(input.narrativeId)) throw new NarrativeAlreadyProposedError(input.narrativeId);
      if (this.researchProposalsSince(new Date(now.getTime() - 24 * 3_600_000).toISOString()) >= max) throw new ProposalCapReachedError(max);
      const p = this.insertProposal(input, now, `Proposed from Narrative ${input.narrativeId} (Score ${input.scoreId})`, input);
      // The propose run that made it was recorded against no Proposal (it had none yet); from here its cost is the Proposal's.
      // A retried name has two (the first answer's and the retry's).
      for (const runId of [opts.attachRunId ?? []].flat()) this.db.prepare("UPDATE brain_runs SET proposal_id = ? WHERE id = ? AND proposal_id = 0").run(p.id, runId);
      return this.getProposal(p.id)!;
    });
  }

  private insertProposal(input: NewProposal, nowDate: Date, reason: string, link?: { narrativeId: number; scoreId: number; collisions?: CollisionResult }): Proposal {
    const evidenceLinks = normalizeEvidenceLinks(input.evidenceLinks);
    const base = slugify(input.name) || "proposal";
    const id = this.inTransaction(() => {
      let slug = base;
      for (let n = 2; this.db.prepare("SELECT 1 FROM proposals WHERE slug = ?").get(slug); n++) {
        slug = `${base}-${n}`;
      }
      const now = nowDate.toISOString();
      const res = this.db
        .prepare(
          `INSERT INTO proposals (slug, status, narrative_summary, tech_one_liner, why_now, name, ticker,
             description, evidence_links, narrative_id, score_id, collision_checks, reason, interaction, created_at, updated_at)
           VALUES (?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          link?.narrativeId ?? null,
          link?.scoreId ?? null,
          link?.collisions ? JSON.stringify(link.collisions) : null,
          input.reason ?? "",
          input.interaction ?? "",
          now,
          now,
        );
      const newId = Number(res.lastInsertRowid);
      this.db
        .prepare("INSERT INTO status_history (proposal_id, from_status, to_status, actor, reason, at) VALUES (?, NULL, 'new', 'system', ?, ?)")
        .run(newId, reason, now);
      return newId;
    });
    return this.getProposal(id)!;
  }

  /** How many research Proposals (made from a Narrative) were created at or after `since` (ISO), whatever became of them. */
  researchProposalsSince(since: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE narrative_id IS NOT NULL AND created_at >= ?").get(since) as unknown as { n: number };
    return row.n;
  }

  getProposal(id: number): Proposal | undefined {
    const row = this.db.prepare(`${PROPOSAL_SELECT} WHERE p.id = ?`).get(id) as unknown as Row | undefined;
    return row && toProposal(row);
  }

  /** Proposals still `new` whose Telegram card has not been queued, oldest first. */
  unannouncedNewProposals(): Proposal[] {
    const rows = this.db
      .prepare(`${PROPOSAL_SELECT} WHERE p.status = 'new' AND p.id NOT IN (SELECT proposal_id FROM telegram_announced) ORDER BY p.id`)
      .all() as unknown as Row[];
    return rows.map(toProposal);
  }

  markAnnounced(proposalId: number): void {
    this.db.prepare("INSERT OR IGNORE INTO telegram_announced (proposal_id, at) VALUES (?, ?)").run(proposalId, new Date().toISOString());
  }

  listProposals(): Proposal[] {
    const rows = this.db.prepare(`${PROPOSAL_SELECT} ORDER BY p.id DESC`).all() as unknown as Row[];
    return rows.map(toProposal);
  }

  /**
   * The Proposals list the War Room shows, filtered and sorted in SQL so a `limit` (none by default) cuts the right rows. Sorts:
   * `score` (default: the Narrative's latest Score total, highest first, Proposals with none last, then newest), `newest` (by
   * creation), `changed` (last update), `usage` (Est. usage, highest first). Filters: `status`, `collision`, `createdSince`.
   */
  queryProposals(q: ProposalQuery = {}): Proposal[] {
    const dex = "COALESCE(json_extract(p.collision_checks, '$.dex.status'), '')";
    const github = "COALESCE(json_extract(p.collision_checks, '$.github.status'), '')";
    const collides = `(${dex} = 'collides' OR ${github} = 'collides')`;
    const clear = `(${dex} = 'clear' AND ${github} = 'clear')`;
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (q.status !== undefined) {
      where.push("p.status = ?");
      params.push(q.status);
    }
    if (q.collision !== undefined) where.push({ collides, clear, unknown: `NOT ${collides} AND NOT ${clear}` }[q.collision]);
    if (q.createdSince !== undefined) {
      where.push("p.created_at >= ?");
      params.push(q.createdSince);
    }
    const order = {
      score: "s.total IS NULL, s.total DESC, p.id DESC",
      newest: "p.created_at DESC, p.id DESC",
      changed: "p.updated_at DESC, p.id DESC",
      usage: "cost_usd DESC, p.id DESC",
    }[q.sort ?? "score"];
    const limit = q.limit === undefined ? -1 : Math.max(1, Math.floor(q.limit));
    const rows = this.db
      .prepare(
        `${PROPOSAL_SELECT}
         LEFT JOIN scores s ON s.id = (SELECT MAX(id) FROM scores WHERE narrative_id = p.narrative_id)
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY ${order}
         LIMIT ?`,
      )
      .all(...params, limit) as unknown as Row[];
    return rows.map(toProposal);
  }

  /** Stores Signals the datastore has not seen (by id); returns how many were new. The first observation of an item is kept. */
  recordSignals(signals: Signal[], at: Date = new Date()): number {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO signals (id, source_id, source_label, title, summary, url, published_at, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = at.toISOString();
    return this.inTransaction(() => {
      let added = 0;
      for (const s of signals) {
        // A feed's clock is untrusted: a publish time in the future would pin the item to the top of the list for good.
        const publishedAt = s.publishedAt > now ? now : s.publishedAt;
        added += Number(insert.run(s.id, s.sourceId, s.sourceLabel, s.title, s.summary, s.url, publishedAt, now).changes);
      }
      return added;
    });
  }

  /**
   * WORKER ONLY. Records the outcome of one poll of a Source: a success (no `error`) sets `lastOkAt` and clears the last error; a
   * failure keeps `lastOkAt` and stores the message (shortened, URL credentials and query strings removed).
   */
  recordSourcePoll(poll: { sourceId: string; label: string; error?: string }, at: Date = new Date()): void {
    const now = at.toISOString();
    const error = poll.error === undefined ? null : cleanPollError(poll.error);
    this.db
      .prepare(
        `INSERT INTO source_polls (source_id, source_label, last_polled_at, last_ok_at, last_error, last_error_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET
           source_label = excluded.source_label,
           last_polled_at = excluded.last_polled_at,
           last_ok_at = COALESCE(excluded.last_ok_at, last_ok_at),
           last_error = excluded.last_error,
           last_error_at = excluded.last_error_at`,
      )
      .run(poll.sourceId, poll.label, now, error === null ? now : null, error, error === null ? null : now);
  }

  /** Every Source that has polled or has Signals, by id, with its last poll, last error and Signals ingested in the 24 h before `now`. */
  sourceHealth(now: Date = new Date()): SourceHealth[] {
    const dayAgo = new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT i.source_id,
                COALESCE(p.source_label, (SELECT s.source_label FROM signals s WHERE s.source_id = i.source_id ORDER BY s.ingested_at DESC LIMIT 1), i.source_id) AS label,
                p.last_polled_at, p.last_ok_at, p.last_error, p.last_error_at,
                (SELECT COUNT(*) FROM signals s WHERE s.source_id = i.source_id AND s.ingested_at >= ?) AS signals_24h
         FROM (SELECT source_id FROM source_polls UNION SELECT source_id FROM signals) i
         LEFT JOIN source_polls p ON p.source_id = i.source_id
         ORDER BY i.source_id`,
      )
      .all(dayAgo) as unknown as Array<{ source_id: string; label: string; last_polled_at: string | null; last_ok_at: string | null; last_error: string | null; last_error_at: string | null; signals_24h: number }>;
    return rows.map((r) => ({
      sourceId: r.source_id,
      label: r.label,
      lastPolledAt: r.last_polled_at,
      lastOkAt: r.last_ok_at,
      lastError: r.last_error,
      lastErrorAt: r.last_error_at,
      signals24h: r.signals_24h,
    }));
  }

  /** The newest Narratives by creation, then id, descending. */
  newestNarratives(limit = 20): Narrative[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, summary, signal_count, created_at, last_signal_at, changed_materially_at
         FROM narratives ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(limit) as unknown as NarrativeRow[];
    return rows.map(toNarrative);
  }

  /** The newest judge and propose runs (Spec and Build runs left out), by id descending. */
  recentBrainRuns(limit = 20): BrainRunSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM brain_runs WHERE task IN ('judge', 'propose') ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as BrainRunRow[];
    return rows.map((r) => ({
      id: r.id,
      task: r.task,
      status: r.exit_status,
      backend: r.backend,
      model: r.model,
      narrativeId: r.narrative_id,
      proposalId: r.proposal_id,
      estCostUsd: r.total_cost_usd,
      costKind: r.backend === "api" ? "api" : "est",
      startedAt: r.created_at,
      finishedAt: r.finished_at,
      durationSec: r.finished_at === null ? null : Math.round((Date.parse(r.finished_at) - Date.parse(r.created_at)) / 1000),
    }));
  }

  /** The most recently published Signals, newest first. */
  latestSignals(limit = 50): StoredSignal[] {
    const rows = this.db
      .prepare("SELECT * FROM signals ORDER BY published_at DESC, ingested_at DESC, id LIMIT ?")
      .all(limit) as unknown as SignalRow[];
    return rows.map(toStoredSignal);
  }

  /** WORKER ONLY. Signals not yet in a Narrative, oldest first (published time, then id), so clustering is deterministic. */
  unclusteredSignals(limit = 500): StoredSignal[] {
    const rows = this.db
      .prepare("SELECT * FROM signals WHERE narrative_id IS NULL ORDER BY published_at ASC, id ASC LIMIT ?")
      .all(limit) as unknown as SignalRow[];
    return rows.map(toStoredSignal);
  }

  /** WORKER ONLY. Narratives built by `embedder` that gained a Signal at or after `since` (ISO), which a new Signal may join. */
  recentNarratives(since: string, embedder: NarrativeEmbedder): NarrativeCandidate[] {
    const rows = this.db
      .prepare("SELECT id, centroid, signal_count FROM narratives WHERE last_signal_at >= ? AND embedder = ? AND dimension = ? ORDER BY id")
      .all(since, embedder.id, embedder.dimension) as unknown as Array<{ id: number; centroid: string; signal_count: number }>;
    return rows.map((r) => ({ id: r.id, centroid: JSON.parse(r.centroid) as number[], signalCount: r.signal_count }));
  }

  /** How many Narratives each embedder built, as clustering sees them (diagnostics, and the migration test). */
  narrativeEmbedders(): Array<{ embedder: string; dimension: number; narratives: number }> {
    const rows = this.db
      .prepare("SELECT embedder, dimension, COUNT(*) AS n FROM narratives GROUP BY embedder, dimension ORDER BY embedder, dimension")
      .all() as unknown as Array<{ embedder: string; dimension: number; n: number }>;
    return rows.map((r) => ({ embedder: r.embedder, dimension: r.dimension, narratives: r.n }));
  }

  /** WORKER ONLY. Starts a Narrative from `signal` and puts the Signal in it; returns the Narrative id. */
  createNarrative(signal: StoredSignal, centroid: number[], now: string, embedder: NarrativeEmbedder): number {
    return this.inTransaction(() => {
      const res = this.db
        .prepare(
          `INSERT INTO narratives (title, summary, centroid, signal_count, material_signal_count, created_at, last_signal_at, changed_materially_at, embedder, dimension)
           VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?)`,
        )
        .run(signal.title, signal.summary.slice(0, NARRATIVE_SUMMARY_CHARS), JSON.stringify(centroid), now, now, now, embedder.id, embedder.dimension);
      const id = Number(res.lastInsertRowid);
      this.db.prepare("UPDATE signals SET narrative_id = ? WHERE id = ? AND narrative_id IS NULL").run(id, signal.id);
      return id;
    });
  }

  /** WORKER ONLY. Puts `signal` in the Narrative with its new centroid; stamps `changed_materially_at` when the join is material. */
  joinNarrative(narrativeId: number, signal: StoredSignal, centroid: number[], now: string): void {
    this.inTransaction(() => {
      const row = this.db
        .prepare("SELECT signal_count, material_signal_count FROM narratives WHERE id = ?")
        .get(narrativeId) as unknown as { signal_count: number; material_signal_count: number } | undefined;
      if (!row) throw new DomainError(`Narrative ${narrativeId} not found`);
      const moved = this.db.prepare("UPDATE signals SET narrative_id = ? WHERE id = ? AND narrative_id IS NULL").run(narrativeId, signal.id);
      if (Number(moved.changes) === 0) return; // already in a Narrative: a Signal belongs to at most one
      const heardFrom = this.db
        .prepare("SELECT 1 FROM signals WHERE narrative_id = ? AND source_id = ? AND id <> ? LIMIT 1")
        .get(narrativeId, signal.sourceId, signal.id);
      const signalCount = row.signal_count + 1;
      const material = isMaterialJoin({ newSource: !heardFrom, signalCount, countAtLastMaterial: row.material_signal_count });
      this.db
        .prepare(
          `UPDATE narratives SET signal_count = ?, centroid = ?, last_signal_at = ?,
             material_signal_count = CASE WHEN ? THEN ? ELSE material_signal_count END,
             changed_materially_at = CASE WHEN ? THEN ? ELSE changed_materially_at END
           WHERE id = ?`,
        )
        .run(signalCount, JSON.stringify(centroid), now, Number(material), signalCount, Number(material), now, narrativeId);
    });
  }

  /** The Narratives, most recently gained a Signal first. */
  listNarratives(limit = 100): Narrative[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, summary, signal_count, created_at, last_signal_at, changed_materially_at
         FROM narratives ORDER BY last_signal_at DESC, id DESC LIMIT ?`,
      )
      .all(limit) as unknown as NarrativeRow[];
    return rows.map(toNarrative);
  }

  /**
   * The Narratives list the War Room shows, filtered and sorted in SQL so a cap (`limit`, default 100) cuts the right rows: "highest
   * Score" is highest across every Narrative, not across the newest hundred. `score` is the latest Score's total (null before the
   * first Score); `hasProposal` is whether a Proposal exists for it. Filters: `scored`, `hasProposal`, `sourceId` (at least one Signal
   * from that Source), `activeSince` (ISO; gained a Signal at or after it). Sorts: `score` (default, highest first, unscored last, then
   * busiest), `newest` (by creation), `signals` (most Signals), `active` (latest Signal first).
   */
  queryNarratives(q: NarrativeQuery = {}): NarrativeListItem[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (q.scored !== undefined) where.push(q.scored ? "s.id IS NOT NULL" : "s.id IS NULL");
    if (q.hasProposal !== undefined) where.push(`${q.hasProposal ? "" : "NOT "}EXISTS (SELECT 1 FROM proposals p WHERE p.narrative_id = n.id)`);
    if (q.sourceId !== undefined) {
      where.push("EXISTS (SELECT 1 FROM signals g WHERE g.narrative_id = n.id AND g.source_id = ?)");
      params.push(q.sourceId);
    }
    if (q.activeSince !== undefined) {
      where.push("n.last_signal_at >= ?");
      params.push(q.activeSince);
    }
    const order = {
      score: "s.total IS NULL, s.total DESC, n.signal_count DESC, n.id DESC",
      newest: "n.created_at DESC, n.id DESC",
      signals: "n.signal_count DESC, n.last_signal_at DESC, n.id DESC",
      active: "n.last_signal_at DESC, n.id DESC",
    }[q.sort ?? "score"];
    const limit = Math.max(1, Math.min(500, Math.floor(q.limit ?? 100)));
    const rows = this.db
      .prepare(
        `SELECT n.id, n.title, n.summary, n.signal_count, n.created_at, n.last_signal_at, n.changed_materially_at,
                s.total AS score_total,
                EXISTS (SELECT 1 FROM proposals p WHERE p.narrative_id = n.id) AS has_proposal,
                ${HAS_MARKET_SIGNAL} AS has_market
         FROM narratives n
         LEFT JOIN scores s ON s.id = (SELECT MAX(id) FROM scores WHERE narrative_id = n.id)
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY ${order}
         LIMIT ?`,
      )
      .all(...params, limit) as unknown as Array<NarrativeRow & { score_total: number | null; has_proposal: number; has_market: number }>;
    return rows.map((r) => ({ ...toNarrative(r), score: r.score_total, hasProposal: r.has_proposal === 1, sourceClass: r.has_market === 1 ? "market" : "context" }));
  }

  getNarrative(id: number): NarrativeDetail | undefined {
    const row = this.db
      .prepare(
        "SELECT id, title, summary, signal_count, created_at, last_signal_at, changed_materially_at FROM narratives WHERE id = ?",
      )
      .get(id) as unknown as NarrativeRow | undefined;
    if (!row) return undefined;
    const signals = this.db
      .prepare("SELECT * FROM signals WHERE narrative_id = ? ORDER BY published_at DESC, ingested_at DESC, id")
      .all(id) as unknown as SignalRow[];
    return { ...toNarrative(row), signals: signals.map(toStoredSignal), scores: this.scoresFor(id) };
  }

  /** A Narrative's Score history, newest first. */
  scoresFor(narrativeId: number): Score[] {
    const rows = this.db.prepare("SELECT * FROM scores WHERE narrative_id = ? ORDER BY id DESC").all(narrativeId) as unknown as ScoreRow[];
    return rows.map(toScore);
  }

  /**
   * WORKER ONLY. The judge delta: Narratives built by `embedder` (never another embedder's) that gained a Signal at or after `since`
   * (ISO) and need a Score, busiest first. A Narrative needs one when it has none, or it changed materially after the one it has.
   * Left out: a Narrative with a judge run open, and one with a judge run since its last material change that hit its budget or was
   * refused (`budget-exceeded`, `invalid-output`): those say something about the Narrative, so it is tried again when it changes, not
   * before. Every other ending (`failed`, `timed-out`, `rate-limited`, `interrupted`) says something about claude, the network or the
   * worker, so the Narrative stays eligible; the 24 h run and spend caps and the consecutive-failure backoff bound the retries.
   * Also left out: a Narrative backed by fewer than `minSignals` Signals. It is skipped, not scored, and starts no run, so it never
   * counts against the run cap; it becomes eligible the moment it gains Signals to reach `minSignals`. Default 1 (no filter); the judge
   * passes `JudgeConfig.minSignals`.
   * Also left out: a Narrative with no market Signal (ticket 24, `sources/source-class.ts`): context Signals are background only. Same
   * for a skipped Narrative: no run, no cap use; it is eligible the moment it gains a market Signal.
   */
  narrativesToJudge(embedder: NarrativeEmbedder, since: string, limit: number, maxConsecutiveTimeouts = Infinity, minSignals = 1): Narrative[] {
    // Also left out: a Narrative whose last `maxConsecutiveTimeouts` judge runs since its last material change all timed out (a poison
    // Narrative would otherwise be retried, and starve the pass, until the daily cap). Counted from brain_runs, so a restart keeps it.
    const n = Number.isFinite(maxConsecutiveTimeouts) ? Math.max(1, Math.floor(maxConsecutiveTimeouts)) : 0;
    const rows = this.db
      .prepare(
        `SELECT n.id, n.title, n.summary, n.signal_count, n.created_at, n.last_signal_at, n.changed_materially_at
         FROM narratives n
         WHERE n.embedder = ? AND n.dimension = ? AND n.last_signal_at >= ? AND n.signal_count >= ?
           AND ${HAS_MARKET_SIGNAL}
           AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.narrative_id = n.id AND s.changed_materially_at >= n.changed_materially_at)
           AND NOT EXISTS (SELECT 1 FROM brain_runs b WHERE b.task = 'judge' AND b.narrative_id = n.id AND b.exit_status = '${BRAIN_RUN_IN_FLIGHT}')
           AND NOT EXISTS (
             SELECT 1 FROM brain_runs b
             WHERE b.task = 'judge' AND b.narrative_id = n.id AND b.created_at >= n.changed_materially_at
               AND b.exit_status IN ('invalid-output', 'budget-exceeded'))
           AND (? = 0 OR (SELECT COUNT(*) FROM (
             SELECT b.exit_status FROM brain_runs b
             WHERE b.task = 'judge' AND b.narrative_id = n.id AND b.created_at >= n.changed_materially_at
             ORDER BY b.id DESC LIMIT ?) WHERE exit_status = 'timed-out') < ?)
         ORDER BY n.signal_count DESC, n.id
         LIMIT ?`,
      )
      .all(embedder.id, embedder.dimension, since, Math.max(1, Math.floor(minSignals)), n, n, n, limit) as unknown as NarrativeRow[];
    return rows.map(toNarrative);
  }

  /**
   * WORKER ONLY. The context block's source (ticket 24): Narratives built by `embedder` that hold no market Signal, busiest first by the
   * Signals ingested at or after `since` (ISO), at most `limit`. Titles are untrusted text.
   */
  contextNarratives(embedder: NarrativeEmbedder, since: string, limit: number): Array<{ title: string; recentSignals: number }> {
    const rows = this.db
      .prepare(
        `SELECT n.title AS title, COUNT(*) AS recent
         FROM narratives n JOIN signals sg ON sg.narrative_id = n.id AND sg.ingested_at >= ?
         WHERE n.embedder = ? AND n.dimension = ? AND NOT ${HAS_MARKET_SIGNAL}
         GROUP BY n.id
         ORDER BY recent DESC, n.id
         LIMIT ?`,
      )
      .all(since, embedder.id, embedder.dimension, Math.max(0, Math.floor(limit))) as unknown as Array<{ title: string; recent: number }>;
    return rows.map((r) => ({ title: r.title, recentSignals: r.recent }));
  }

  /** A Narrative's latest Score (what its Proposal's card shows), or undefined before it has one. */
  latestScore(narrativeId: number): Score | undefined {
    const row = this.db.prepare("SELECT * FROM scores WHERE narrative_id = ? ORDER BY id DESC LIMIT 1").get(narrativeId) as unknown as ScoreRow | undefined;
    return row && toScore(row);
  }

  /**
   * WORKER ONLY. The propose delta: Narratives built by `embedder` that gained a Signal at or after `since` (ISO), whose latest Score
   * has a buildability of at least `gateMin` (the Rubric's hard gate; the caller passes the gate as it is now), that have no Proposal
   * yet (ever, dismissed ones included), at least one market Signal (ticket 24) and no propose run open. Best weighted total first. A Narrative whose propose run was refused
   * or over budget since its latest Score is left out until it is scored again; any other ending (claude missing, a timeout, a rate
   * limit) leaves it eligible, bounded by the daily run and spend caps.
   */
  narrativesToPropose(embedder: NarrativeEmbedder, since: string, gateMin: number, limit: number, maxConsecutiveTimeouts = Infinity): Array<{ narrative: Narrative; score: Score }> {
    // As for the judge: a Narrative whose last `maxConsecutiveTimeouts` propose runs since its latest Score all timed out is left out until it is scored again.
    const n = Number.isFinite(maxConsecutiveTimeouts) ? Math.max(1, Math.floor(maxConsecutiveTimeouts)) : 0;
    const rows = this.db
      .prepare(
        `SELECT n.id AS nid, n.title, n.summary, n.signal_count AS n_signal_count, n.created_at AS n_created_at, n.last_signal_at, n.changed_materially_at AS n_changed_materially_at, s.*
         FROM narratives n
         JOIN scores s ON s.id = (SELECT MAX(id) FROM scores WHERE narrative_id = n.id)
         WHERE n.embedder = ? AND n.dimension = ? AND n.last_signal_at >= ?
           AND ${HAS_MARKET_SIGNAL}
           AND json_extract(s.scores, '$.buildability') >= ?
           AND NOT EXISTS (SELECT 1 FROM proposals p WHERE p.narrative_id = n.id)
           AND NOT EXISTS (SELECT 1 FROM brain_runs b WHERE b.task = 'propose' AND b.narrative_id = n.id AND b.exit_status = '${BRAIN_RUN_IN_FLIGHT}')
           AND NOT EXISTS (
             SELECT 1 FROM brain_runs b
             WHERE b.task = 'propose' AND b.narrative_id = n.id AND b.created_at >= s.created_at
               AND b.exit_status IN ('invalid-output', 'budget-exceeded'))
           AND (? = 0 OR (SELECT COUNT(*) FROM (
             SELECT b.exit_status FROM brain_runs b
             WHERE b.task = 'propose' AND b.narrative_id = n.id AND b.created_at >= s.created_at
             ORDER BY b.id DESC LIMIT ?) WHERE exit_status = 'timed-out') < ?)
         ORDER BY s.total DESC, n.id
         LIMIT ?`,
      )
      .all(embedder.id, embedder.dimension, since, gateMin, n, n, n, limit) as unknown as Array<ScoreRow & { nid: number; title: string; summary: string; n_signal_count: number; n_created_at: string; last_signal_at: string; n_changed_materially_at: string }>;
    return rows.map((r) => ({
      narrative: toNarrative({ id: r.nid, title: r.title, summary: r.summary, signal_count: r.n_signal_count, created_at: r.n_created_at, last_signal_at: r.last_signal_at, changed_materially_at: r.n_changed_materially_at }),
      score: toScore(r),
    }));
  }

  /** WORKER ONLY. Stores a judge result. Scores are only ever added: this is the history. Touches no Proposal. */
  recordScore(score: NewScore): number {
    const res = this.db
      .prepare(
        `INSERT INTO scores (narrative_id, rubric_version, scores, total, rationale, signal_count, changed_materially_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(score.narrativeId, score.rubricVersion, JSON.stringify(score.scores), score.total, score.rationale, score.signalCount, score.changedMateriallyAt, score.createdAt);
    return Number(res.lastInsertRowid);
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
      // Only an approved Proposal can carry a refusal; leaving `approved` by any route (Build start, needs-human, dismissed) drops it.
      this.db.prepare("DELETE FROM build_refusals WHERE proposal_id = ?").run(proposalId);
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
        `INSERT INTO brain_runs (proposal_id, task, backend, model, session_id, total_cost_usd, exit_status, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        new Date().toISOString(),
      );
  }

  brainRunsFor(proposalId: number): BrainRunRecord[] {
    const rows = this.db.prepare("SELECT * FROM brain_runs WHERE proposal_id = ? ORDER BY id").all(proposalId) as unknown as BrainRunRow[];
    return rows.map(toBrainRun);
  }

  /** The judge runs for one Narrative, oldest first. */
  judgeRunsFor(narrativeId: number): BrainRunRecord[] {
    const rows = this.db.prepare("SELECT * FROM brain_runs WHERE task = 'judge' AND narrative_id = ? ORDER BY id").all(narrativeId) as unknown as BrainRunRow[];
    return rows.map(toBrainRun);
  }

  /**
   * What the judge has spent since `since` (ISO): runs started, the cost they reported (`costUsd`) and what they are charged against a
   * budget (`chargedUsd`, see `spendSince`). Refused and failed runs count too.
   */
  judgeSpendSince(since: string, caps?: RunCaps): Spend {
    return this.spendSince(["judge"], since, caps);
  }

  /** What the propose pass has spent since `since` (ISO), as for `judgeSpendSince`. */
  proposeSpendSince(since: string, caps?: RunCaps): Spend {
    return this.spendSince(["propose"], since, caps);
  }

  /** What the Meta summary task has spent since `since` (ISO), as for `judgeSpendSince`. */
  metaSummarySpendSince(since: string, caps?: RunCaps): Spend {
    return this.spendSince(["meta-summary"], since, caps);
  }

  /** What research (judge, propose and the Meta summary line) has spent since `since` (ISO): the figure the shared research budget is held to (`chargedUsd`). */
  researchSpendSince(since: string, caps?: RunCaps): Spend {
    return this.spendSince(["judge", "propose", "meta-summary"], since, caps);
  }

  /**
   * `costUsd` is the sum of the costs runs reported. A run that ended without printing a result (killed by its wall-clock cap, by a
   * shutdown, or left in flight by a worker that died) reports $0 although it may have spent up to its `--max-budget-usd`, so for
   * budget purposes `chargedUsd` charges such a run (`timed-out`, `interrupted`, or still `in-flight`, with no cost recorded) at its
   * task's cap from `caps`, which is a ceiling on what it can have used. So is a `failed` run that has a session (claude ran, then failed
   * without printing a cost). A `failed` run with no session is not charged: it is what a claude that never started looks like. Without `caps` nothing is charged beyond the reported cost.
   */
  private spendSince(tasks: readonly string[], since: string, caps: RunCaps = {}, backend: "subscription" | "api" = "subscription"): Spend {
    const capFor = (task: string) => caps[task] ?? 0;
    // Est. usage (subscription) and real dollars (api) are different currencies and never mix: each figure sees only its own runs'
    // cost. `runs` counts every backend, so the run caps hold whatever ran them.
    const mine = backend === "api" ? "backend = 'api'" : "backend != 'api'";
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS runs, COALESCE(SUM(CASE WHEN ${mine} THEN total_cost_usd ELSE 0 END), 0) AS cost,
           COALESCE(SUM(CASE WHEN NOT (${mine}) THEN 0 WHEN total_cost_usd = 0 AND (exit_status IN ('timed-out', 'interrupted', '${BRAIN_RUN_IN_FLIGHT}') OR (exit_status = 'failed' AND session_id IS NOT NULL))
             THEN (CASE task ${tasks.map(() => "WHEN ? THEN ?").join(" ")} ELSE 0 END) ELSE total_cost_usd END), 0) AS charged
         FROM brain_runs WHERE task IN (${tasks.map(() => "?").join(",")}) AND created_at >= ?${backend === "api" ? " AND backend = 'api'" : ""}`,
      )
      .get(...tasks.flatMap((t) => [t, capFor(t)]), ...tasks, since) as unknown as { runs: number; cost: number; charged: number };
    return { runs: row.runs, costUsd: row.cost, chargedUsd: row.charged };
  }

  /**
   * The REAL dollars the API backend has spent since `since` (ISO), judge and propose together. `chargedUsd` is the figure the daily
   * API cap is held to: what the runs reported, except that a run that has not finished (in flight) or ended with no cost (interrupted,
   * timed out) is charged at its task's ceiling from `caps`. A failed API call whose cost was unknown is recorded with its ceiling as
   * its cost (ApiBrain does that), so it is counted here as it stands.
   */
  apiSpendSince(since: string, caps?: RunCaps): Spend {
    return this.spendSince(["judge", "propose"], since, caps, "api");
  }

  /**
   * WORKER ONLY. Opens a brain run before the child is spawned, so a crash leaves a row behind instead of
   * unrecorded spend. Returns its id; close it with finishBrainRun (or discardBrainRun for a dry run).
   */
  startBrainRun(run: Pick<NewBrainRun, "proposalId" | "task" | "backend" | "model"> & { narrativeId?: number }, now: Date = new Date()): number {
    const res = this.db
      .prepare(
        `INSERT INTO brain_runs (proposal_id, narrative_id, task, backend, model, session_id, total_cost_usd, exit_status, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
      )
      .run(run.proposalId, run.narrativeId ?? null, run.task, run.backend, run.model, BRAIN_RUN_IN_FLIGHT, now.toISOString());
    return Number(res.lastInsertRowid);
  }

  /**
   * WORKER ONLY. Takes the Build slot: `approved` -> `building` and the Build's brain run opened, in one transaction, so a
   * `building` Proposal never exists without an open run (the sweep treats one that does as left by a crash). Returns the run id.
   */
  beginBuild(proposalId: number, route: Pick<NewBrainRun, "backend" | "model">): number {
    return this.inTransaction(() => {
      this.transition(proposalId, "building", "build");
      // The condition that refused the Build is gone: the other approved Proposals' refusals were the same worker-wide one.
      this.db.exec("DELETE FROM build_refusals");
      // A fresh Build: the Worker a previous one deployed was removed by the Operator before the re-queue.
      this.db.prepare("UPDATE proposals SET worker_deployed = 0, build_repo = NULL, build_cleaned = 0 WHERE id = ?").run(proposalId);
      return this.startBrainRun({ proposalId, task: "build", ...route });
    });
  }

  /**
   * WORKER ONLY. Stores why the Build did not start, for every approved Proposal (the cause is worker-wide): one value each,
   * replaced on every refused tick, so the time is the latest attempt and nothing grows.
   */
  recordBuildRefusal(refusal: PreflightRefusal): void {
    const at = new Date().toISOString();
    this.inTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO build_refusals (proposal_id, code, message, at) SELECT id, ?, ?, ? FROM proposals WHERE status = 'approved'
           ON CONFLICT(proposal_id) DO UPDATE SET code = excluded.code, message = excluded.message, at = excluded.at`,
        )
        .run(refusal.code, refusal.message, at);
    });
  }

  /** The latest refusal of an approved Proposal's Build, or null (not approved, or no refusal). */
  buildRefusalFor(proposalId: number): BuildRefusal | null {
    const r = this.db
      .prepare("SELECT r.code, r.message, r.at FROM build_refusals r JOIN proposals p ON p.id = r.proposal_id WHERE r.proposal_id = ? AND p.status = 'approved'")
      .get(proposalId) as { code: BuildRefusalCode; message: string; at: string } | undefined;
    return r ? { code: r.code, message: r.message, at: r.at } : null;
  }

  /** WORKER ONLY. Records that the Build deployed the Proposal's Worker to Cloudflare (it is a leftover if the Build then fails). */
  markWorkerDeployed(proposalId: number): void {
    this.db.prepare("UPDATE proposals SET worker_deployed = 1 WHERE id = ?").run(proposalId);
  }

  /** WORKER ONLY. Records the private GitHub repo (`owner/slug`) this Build created: the only repo "Clean up build" will delete without a typed confirmation. */
  recordBuildRepo(proposalId: number, repo: string): void {
    this.db.prepare("UPDATE proposals SET build_repo = ? WHERE id = ?").run(repo, proposalId);
  }

  /**
   * WORKER ONLY. Takes the Proposal for a "Clean up build" run: false when it is not in one of `allowed` (it moved on, for example it was
   * re-queued) or another clean-up holds it. The check and the claim are one transaction, and a re-queue checks `cleanupRunning` inside
   * its own, so the two are ordered whichever worker process comes first: while a clean-up is applying, the Proposal cannot be re-queued,
   * and a Proposal that has been re-queued cannot be claimed. A claim older than CLEANUP_CLAIM_TTL_MS (a worker that died) is void.
   */
  beginCleanup(proposalId: number, allowed: readonly ProposalStatus[], now = new Date()): boolean {
    return this.inTransaction(() => {
      const p = this.getProposal(proposalId);
      if (!p || !allowed.includes(p.status) || this.cleanupRunning(proposalId, now)) return false;
      this.db.prepare("UPDATE proposals SET cleanup_claimed_at = ? WHERE id = ?").run(now.toISOString(), proposalId);
      return true;
    });
  }

  /** WORKER ONLY. Lets go of the Proposal after a "Clean up build" run, whatever its outcome. */
  endCleanup(proposalId: number): void {
    this.db.prepare("UPDATE proposals SET cleanup_claimed_at = NULL WHERE id = ?").run(proposalId);
  }

  /** Is a "Clean up build" run applying for this Proposal right now (a claim younger than CLEANUP_CLAIM_TTL_MS)? */
  cleanupRunning(proposalId: number, now = new Date()): boolean {
    const row = this.db.prepare("SELECT cleanup_claimed_at AS at FROM proposals WHERE id = ?").get(proposalId) as { at: string | null } | undefined;
    return row?.at != null && now.getTime() - Date.parse(row.at) <= CLEANUP_CLAIM_TTL_MS;
  }

  /**
   * WORKER ONLY. Records one "Clean up build" run: one `status_history` row per artifact (the status stays what it is, actor
   * `operator`), `build_cleaned` set to `cleaned`, and `repo` kept as the Build's repo when a legacy one was just removed (so a
   * second run can say it is gone). Never changes the Proposal's status.
   */
  recordCleanup(proposalId: number, lines: readonly string[], cleaned: boolean, repo?: string): void {
    this.inTransaction(() => {
      const current = this.getProposal(proposalId);
      if (!current) throw new ProposalNotFoundError(proposalId);
      const now = new Date().toISOString();
      for (const line of lines) {
        this.db
          .prepare("INSERT INTO status_history (proposal_id, from_status, to_status, actor, reason, at) VALUES (?, ?, ?, 'operator', ?, ?)")
          .run(proposalId, current.status, current.status, line, now);
      }
      this.db.prepare("UPDATE proposals SET build_cleaned = ? WHERE id = ?").run(cleaned ? 1 : 0, proposalId);
      if (repo !== undefined) this.db.prepare("UPDATE proposals SET build_repo = ? WHERE id = ?").run(repo, proposalId);
    });
  }

  /**
   * WORKER ONLY. Records what an open run has cost so far and its session, leaving it open (`in-flight`). The Build run stays
   * open past the claude child, through the deploy and checks, until the Proposal reaches its terminal state; the spend is
   * on the card from here on, even if the worker dies before the run is closed.
   */
  recordBrainRunSpend(id: number, spend: { sessionId: string | null; totalCostUsd: number }): void {
    this.db.prepare("UPDATE brain_runs SET session_id = ?, total_cost_usd = ? WHERE id = ? AND exit_status = ?").run(spend.sessionId, spend.totalCostUsd, id, BRAIN_RUN_IN_FLIGHT);
  }

  /**
   * WORKER ONLY. Says an open run's process is alive. The stale sweep counts a run's age from its last beat (or its start, if
   * it never beat), so a Build that is still working after claude has used its whole cap (the deploy, the preview crawl and the
   * push take as long as they take, each bounded by its own timeout) is not mistaken for one a dead worker left behind.
   */
  touchBrainRun(id: number, now = new Date()): void {
    this.db.prepare("UPDATE brain_runs SET heartbeat_at = ? WHERE id = ? AND exit_status = ?").run(now.toISOString(), id, BRAIN_RUN_IN_FLIGHT);
  }

  /**
   * WORKER ONLY. Records what a run cost and how it ended, as soon as the child is done. `backend` and `model`, when given, correct
   * the row to what actually ran it: a run opened on claude-code may have been served by the API after a rate limit, and its dollars
   * must land in the API figure, not in Est. usage.
   */
  finishBrainRun(id: number, done: { sessionId: string | null; totalCostUsd: number; exitStatus: string; backend?: string; model?: string }): void {
    this.db
      .prepare("UPDATE brain_runs SET session_id = ?, total_cost_usd = ?, exit_status = ?, backend = COALESCE(?, backend), model = COALESCE(?, model), finished_at = ? WHERE id = ?")
      .run(done.sessionId, done.totalCostUsd, done.exitStatus, done.backend ?? null, done.model ?? null, new Date().toISOString(), id);
  }

  /**
   * WORKER ONLY. Ends the Build's run for a failed attempt and opens the run of its one retry, in one transaction: the Proposal
   * stays `building` and never has a moment without an open run (the stale sweep would fail it). Returns the new run's id.
   */
  restartBuildRun(id: number, done: { sessionId: string | null; totalCostUsd: number; exitStatus: string }, route: Pick<NewBrainRun, "backend" | "model">): number {
    return this.inTransaction(() => {
      const proposalId = (this.db.prepare("SELECT proposal_id FROM brain_runs WHERE id = ?").get(id) as { proposal_id: number } | undefined)?.proposal_id;
      if (proposalId === undefined) throw new Error(`brain run ${id} not found`);
      this.finishBrainRun(id, done);
      return this.startBrainRun({ proposalId, task: "build", ...route });
    });
  }

  /**
   * WORKER ONLY. Switches an OPEN run to the backend and model that is about to serve it, before the request is sent: a run opened on
   * claude-code may be handed to the API after a rate limit, and from this moment it is an API run, charged in the real-dollar ledger at
   * its task's cap until it finishes (so overlapping runs see it, and a crash cannot leave it uncounted). A finished run is left alone.
   */
  setBrainRunBackend(id: number, backend: string, model: string): void {
    this.db.prepare("UPDATE brain_runs SET backend = ?, model = ? WHERE id = ? AND exit_status = ?").run(backend, model, id, BRAIN_RUN_IN_FLIGHT);
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
   * WORKER ONLY, call at worker boot and on every tick. Marks each open run whose last sign of life (its last heartbeat, else its start) is older than `staleAfterMs(its task)` as `interrupted` (its
   * spend is unknown and recorded as 0) and sets `specError` on a still-shortlisted Proposal whose Spec draft it was.
   * Nothing is retried: the failure shows on the card. `staleAfterMs` is the task's run timeout plus a grace
   * period: a live run is killed at its timeout, so a younger row may belong to a live worker (this process, or a
   * foreground `--once` run beside the daemon) and is left alone. Also fails any `building` Proposal that has no open
   * build run (see below). Returns how many runs and Proposals were marked.
   */
  interruptStaleBrainRuns(staleAfterMs: (task: string) => number, now = new Date()): number {
    return this.inTransaction(() => {
      const rows = this.db
        .prepare("SELECT id, proposal_id, task, COALESCE(heartbeat_at, created_at) AS created_at FROM brain_runs WHERE exit_status = ?")
        .all(BRAIN_RUN_IN_FLIGHT) as unknown as { id: number; proposal_id: number; task: string; created_at: string }[];
      let n = 0;
      for (const r of rows) {
        if (new Date(r.created_at).getTime() >= now.getTime() - staleAfterMs(r.task)) continue;
        n++;
        this.db.prepare("UPDATE brain_runs SET exit_status = ?, finished_at = ? WHERE id = ?").run(BRAIN_RUN_INTERRUPTED, now.toISOString(), r.id);
        if (r.task === "build") {
          // The worker died mid-Build: its spend is unknown. Free the Build slot; the failure shows in the status history.
          const p = this.getProposal(r.proposal_id);
          if (p?.status === "building") {
            this.transition(
              r.proposal_id,
              "build-failed",
              "build",
              "Build interrupted: the worker stopped during the Build, so its spend is unknown. Not retried automatically.",
            );
          }
        }
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
      // A `building` Proposal with no open build run is a Build the worker left behind (beginBuild opens the run in the same
      // transaction, and the runner closes it only after the Proposal's terminal transition). Without this the queue, which
      // runs one Build at a time, would stay blocked on it forever.
      const orphans = this.db
        .prepare(
          `SELECT id FROM proposals WHERE status = 'building'
             AND NOT EXISTS (SELECT 1 FROM brain_runs b WHERE b.proposal_id = proposals.id AND b.task = 'build' AND b.exit_status = ?)`,
        )
        .all(BRAIN_RUN_IN_FLIGHT) as unknown as { id: number }[];
      for (const o of orphans) {
        n++;
        this.transition(o.id, "build-failed", "build", "Build interrupted: the worker stopped mid-Build (no open run was left). Not retried automatically.");
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
   * WORKER ONLY. The Operator takes a shortlist back: `shortlisted` or `spec-drafted` -> `new` and the Spec draft discarded (path, hash,
   * error, retry time, attempts, queued revision), in one transaction. The status is read and written under the same write lock as
   * `completeSpec`'s, so a Spec that completes meanwhile either lands first (and is discarded here) or finds the Proposal `new` and is
   * refused: an un-shortlisted Proposal is never flipped to `spec-drafted`. Not a Dismissal; no research feedback is recorded. Brain
   * runs are left alone (their spend stays on the card); the caller aborts a run in flight, which records itself. Returns the Spec path
   * the Proposal had, so the caller can delete the file. Throws DomainError from any other status.
   */
  undoShortlist(proposalId: number): { specPath: string | null } {
    return this.inTransaction(() => {
      const p = this.getProposal(proposalId);
      if (!p) throw new ProposalNotFoundError(proposalId);
      if (p.status !== "shortlisted" && p.status !== "spec-drafted") {
        throw new DomainError(`Undo shortlist is only possible until the Spec is approved (the Proposal is ${p.status})`);
      }
      this.transition(proposalId, "new", "operator");
      this.db
        .prepare(
          "UPDATE proposals SET spec_path = NULL, spec_hash = NULL, spec_error = '', spec_retry_after = NULL, spec_attempts = 0, spec_revision = NULL WHERE id = ?",
        )
        .run(proposalId);
      return { specPath: p.specPath };
    });
  }

  /**
   * WORKER ONLY. Stores the verified preview URL and moves `building` -> `built`, atomically. The Build's brain run is
   * recorded separately (finishBrainRun), earlier. Throws IllegalTransitionError if the Proposal moved on (dismissed).
   */
  completeBuild(proposalId: number, build: { previewUrl: string }): void {
    this.inTransaction(() => {
      this.transition(proposalId, "built", "build");
      this.db.prepare("UPDATE proposals SET preview_url = ? WHERE id = ?").run(build.previewUrl, proposalId);
    });
  }

  /** The Proposal a mint is recorded on, or null. One mint belongs to one Proposal. */
  proposalIdWithMint(mint: string): number | null {
    const row = this.db.prepare("SELECT id FROM proposals WHERE mint = ?").get(mint) as { id: number } | undefined;
    return row?.id ?? null;
  }

  /** WORKER ONLY. Moves `built` -> `launched` and records the mint the Operator reported, atomically. The caller has validated the format. */
  markLaunched(proposalId: number, mint: string): void {
    this.inTransaction(() => {
      const other = this.proposalIdWithMint(mint);
      if (other !== null && other !== proposalId) throw new DomainError(`Mint ${mint} is already recorded on Proposal ${other}`);
      this.transition(proposalId, "launched", "operator", `Operator marked launched: ${mint}`);
      this.db.prepare("UPDATE proposals SET mint = ? WHERE id = ?").run(mint, proposalId);
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

  /** The Rubric at `version`, else the current (highest) one. Versions are immutable, so a Score can name the one it used. */
  getRubric(version?: number): Rubric {
    const row = (
      version === undefined
        ? this.db.prepare("SELECT * FROM rubric_versions ORDER BY version DESC LIMIT 1").get()
        : this.db.prepare("SELECT * FROM rubric_versions WHERE version = ?").get(version)
    ) as RubricRow | undefined;
    if (!row) throw new DomainError(`No Rubric version ${version}`);
    return toRubric(row);
  }

  /** Rubric versions, newest first. */
  listRubricVersions(): number[] {
    return (this.db.prepare("SELECT version FROM rubric_versions ORDER BY version DESC").all() as { version: number }[]).map((r) => r.version);
  }

  /**
   * Operator edit: validates, then appends a new version if anything changed (an identical save returns the current
   * one). Throws InvalidRubricError on bad input and RubricConflictError when `baseVersion` is not the current version.
   */
  saveRubric(input: RubricInput): Rubric {
    const next = validateRubricInput(input);
    return this.inTransaction(() => {
      const cur = this.getRubric();
      if (input.baseVersion !== cur.version) throw new RubricConflictError();
      if (next.gateMinScore === cur.gateMinScore && JSON.stringify(next.dimensions) === JSON.stringify(cur.dimensions)) return cur;
      const version = cur.version + 1;
      this.db
        .prepare("INSERT INTO rubric_versions (version, dimensions, gate_min_score, created_at) VALUES (?, ?, ?, ?)")
        .run(version, JSON.stringify(next.dimensions), next.gateMinScore, new Date().toISOString());
      return this.getRubric(version);
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

  /** WORKER ONLY. Clears a failed Spec draft (error, attempt count and retry time) so the next tick drafts again. */
  resetSpecFailure(proposalId: number): void {
    this.db.prepare("UPDATE proposals SET spec_error = '', spec_attempts = 0, spec_retry_after = NULL WHERE id = ?").run(proposalId);
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
