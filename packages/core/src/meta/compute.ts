import type { Datastore } from "../datastore.ts";
import type { DexPair } from "../sources/dexscreener.ts";
import type { LaunchedToken } from "../study/store.ts";
import { META_RULE, META_WINDOWS, META_WINDOW_HOURS, type MetaConfig, type MetaWindow, type RankKey } from "./config.ts";
import { metaCoverage } from "./coverage.ts";
import { cleanLabel, groupTokens, type TokenGroup } from "./group.ts";
import { trendingCandidates, type TrendingCandidate } from "./candidates.ts";
import { carriedState, currentMetas, type LeaderSubject, type LeaderToken, type PreviousMetas } from "./leaders.ts";
import type { MetaCounts, MetaTopToken, NewMetaCurrent, NewMetaRow, NewMetaRun } from "./store.ts";
import { mergeThemes } from "./theme.ts";

/**
 * The Meta recompute (ticket 03, slice 3): reads the last 24 h of launchpad creates from the Study, groups them into clone clusters
 * (slice 1), counts distinct tokens, creators and migrations per group for the 6 h and 24 h windows, asks DexScreener for the market
 * cap of the top groups within a call budget, ranks by the rule in `config.ts`, and stores the run. Plain code, no LLM.
 *
 * Order of work matters for the database: the read, the grouping and the network calls all happen before one short insert
 * transaction (`MetaStore.saveRun`), so no write lock is held while DexScreener answers.
 */

/** The one DexScreener method this job needs; `DexScreenerClient` satisfies it, tests pass a counting fake. */
export interface MetaDexClient {
  tokenPairs(chainId: string, addresses: string[]): Promise<DexPair[]>;
}

export interface RecomputeOptions {
  /** The as-of time (default now). A replay passes a past time; tokens created or migrated after it are ignored. */
  now?: Date;
  /** Without a client no market cap is looked up and the ranking runs on counts alone. */
  dex?: MetaDexClient;
  config?: MetaConfig;
  log?: (message: string) => void;
}

export interface RecomputeResult {
  runId: number;
  computedAt: string;
  tokensRead: number;
  groups: number;
  dexCalls: number;
  /** Total DexScreener calls and failures of the run (theme and leader lookups together). */
  dexFailures: number;
  /** Of `dexCalls`, the calls that looked up the leaders' market caps. */
  leaderCalls: number;
  /** How many Metas and Watching subjects the run stored (ADR 0014). */
  metas: number;
  watching: number;
  current: NewMetaCurrent;
}

export const META_NOTE =
  "Counts are a cohort: tokens created in the window, with migrations seen by the as-of time, so a short window under-counts slow migrators. " +
  "Migrations are unfiltered (PumpPortal receipt time, bot filter not built); migrationsAfter60s is the crude organic proxy. " +
  "Market cap comes from DexScreener for the top groups only and is absent where no lookup answered.";

const HOUR_MS = 3_600_000;

/** The market-cap lookups of one run stop after this many failures in a row (an outage or a 429 would otherwise cost every timeout). */
const DEX_MAX_CONSECUTIVE_FAILURES = 3;

/** One `tokenPairs` call takes at most this many addresses (`dexscreener.ts` MAX_LOOKUP). */
const LOOKUP_BATCH = 30;

interface Rec {
  token: LaunchedToken;
  createdMs: number;
  /** Null when not migrated by the as-of time. */
  migratedMs: number | null;
}

