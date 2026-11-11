import type { MetaCounts, MetaRow, MetaRun, MetaTopToken } from "./store.ts";
import type { MetaWindow } from "./config.ts";
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
  metas: MetaApiRow[];
}

/** A plain Solana address: base58, 32 to 44 characters. Anything else gets no link. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function apiToken(t: MetaTopToken): MetaApiToken {
  return t.marketCapUsd !== undefined && BASE58_ADDRESS.test(t.mint) ? { ...t, url: `https://dexscreener.com/solana/${t.mint}` } : { ...t };
}

function apiRow(row: MetaRow): MetaApiRow {
  const line = metaLine(row);
  return {
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
export function metasResponse(run: MetaRun | undefined, window: MetaWindow): MetasResponse {
  if (!run) return { window, computedAt: null, note: null, windowTokens: 0, windowMigrations: 0, baseMigrationRate: null, metas: [] };
  return {
    window,
    computedAt: run.computedAt,
    note: run.note,
    windowTokens: run.windowTokens,
    windowMigrations: run.windowMigrations,
    baseMigrationRate: run.baseMigrationRate,
    metas: run.rows.map(apiRow),
  };
}
