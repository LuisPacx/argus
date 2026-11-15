import type { Proposal } from "../datastore.ts";
import type { MemeIdeaRef } from "../meme/types.ts";
import type { MetaCounts, MetaRow, MetaRun, MetaTopToken } from "./store.ts";
import { META_RULE, type MetaWindow } from "./config.ts";
import { coverageNote, type MetaCoverage } from "./coverage.ts";
import { metaLine, type MetaSummarySource } from "./summary.ts";

/**
 * The read-only Meta API (ticket 03, slice 4): the stored latest run in the shape the War Room renders, so the page computes nothing.
 * Every string is creator-written or model text and travels as JSON text only; it is never markup.
 */

export interface MetaApiToken extends MetaTopToken {
  /** The token's DexScreener page; only for a token DexScreener answered for (it has a market cap) and whose mint is a plain address. */
  url?: string;
}

export interface MetaApiRow {
  rank: number;
  label: string;
  firstSeenAt: string;
  /** Both windows' counts. `migrations` is unfiltered (PumpPortal receipt time, no bot filter); `migrationsAfter60s` is the crude organic proxy. */
  counts: Record<MetaWindow, MetaCounts>;
  /** migrations / tokens in the ranked window. */
  migrationRate: number;
  /** tokens / migrations in the ranked window; null when none migrated. */
  createsPerMigration: number | null;
  topTokens: MetaApiToken[];
  /** Summed market cap of the top tokens that have one; absent when none has. */
  marketCapUsd?: number;
  /** The one-line summary: the stored LLM line, else the templated numbers line. Untrusted text. */
  summary: string;
  summarySource: MetaSummarySource;
  /** Present while the Meta's Hot now event is live (raised within the cool-down): why and when. */
  hot?: HotMark;
  /** The Meta's live meme ideas (`new` or `shortlisted` Proposals of kind meme), newest first (missed ideas ticket 06). Absent when it has none. */
  ideas?: MemeIdeaRef[];
}

/** Why a Meta is marked hot and when it was raised. `reason` is written by code. */
export interface HotMark {
  reason: string;
  raisedAt: string;
}

export interface MetasResponse {
  window: MetaWindow;
  /** The run's as-of time; null before the first run. */
  computedAt: string | null;
  /** What the figures are and are not (cohort, unfiltered); null before the first run. */
  note: string | null;
  /** Tokens created in the window, all groups together, and how many of them migrated (unfiltered). */
  windowTokens: number;
  windowMigrations: number;
  baseMigrationRate: number | null;
  /** Covered hours of each window at the run; null for an old run or before the first run. */
  coverage: MetaCoverage | null;
  /** "Only 1 h of data in the last 24 h" for the response's window when it is thinly covered; null otherwise. */
  coverageNote: string | null;
  metas: MetaApiRow[];
}

/** A plain Solana address: base58, 32 to 44 characters. Anything else gets no link. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function apiToken(t: MetaTopToken): MetaApiToken {
  return t.marketCapUsd !== undefined && BASE58_ADDRESS.test(t.mint) ? { ...t, url: `https://dexscreener.com/solana/${t.mint}` } : { ...t };
}

/** One stored row in the shape the War Room renders; `hot` is set while the Meta's Hot now event is live, `ideas` when it has live meme ideas. */
export function apiRow(row: MetaRow, hot?: HotMark, ideas?: readonly MemeIdeaRef[]): MetaApiRow {
  const line = metaLine(row);
  return {
    ...(hot ? { hot } : {}),
    ...(ideas && ideas.length > 0 ? { ideas: [...ideas] } : {}),
    rank: row.rank,
    label: row.label,
    firstSeenAt: row.firstSeenAt,
    counts: row.counts,
    migrationRate: row.migrationRate,
    createsPerMigration: row.createsPerMigration,
    topTokens: row.topTokens.map(apiToken),
    ...(row.marketCapUsd !== undefined ? { marketCapUsd: row.marketCapUsd } : {}),
    summary: line.summary,
    summarySource: line.summarySource,
  };
}

/** The response for a window: the stored run, or an empty list (not an error) before the first run. */
export function metasResponse(
  run: MetaRun | undefined,
  window: MetaWindow,
  noteBelow: number = META_RULE.coverageNoteBelow,
  hot: ReadonlyMap<string, HotMark> = new Map(),
  ideas: ReadonlyMap<string, readonly MemeIdeaRef[]> = new Map(),
): MetasResponse {
  if (!run) return { window, computedAt: null, note: null, windowTokens: 0, windowMigrations: 0, baseMigrationRate: null, coverage: null, coverageNote: null, metas: [] };
  return {
    window,
    computedAt: run.computedAt,
    note: run.note,
    windowTokens: run.windowTokens,
    windowMigrations: run.windowMigrations,
    baseMigrationRate: run.baseMigrationRate,
    coverage: run.coverage,
    coverageNote: coverageNote(run.coverage, window, noteBelow),
    metas: run.rows.map((r) => apiRow(r, hot.get(r.key), ideas.get(r.key))),
  };
}

/** The live meme Proposals grouped by their Meta's key, as the Meta list shows them (newest first; the input is already in that order). */
export function memeIdeasByKey(live: readonly Proposal[]): Map<string, MemeIdeaRef[]> {
  const out = new Map<string, MemeIdeaRef[]>();
  for (const p of live) {
    if (p.kind !== "meme" || p.metaKey === null || (p.status !== "new" && p.status !== "shortlisted")) continue;
    const list = out.get(p.metaKey) ?? [];
    list.push({ id: p.id, name: p.name, ticker: p.ticker, angle: p.whyNow, status: p.status, riskLabels: p.meme?.riskLabels ?? [], createdAt: p.createdAt, expiresAt: p.expiresAt });
    out.set(p.metaKey, list);
  }
  return out;
}
