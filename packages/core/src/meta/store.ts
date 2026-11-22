import type { DatabaseSync } from "node:sqlite";
import { META_WINDOWS, META_WINDOW_HOURS, type MetaConfig, type MetaWindow } from "./config.ts";
import { MARKET_SOURCE_IDS } from "../sources/source-class.ts";
import type { MetaCoverage } from "./coverage.ts";
import type { StoredGroupAnswer } from "./grouping.ts";

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
  /** When `marketCapUsd` was last read from DexScreener (ISO). A carried figure expires `stateMaxMinutes` after this, however many runs re-save it. */
  freshAt: string;
}

/** A launch theme that is a member of a grouped subject, as stored under it: the creator-voted label and its real counts (meta redesign ticket 06). */
export interface CurrentTheme {
  key: string;
  /** Creator-written text, cleaned and cut: still untrusted. */
  label: string;
  tokens: number;
  creators: number;
}

/**
 * What a subject's graduations came to (graduation Meta ticket 01), stored inside the row's counts JSON: pump launchpad tokens that graduated on the
 * subject in the last 24 h and 6 h, the distinct creators of the 24 h ones, and the subject's share of all graduations in 24 h (display only).
 */
export interface CurrentGrads {
  "24h": number;
  "6h": number;
  creators24h: number;
  /** 0 to 1: the subject's graduations over every graduation in the 24 h window. Never part of the rule. */
  share: number;
  /** Present only when the 24 h window is thin (a stream gap or a restart left few hours of data): the covered hours of the window. The subject still qualifies. */
  coverage?: { covered: number; of: number };
  /** Present only when a recording gap ended inside the 24 h window (ticket 04): the subject's graduations since that gap ended. */
  sinceGap?: number;
  /** The subject's newest graduates (at most 3, newest first), with the market cap where a token was priced this run; absent on a row stored before ticket 02. Untrusted text. */
  newest?: CurrentNewest[];
}

/** One of a subject's newest graduates: no `marketCapUsd` means no price is known (a dash on the page). */
export interface CurrentNewest {
  mint: string;
  name: string;
  symbol: string;
  marketCapUsd?: number;
}

/** A subject that is a Meta or Watching (graduation Meta ticket 01; ADR 0014 for the older market-led shape). `key` is the launch-theme group key. */
export interface CurrentMeta {
  key: string;
  /** The subject's name: the grouping step's (`namedBy: ai`) or the group's creator-voted label (`rules`). Creator-written text, cleaned and cut: still untrusted. */
  label: string;
  /** Who named it (ADR 0015, decision 4). Always set on a stored row; absent only where a test builds a row by hand, which reads as `rules`. */
  namedBy?: "ai" | "rules";
  /** The member launch themes the grouping step merged into this subject, most creators first, at most 12; empty for a subject named by rules. */
  themes?: CurrentTheme[];
  /** The highest-priced token of the subject, else its latest graduate with `marketCapUsd` 0 (no price known: shown as a dash). */
  leader: CurrentLeader;
  /** A Meta that stays on the stay rule without meeting the enter rule now (fewer graduations than it took to enter). Always false for Watching. */
  holding: boolean;
  /** When the subject entered its present state (Meta or Watching), carried from run to run. */
  enteredAt: string;
  /** The subject's launch-theme counts now (zero when no copy was launched in 24 h). */
  counts: Record<MetaWindow, MetaCounts>;
  /** The subject's graduations; absent on a row stored before graduation Metas. */
  grads?: CurrentGrads;
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
  /** The top-down candidates the run read, kept and dropped, each with its reason (ADR 0015). Absent stores none. */
  candidates?: NewMetaCandidate[];
  /** The grouping answer this run was built from, when the Brain was called for it this tick (a reused answer is already stored). Absent stores none. */
  grouping?: NewMetaGrouping;
}

/** One validated answer of the grouping step (`meta_groupings`): what it was made for (the items' identities, hashed), the answer and what it cost. */
export interface NewMetaGrouping {
  inputHash: string;
  answer: StoredGroupAnswer;
  /** What the Brain reported for the run, in Est. usage dollars. */
  costUsd: number;
  /** The `brain_runs` row of the call. */
  brainRunId: number | null;
}