interface GroupStat {
  group: TokenGroup<LaunchedToken>;
  recs: Rec[];
  firstSeenAt: string;
  counts: Record<MetaWindow, MetaCounts>;
  /** Market cap per looked-up mint. */
  caps: Map<string, number>;
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The value a key ranks on; undefined only for an absent market cap. */
function rankValue(s: GroupStat, window: MetaWindow, key: RankKey): number | undefined {
  const c = s.counts[window];
  switch (key) {
    case "creators": return c.creators;
    case "migrations": return c.migrations;
    case "migrationsAfter60s": return c.migrationsAfter60s;
    case "tokens": return c.tokens;
    case "marketCapUsd": return summedCap(s);
  }
}

/** The group's market cap: the sum of its three highest looked-up tokens; undefined when no token has a figure. */
function summedCap(s: GroupStat, top = 3): number | undefined {
  if (s.caps.size === 0) return undefined;
  return [...s.caps.values()].sort((a, b) => b - a).slice(0, top).reduce((x, y) => x + y, 0);
}

/**
 * The ranking comparator: each key in `rankOrder` descending, an absent value after any present one (so a missing market cap neither
 * drops a group nor counts as 0), then the group key so equal groups never depend on input order.
 */
function compareStats(window: MetaWindow, order: readonly RankKey[]) {
  return (a: GroupStat, b: GroupStat): number => {
    for (const key of order) {
      const x = rankValue(a, window, key);
      const y = rankValue(b, window, key);
      if (x === y) continue;
      if (x === undefined) return 1;
      if (y === undefined) return -1;
      return y - x;
    }
    return cmpStr(a.group.key, b.group.key);
  };
}

function countsFor(recs: Rec[], fromMs: number, organicAfterSec: number): MetaCounts {
  const creators = new Set<string>();
  let tokens = 0;
  let migrations = 0;
  let after = 0;
  for (const r of recs) {
    if (r.createdMs < fromMs) continue;
    tokens++;
    if (r.token.creator !== "") creators.add(r.token.creator);
    if (r.migratedMs !== null) {
      migrations++;
      if (r.migratedMs - r.createdMs > organicAfterSec * 1000) after++;
    }
  }
  return { tokens, creators: creators.size, migrations, migrationsAfter60s: after };
}

/** Lookup candidates of a group: migrated tokens first (they have pools), then the earliest creates; at most `limit`. */
function candidates(s: GroupStat, limit: number): string[] {
  return [...s.recs]
    .sort((a, b) => (a.migratedMs === null ? 1 : 0) - (b.migratedMs === null ? 1 : 0) || a.createdMs - b.createdMs || cmpStr(a.token.mint, b.token.mint))
    .slice(0, limit)
    .map((r) => r.token.mint);
}

/** The tokens a row shows: highest market cap first where known, then migrated, then earliest create. */
function topTokensOf(s: GroupStat, n: number): MetaTopToken[] {
  const rank = (r: Rec) => s.caps.get(r.token.mint);
  return [...s.recs]
    .sort((a, b) => {
      const x = rank(a);
      const y = rank(b);
      if (x !== y) return x === undefined ? 1 : y === undefined ? -1 : y - x;
      return (a.migratedMs === null ? 1 : 0) - (b.migratedMs === null ? 1 : 0) || a.createdMs - b.createdMs || cmpStr(a.token.mint, b.token.mint);
    })
    .slice(0, n)
    .map((r) => {
      const cap = rank(r);
      return { mint: r.token.mint, name: cleanLabel(r.token.name), symbol: cleanLabel(r.token.symbol), ...(cap !== undefined ? { marketCapUsd: cap } : {}) };
    });
}

export async function recomputeMetas(store: Datastore, opts: RecomputeOptions = {}): Promise<RecomputeResult> {
  const config = opts.config ?? META_RULE;
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const windowFrom = (w: MetaWindow) => nowMs - META_WINDOW_HOURS[w] * HOUR_MS;

  // 1. Read (one indexed pass) and shape.
  const tokens = store.study.createdBetween(new Date(windowFrom("24h")).toISOString(), now.toISOString());
  const recs = new Map<string, Rec>();
  for (const token of tokens) {
    const migratedMs = token.migratedAt !== null ? Date.parse(token.migratedAt) : Number.NaN;
    recs.set(token.mint, { token, createdMs: Date.parse(token.createdAt), migratedMs: migratedMs <= nowMs ? migratedMs : null }); // NaN (never migrated) is not <= nowMs
  }

  // 2. The run's base rate: every token created in the window, all groups together.
  const base = {} as NewMetaRun["base"];
  for (const w of META_WINDOWS) {
    let created = 0;
    let migrated = 0;
    for (const r of recs.values()) {
      if (r.createdMs < windowFrom(w)) continue;
      created++;
      if (r.migratedMs !== null) migrated++;
    }
    base[w] = { tokens: created, migrations: migrated };
  }

  // 3. Group and count.
  const clones = groupTokens(tokens);
  const stats: GroupStat[] = (config.theme ? mergeThemes(clones, config.theme) : clones).map((group) => {
    const grecs = group.tokens.map((t) => recs.get(t.mint) as Rec);
    let first = Number.POSITIVE_INFINITY;
    for (const r of grecs) first = Math.min(first, r.createdMs);
    return {
      group,
      recs: grecs,
      firstSeenAt: new Date(first).toISOString(),
      counts: {
        "6h": countsFor(grecs, windowFrom("6h"), config.organicAfterSec),
        "24h": countsFor(grecs, windowFrom("24h"), config.organicAfterSec),
      },
      caps: new Map(),
    };
  });

  // The size floor (ticket 05): a Meta needs enough tokens and enough distinct creators in that window. Applied here, once, before the
  // DexScreener budget and the ranking, so the stored rows, the API, the pages and the prompt block never see a smaller group.
  const eligible = (w: MetaWindow) => stats.filter((s) => s.counts[w].tokens >= config.minTokens && s.counts[w].creators >= config.minCreators);

  // 4. Market cap for the top groups, by the ranking without it, within the call budget. A group in both windows costs one call.
  let dexCalls = 0;
  let dexFailures = 0;
  if (opts.dex && config.dexGroups > 0 && config.dexMaxCalls > 0) {
    const wanted: GroupStat[] = [];
    const tops = META_WINDOWS.map((w) => eligible(w).sort(compareStats(w, config.rankOrder)).slice(0, config.dexGroups));
    for (let i = 0; i < config.dexGroups; i++)
      for (const top of tops) {
        const s = top[i];
        if (s && !wanted.includes(s)) wanted.push(s);
      }
    let streak = 0;
    for (const s of wanted.slice(0, config.dexMaxCalls)) {
      if (streak >= DEX_MAX_CONSECUTIVE_FAILURES) break; // DexScreener is down or limiting us: stop for this run, the rest keep no market cap
      dexCalls++;
      const mints = candidates(s, config.dexCandidates);
      try {
        const asked = new Set(mints);
        for (const p of await opts.dex.tokenPairs("solana", mints)) {
          if (!asked.has(p.tokenAddress) || p.marketCapUsd === undefined || !(p.marketCapUsd > 0)) continue;
          s.caps.set(p.tokenAddress, Math.max(s.caps.get(p.tokenAddress) ?? 0, p.marketCapUsd));
        }
        streak = 0;
      } catch (e) {
        dexFailures++;
        streak++;
        opts.log?.(`[meta] DexScreener lookup failed for ${s.group.key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // 4b. The market-led Metas (ADR 0014): leaders by current market cap, from the theme lookups above, the trending Signals and last run's leaders.
  const previous = store.meta.current(now.toISOString());
  const carried = carriedState(previous, now, config.stateMaxMinutes);
  const fresh: LeaderToken[] = [];
  for (const s of stats)
    for (const [mint, cap] of s.caps) {
      const rec = recs.get(mint);
      if (rec) fresh.push({ mint, name: cleanLabel(rec.token.name), symbol: cleanLabel(rec.token.symbol), marketCapUsd: cap, createdAt: rec.token.createdAt, source: "theme", stale: false, groupKey: s.group.key });
    }
  const trending = trendingCandidates(store.meta.trendingSignals(new Date(windowFrom("24h")).toISOString(), now.toISOString()));
  const lookedUp = await lookUpLeaders({ dex: opts.dex, config, log: opts.log, have: new Set(fresh.map((t) => t.mint)), previous: carried, trending });
  fresh.push(...lookedUp.tokens);
  dexCalls += lookedUp.calls;
  dexFailures += lookedUp.failures;
  const prevKeys = new Set((carried?.metas ?? []).map((m) => m.key));
  const subjects: LeaderSubject[] = stats
    .filter((s) => s.counts["24h"].creators >= config.minCopies || prevKeys.has(s.group.key))
    .map((s) => ({ key: s.group.key, label: s.group.label, counts: s.counts, topTokens: topTokensOf(s, config.topTokens), tokens: s.group.tokens }));
  const current = currentMetas({ subjects, tokens: fresh, previous: carried, now, config });

  // 5. Rank each window and shape the rows.
  const rows = {} as NewMetaRun["rows"];
  for (const w of META_WINDOWS) {
    rows[w] = eligible(w)
      .sort(compareStats(w, config.rankOrder))
      .slice(0, config.maxRowsPerWindow)
      .map((s): NewMetaRow => {
        const top = topTokensOf(s, config.topTokens);
        const capped = top.flatMap((t) => (t.marketCapUsd !== undefined ? [t.marketCapUsd] : []));
        return {
          key: s.group.key,
          label: s.group.label,
          firstSeenAt: s.firstSeenAt,
          counts: s.counts,
          topTokens: top,
          ...(capped.length > 0 ? { topMarketCapUsd: capped[0] as number, marketCapUsd: capped.reduce((a, b) => a + b, 0) } : {}),
        };
      });
  }

  // 6. One short write transaction: the inserts, then the prune.
  const computedAt = now.toISOString();
  const coverage = metaCoverage(tokens.map((t) => Date.parse(t.createdAt)), nowMs, config.coverageMinCreates);
  const runId = store.meta.saveRun({ computedAt, note: META_NOTE, rule: config, dexCalls, dexFailures, base, rows, coverage, current });
  return { runId, computedAt, tokensRead: tokens.length, groups: stats.length, dexCalls, dexFailures, leaderCalls: lookedUp.calls, metas: current.metas.length, watching: current.watching.length, current };
}

interface LeaderLookupInput {
  dex: MetaDexClient | undefined;
  config: MetaConfig;
  log: ((message: string) => void) | undefined;
  /** Mints whose market cap this run already has (the theme lookups): not asked again. */
  have: ReadonlySet<string>;
  previous: PreviousMetas | undefined;
  trending: readonly TrendingCandidate[];
}

/**
 * The leaders' current market caps within `config.leaderCalls` calls of up to 30 tokens each. Order: last run's leaders first (a Meta is
 * never lost to the budget), then trending tokens by the figure stored on their Signal (highest first), then the rest. A token DexScreener
 * did not answer, or a call that failed or fell outside the budget, simply yields no token here; `currentMetas` carries a previous leader at
 * its last figure and never creates a Meta from it. Three failed calls in a row end the lookups of the run.
 */
async function lookUpLeaders(input: LeaderLookupInput): Promise<{ tokens: LeaderToken[]; calls: number; failures: number }> {
  const out = { tokens: [] as LeaderToken[], calls: 0, failures: 0 };
  const { dex, config } = input;
  if (!dex || config.leaderCalls <= 0) return out;
  interface Known {
    name: string;
    symbol: string;
    source: "trending" | "theme";
    createdAt?: string;
  }
  const known = new Map<string, Known>();
  const order: string[] = [];
  const want = (mint: string, k: Known) => {
    if (input.have.has(mint) || known.has(mint)) return;
    known.set(mint, k);
    order.push(mint);
  };
  for (const row of [...(input.previous?.metas ?? []), ...(input.previous?.watching ?? [])]) {
    const l = row.leader;
    want(l.mint, { name: l.name, symbol: l.symbol, source: l.source, ...(l.createdAt !== undefined ? { createdAt: l.createdAt } : {}) });
  }
  const byStoredCap = (a: TrendingCandidate, b: TrendingCandidate) => (b.storedCapUsd ?? -1) - (a.storedCapUsd ?? -1) || cmpStr(a.mint, b.mint);
  for (const c of [...input.trending].sort(byStoredCap)) want(c.mint, { name: c.name, symbol: c.symbol, source: "trending", ...(c.createdAt !== undefined ? { createdAt: c.createdAt } : {}) });

  let streak = 0;
  for (let at = 0, n = 0; at < order.length && n < config.leaderCalls; at += LOOKUP_BATCH, n++) {
    if (streak >= DEX_MAX_CONSECUTIVE_FAILURES) break;
    const mints = order.slice(at, at + LOOKUP_BATCH);
    out.calls++;
    try {
      const best = new Map<string, { cap: number; createdMs?: number }>();
      const asked = new Set(mints);
      for (const p of await dex.tokenPairs("solana", mints)) {
        if (!asked.has(p.tokenAddress) || p.marketCapUsd === undefined || !(p.marketCapUsd > 0)) continue;
        const cur = best.get(p.tokenAddress);
        const createdMs = p.pairCreatedAt !== undefined && p.pairCreatedAt > 0 ? p.pairCreatedAt : undefined;
        best.set(p.tokenAddress, { cap: Math.max(cur?.cap ?? 0, p.marketCapUsd), ...(cur?.createdMs !== undefined || createdMs !== undefined ? { createdMs: Math.min(cur?.createdMs ?? Infinity, createdMs ?? Infinity) } : {}) });
      }
      for (const [mint, b] of best) {
        const k = known.get(mint) as Known;
        const created = k.createdAt ?? (b.createdMs !== undefined && Number.isFinite(new Date(b.createdMs).getTime()) ? new Date(b.createdMs).toISOString() : undefined);
        out.tokens.push({ mint, name: k.name, symbol: k.symbol, marketCapUsd: b.cap, ...(created !== undefined ? { createdAt: created } : {}), source: k.source, stale: false });
      }
      streak = 0;
    } catch (e) {
      out.failures++;
      streak++;
      input.log?.(`[meta] DexScreener leader lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