export interface MetaGrouping extends NewMetaGrouping {
  id: number;
  computedAt: string;
  /** The Meta run that stored it. */
  runId: number;
  source: "ai";
}

/**
 * One token the top-down lists named in a run, for the War Room and a replay: "why is the big token not a Meta" has an answer without
 * rerunning anything. Name and symbol are creator-written text, cleaned and cut: still untrusted.
 */
export interface NewMetaCandidate {
  mint: string;
  name: string;
  symbol: string;
  marketCapUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  /** `jupiter`, `geckoterminal` or both. */
  sources: string[];
  /** The token's place on each list, by source. */
  ranks: Record<string, number>;
  /** True when DexScreener's own figures passed the same tests, false when they did not, null when it was not asked (dropped, over budget, or a failed call). */
  verified: boolean | null;
  /** Why it was dropped or not verified (`fake: cap 250x liquidity`, `stock token`, `failed verification: ...`); absent for a verified candidate. */
  reason?: string;
}

export interface MetaRow extends NewMetaRow {
  rank: number;
  window: MetaWindow;
  /** migrations / tokens in the ranked window. */
  migrationRate: number;
  /** tokens / migrations in the ranked window; null when none migrated. */
  createsPerMigration: number | null;
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
  // Meta redesign ticket 03: one row per subject per time it became a Meta (New Meta replaces Hot now). The old `meta_hot_events` table, where a
  // database has one, is left alone: nothing reads or writes it, so a row from before this change can never trigger anything.
  db.exec(`CREATE TABLE IF NOT EXISTS meta_new_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    raised_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    rank INTEGER NOT NULL,
    leader_mint TEXT NOT NULL,
    leader_name TEXT NOT NULL,
    leader_symbol TEXT NOT NULL,
    leader_market_cap_usd REAL NOT NULL,
    copies INTEGER NOT NULL,
    run_id INTEGER NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS meta_new_events_key ON meta_new_events (key, raised_at)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS meta_new_events_run ON meta_new_events (run_id, key)");
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
    leader_fresh_at TEXT,
    leader_source TEXT NOT NULL,
    stale INTEGER NOT NULL,
    holding INTEGER NOT NULL,
    entered_at TEXT NOT NULL,
    counts TEXT NOT NULL,
    top_tokens TEXT NOT NULL,
    named_by TEXT,
    themes TEXT,
    PRIMARY KEY (run_id, kind, rank)
  )`);
  // Meta redesign ticket 06 (ADR 0015): the grouping step's validated answers, one per Brain call, for reuse and for a replay. Additive; pruned with the runs.
  db.exec(`CREATE TABLE IF NOT EXISTS meta_groupings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    computed_at TEXT NOT NULL,
    run_id INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    source TEXT NOT NULL,
    answer TEXT NOT NULL,
    cost_usd REAL NOT NULL,
    brain_run_id INTEGER
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS meta_groupings_computed_at ON meta_groupings (computed_at)");
  // Meta redesign ticket 05 (ADR 0015): the top-down candidates of each run, kept and dropped, with the reason. Additive; pruned with the runs.
  db.exec(`CREATE TABLE IF NOT EXISTS meta_candidates (
    run_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    mint TEXT NOT NULL,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    market_cap_usd REAL,
    liquidity_usd REAL,
    volume_24h_usd REAL,
    sources TEXT NOT NULL,
    ranks TEXT NOT NULL,
    verified INTEGER,
    reason TEXT,
    PRIMARY KEY (run_id, seq)
  )`);
}

/**
 * A subject that became a Meta (New Meta): when, why, and who led it then. The label and the leader's name are creator-written (untrusted);
 * the reason is written by code ("became a Meta: $JENSEN at $2.4M, 14 creators in 24 h").
 */
export interface MetaNewEvent {
  id: number;
  key: string;
  label: string;
  raisedAt: string;
  reason: string;
  /** Its place among the Metas of the run (1 = highest leader market cap). */
  rank: number;
  leader: { mint: string; name: string; symbol: string; marketCapUsd: number };
  /** Distinct creators of the subject in the last 24 h at the time. */
  copies: number;
  runId: number;
}

export type NewMetaNewEvent = Omit<MetaNewEvent, "id">;

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

function parseStrings(text: string): string[] {
  try {
    const data: unknown = JSON.parse(text);
    return Array.isArray(data) ? data.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseRanks(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const data: unknown = JSON.parse(text);
    if (isRecord(data)) for (const [k, v] of Object.entries(data)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  } catch {
    // unreadable: no ranks
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

/** The graduations kept in a row's counts JSON beside the two windows; undefined on a row stored before graduation Metas or one that is unreadable. */
function parseGrads(text: string): CurrentGrads | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  const g = isRecord(data) ? data.grads : undefined;
  if (!isRecord(g)) return undefined;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const cov = g.coverage;
  const newest = Array.isArray(g.newest)
    ? g.newest.flatMap((t): CurrentNewest[] => (isRecord(t) && typeof t.mint === "string" ? [{ mint: t.mint, name: typeof t.name === "string" ? t.name : "", symbol: typeof t.symbol === "string" ? t.symbol : "", ...(typeof t.marketCapUsd === "number" && t.marketCapUsd > 0 ? { marketCapUsd: t.marketCapUsd } : {}) }] : []))
    : undefined;
  return {
    ...(newest && newest.length > 0 ? { newest } : {}),
    "24h": n(g["24h"]),
    "6h": n(g["6h"]),
    creators24h: n(g.creators24h),
    share: n(g.share),
    ...(isRecord(cov) ? { coverage: { covered: n(cov.covered), of: n(cov.of) } } : {}),
    ...(typeof g.sinceGap === "number" && Number.isFinite(g.sinceGap) && g.sinceGap >= 0 ? { sinceGap: g.sinceGap } : {}),
  };
}

function parseStoredAnswer(text: string): StoredGroupAnswer | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(data) || !Array.isArray(data.subjects) || !isRecord(data.refs)) return undefined;
  const subjects: StoredGroupAnswer["subjects"] = [];
  for (const s of data.subjects) {
    if (!isRecord(s) || typeof s.name !== "string" || !Array.isArray(s.items)) return undefined;
    subjects.push({ name: s.name, items: s.items.filter((x): x is string => typeof x === "string") });
  }
  const refs: Record<string, string> = {};
  for (const [k, v] of Object.entries(data.refs)) if (typeof v === "string") refs[k] = v;
  return { subjects, refs };
}

function parseThemes(text: unknown): CurrentTheme[] {
  if (typeof text !== "string") return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: CurrentTheme[] = [];
  for (const t of data) {
    if (!isRecord(t) || typeof t.key !== "string") continue;
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    out.push({ key: t.key, label: typeof t.label === "string" ? t.label : "", tokens: n(t.tokens), creators: n(t.creators) });
  }
  return out;
}

function toCurrent(r: Row, runAt: string): CurrentMeta {
  const grads = parseGrads(r.counts as string);
  return {
    key: r.key as string,
    label: r.label as string,
    namedBy: r.named_by === "ai" ? "ai" : "rules",
    themes: parseThemes(r.themes),
    leader: {
      mint: r.leader_mint as string,
      name: r.leader_name as string,
      symbol: r.leader_symbol as string,
      marketCapUsd: r.leader_market_cap_usd as number,
      ...(r.leader_created_at !== null ? { createdAt: r.leader_created_at as string } : {}),
      source: r.leader_source === "theme" ? "theme" : "trending",
      stale: r.stale === 1,
      freshAt: (r.leader_fresh_at as string | null) ?? runAt,
    },
    holding: r.holding === 1,
    enteredAt: r.entered_at as string,
    counts: parseCounts(r.counts as string),
    ...(grads ? { grads } : {}),
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
      `INSERT INTO meta_current (run_id, kind, rank, key, label, leader_mint, leader_name, leader_symbol, leader_market_cap_usd, leader_created_at, leader_fresh_at, leader_source,
         stale, holding, entered_at, counts, top_tokens, named_by, themes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertGrouping = this.db.prepare(
      `INSERT INTO meta_groupings (computed_at, run_id, input_hash, source, answer, cost_usd, brain_run_id) VALUES (?, ?, ?, 'ai', ?, ?, ?)`,
    );
    const insertCandidate = this.db.prepare(
      `INSERT INTO meta_candidates (run_id, seq, mint, name, symbol, market_cap_usd, liquidity_usd, volume_24h_usd, sources, ranks, verified, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          insertCurrent.run(id, kind, i + 1, m.key, m.label, l.mint, l.name, l.symbol, l.marketCapUsd, l.createdAt ?? null, l.freshAt, l.source, l.stale ? 1 : 0, m.holding ? 1 : 0, m.enteredAt, JSON.stringify(m.grads ? { ...m.counts, grads: m.grads } : m.counts), JSON.stringify(m.topTokens), m.namedBy ?? "rules", JSON.stringify(m.themes ?? []));
        });
      }
      if (run.grouping) insertGrouping.run(run.computedAt, id, run.grouping.inputHash, JSON.stringify(run.grouping.answer), run.grouping.costUsd, run.grouping.brainRunId);
      (run.candidates ?? []).forEach((c, i) => {
        insertCandidate.run(id, i + 1, c.mint, c.name, c.symbol, c.marketCapUsd ?? null, c.liquidityUsd ?? null, c.volume24hUsd ?? null, JSON.stringify(c.sources), JSON.stringify(c.ranks), c.verified === null ? null : c.verified ? 1 : 0, c.reason ?? null);
      });
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
    this.db.prepare("DELETE FROM meta_candidates WHERE run_id IN (SELECT id FROM meta_runs WHERE computed_at < ?)").run(cutoff);
    this.db.prepare("DELETE FROM meta_groupings WHERE run_id IN (SELECT id FROM meta_runs WHERE computed_at < ?)").run(cutoff);
    this.db.prepare("DELETE FROM meta_runs WHERE computed_at < ?").run(cutoff);
    this.db.prepare("DELETE FROM meta_summaries WHERE tried_at < ?").run(cutoff);
    this.db.prepare("DELETE FROM meta_new_events WHERE raised_at < ?").run(cutoff);
  }

  /** WORKER ONLY. Stores one New Meta event; a second event for the same subject and run is ignored (so storing a run's events twice stores them once). Returns whether it was stored. */
  saveNewMeta(e: NewMetaNewEvent): boolean {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO meta_new_events (key, label, raised_at, reason, rank, leader_mint, leader_name, leader_symbol, leader_market_cap_usd, copies, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(e.key, e.label, e.raisedAt, e.reason, e.rank, e.leader.mint, e.leader.name, e.leader.symbol, e.leader.marketCapUsd, e.copies, e.runId);
    return Number(r.changes) > 0;
  }

  /** Events raised at or after `since` (ISO), newest first. READ ONLY. */
  newMetaSince(since: string): MetaNewEvent[] {
    const rows = this.db.prepare("SELECT * FROM meta_new_events WHERE raised_at >= ? ORDER BY raised_at DESC, id DESC LIMIT 200").all(since) as Row[];
    return rows.map((r) => ({
      id: r.id as number,
      key: r.key as string,
      label: r.label as string,
      raisedAt: r.raised_at as string,
      reason: r.reason as string,
      rank: r.rank as number,
      leader: { mint: r.leader_mint as string, name: r.leader_name as string, symbol: r.leader_symbol as string, marketCapUsd: r.leader_market_cap_usd as number },
      copies: r.copies as number,
      runId: r.run_id as number,
    }));
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
   * The Metas and Watching subjects of the newest run, or of the newest run computed at or before `asOf` (ISO). Undefined before the
   * first run; a run from before ADR 0014 has the empty lists. READ ONLY.
   */
  current(asOf?: string): MetaCurrent | undefined {
    const run = (asOf === undefined
      ? this.db.prepare("SELECT id, computed_at FROM meta_runs ORDER BY computed_at DESC, id DESC LIMIT 1").get()
      : this.db.prepare("SELECT id, computed_at FROM meta_runs WHERE computed_at <= ? ORDER BY computed_at DESC, id DESC LIMIT 1").get(asOf)) as Row | undefined;
    return this.currentOf(run);
  }

  /** The Metas and Watching subjects of the run before the one with this id (the newest run computed earlier), or undefined when there is none. READ ONLY. */
  currentBefore(runId: number): MetaCurrent | undefined {
    const at = this.db.prepare("SELECT computed_at FROM meta_runs WHERE id = ?").get(runId) as Row | undefined;
    if (!at) return undefined;
    const run = this.db.prepare("SELECT id, computed_at FROM meta_runs WHERE computed_at < ? OR (computed_at = ? AND id < ?) ORDER BY computed_at DESC, id DESC LIMIT 1").get(at.computed_at as string, at.computed_at as string, runId) as Row | undefined;
    return this.currentOf(run);
  }

  private currentOf(run: Row | undefined): MetaCurrent | undefined {
    if (!run) return undefined;
    const rows = this.db.prepare("SELECT * FROM meta_current WHERE run_id = ? ORDER BY kind, rank").all(run.id as number) as Row[];
    const out: MetaCurrent = { runId: run.id as number, computedAt: run.computed_at as string, metas: [], watching: [] };
    for (const r of rows) (r.kind === "meta" ? out.metas : out.watching).push(toCurrent(r, out.computedAt));
    return out;
  }

  /** The top-down candidates a run stored, in the order stored (kept first, then dropped). READ ONLY. */
  candidates(runId: number): NewMetaCandidate[] {
    const rows = this.db.prepare("SELECT * FROM meta_candidates WHERE run_id = ? ORDER BY seq").all(runId) as Row[];
    return rows.map((r) => ({
      mint: r.mint as string,
      name: r.name as string,
      symbol: r.symbol as string,
      ...(r.market_cap_usd !== null ? { marketCapUsd: r.market_cap_usd as number } : {}),
      ...(r.liquidity_usd !== null ? { liquidityUsd: r.liquidity_usd as number } : {}),
      ...(r.volume_24h_usd !== null ? { volume24hUsd: r.volume_24h_usd as number } : {}),
      sources: parseStrings(r.sources as string),
      ranks: parseRanks(r.ranks as string),
      verified: r.verified === null ? null : r.verified === 1,
      ...(r.reason !== null ? { reason: r.reason as string } : {}),
    }));
  }

  /**
   * The newest stored grouping answer computed at or before `asOf` (default: the newest), or undefined. A row whose answer cannot be read
   * back as the stored shape is skipped, so a damaged row never reaches the pass. READ ONLY.
   */
  latestGrouping(asOf?: string): MetaGrouping | undefined {
    const rows = (
      asOf === undefined
        ? this.db.prepare("SELECT * FROM meta_groupings ORDER BY computed_at DESC, id DESC LIMIT 5").all()
        : this.db.prepare("SELECT * FROM meta_groupings WHERE computed_at <= ? ORDER BY computed_at DESC, id DESC LIMIT 5").all(asOf)
    ) as Row[];
    for (const r of rows) {
      const answer = parseStoredAnswer(r.answer as string);
      if (!answer) continue;
      return { id: r.id as number, computedAt: r.computed_at as string, runId: r.run_id as number, inputHash: r.input_hash as string, source: "ai", answer, costUsd: r.cost_usd as number, brainRunId: (r.brain_run_id as number | null) ?? null };
    }
    return undefined;
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

  /**
   * The newest run's top `limit` rows for one window, ranked; undefined before the first run. With `asOf` (ISO), the newest run computed at
   * or before it. The rows are launch themes, counts only: summaries belong to the Metas and the Watching subjects (`summaries`). READ ONLY.
   */
  latest(window: MetaWindow, limit: number, asOf?: string): MetaRun | undefined {
    const n = Math.max(0, Math.min(MAX_META_READ, Math.floor(limit)));
    const r = (asOf === undefined
      ? this.db.prepare("SELECT * FROM meta_runs ORDER BY computed_at DESC, id DESC LIMIT 1").get()
      : this.db.prepare("SELECT * FROM meta_runs WHERE computed_at <= ? ORDER BY computed_at DESC, id DESC LIMIT 1").get(asOf)) as Row | undefined;
    if (!r) return undefined;
    const rows = (this.db.prepare("SELECT * FROM meta_rows WHERE run_id = ? AND win = ? AND rank <= ? ORDER BY rank").all(r.id as number, window, n) as Row[]).map((x) => toRow(x, window));
    const windowTokens = r[`base_tokens_${window}`] as number;
    const windowMigrations = r[`base_migrations_${window}`] as number;
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
