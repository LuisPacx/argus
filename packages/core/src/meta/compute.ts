import type { Datastore } from "../datastore.ts";
import type { DexPair } from "../sources/dexscreener.ts";
import type { GraduatedToken, LaunchedToken } from "../study/store.ts";
import { META_RULE, META_WINDOWS, META_WINDOW_HOURS, type MetaConfig, type MetaWindow, type RankKey } from "./config.ts";
import { isThin, metaCoverage } from "./coverage.ts";
import { cleanLabel, groupTokens, isGenericKey, type TokenGroup } from "./group.ts";
import { subjectKey } from "./key.ts";
import { applyGrouping, buildGroupItems, GROUP_MAX_THEMES, itemsHash, storeAnswer, type GroupAnswer, type GroupInput, type GroupItem, type ThemeInput, type TrendingInput } from "./grouping.ts";
import { carriedState, currentMetas, type LeaderSubject, type LeaderToken, type PreviousMetas } from "./leaders.ts";
import type { MetaCounts, MetaTopToken, NewMetaCandidate, NewMetaCurrent, NewMetaGrouping, NewMetaRow, NewMetaRun } from "./store.ts";
import { mergeThemes } from "./theme.ts";
import { assignGraduates } from "./graduates.ts";
import { verifyAgainstDex, verifyThemeToken, type DroppedCandidate, type TopDownCandidate, type TopDownResult } from "./topdown.ts";

/**
 * The Meta recompute (ticket 03, slice 3): reads the last 24 h of launchpad creates from the Study, groups them into clone clusters
 * (slice 1), counts distinct tokens, creators and migrations per group for the 6 h and 24 h windows, asks DexScreener for the market
 * cap of the top groups within a call budget, ranks by the rule in `config.ts`, and stores the run. Plain code, no LLM.
 *
 * Order of work matters for the database: the read, the grouping and the network calls all happen before one short insert
 * transaction (`MetaStore.saveRun`), so no write lock is held while DexScreener or the trending lists answer.
 *
 * A Meta is several tokens graduating on one narrative (graduation Meta ticket 01): the subjects are the AI-grouped launch themes, each
 * graduate (`study.graduatedBetween`) joins one subject (`graduates.ts`), and `leaders.ts` decides the Metas on the graduation counts alone.
 * Market caps are display: the worker passes `topDown` (Jupiter's and GeckoTerminal's trending lists, fakes and tokenized stocks filtered
 * out, DexScreener verifying what survives) so a big token can lead the subject it names; it never makes a Meta. The stored counts of a
 * subject count bonk launches as well (ADR 0015 decision 3).
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
  /**
   * Reads the top-down leader candidates (ADR 0015). Awaited before the write transaction. Without it, or when it throws or takes longer
   * than `topDownTimeoutMs`, the tick has no top-down candidates, says so once in the log, and carries on with the previous leaders and
   * the launch themes. A replay passes none.
   */
  topDown?: () => Promise<TopDownResult>;
  /** The overall bound on `topDown` (default 20 s). */
  topDownTimeoutMs?: number;
  /**
   * The AI grouping step (ADR 0015, decision 4; meta redesign ticket 06): given the tick's items (the trending tokens that passed the filter at
   * the entry cap, and the top launch themes), answers with the checked subjects, or with nothing. Awaited before the write transaction, within
   * `groupTimeoutMs`; it never throws into the tick: nothing, a refusal, a timeout or an error all mean the tick groups by rules. The worker
   * builds it around the Brain (`createGroupStep`); a replay or a test passes none or a fake.
   */
  group?: (input: GroupInput) => Promise<GroupAnswer | undefined>;
  /** The overall bound on `group` (default 90 s). */
  groupTimeoutMs?: number;
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
  /** The top-down reads of the run (ADR 0015): requests to the two lists, candidates kept and dropped, and what failed. All zero without `topDown`. */
  topDown: { requests: number; kept: number; dropped: number; errors: string[] };
  /** How many Metas and Watching subjects the run stored (ADR 0014). */
  metas: number;
  watching: number;
  current: NewMetaCurrent;
  /** How the subjects were grouped and named this tick (ticket 06): by the AI step (an answer called for or reused) or by rules, and how many subjects the answer built. */
  group: { source: "ai" | "rules"; reused: boolean; subjects: number };
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

/** The overall bound on the top-down read of one tick: three pages and a Jupiter list with their retries fit well inside it. */
const TOPDOWN_TIMEOUT_MS = 20_000;

/** The overall bound on the grouping step of one tick (a haiku run of a short list; the route's own cap is 2 minutes). */
const GROUP_TIMEOUT_MS = 90_000;

/** How DexScreener's check of one top-down candidate went: passed, failed (with the test), or not done (with why). */
interface Verdict {
  verified: boolean | null;
  reason?: string;
}

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
  /** Creates of the pump launchpad only: the launch-theme rows, the size floor and the ranking read these. */
  counts: Record<MetaWindow, MetaCounts>;
  /** Creates of the pump and bonk launchpads: the copies rule of the Metas, and the counts a Meta or Watching row stores (ADR 0015 decision 3). */
  copies: Record<MetaWindow, MetaCounts>;
  /** The bonk creates attached to the group (they are part of `copies` only). */
  bonkRecs: Rec[];
  /** Market cap per looked-up mint. */
  caps: Map<string, number>;
}

/**
 * Hands each bonk create to the group of pump creates that already holds a token with one of its subject keys. A bonk token whose keys name no
 * group, or two groups, joins none: a subject without a launch-theme member has no copiers (ADR 0015), and the groups themselves are the
 * ones the launch-theme rows show, so they never change with bonk creates in the store.
 */
function attachBonk(groups: readonly TokenGroup<LaunchedToken>[], bonk: readonly LaunchedToken[]): Map<number, LaunchedToken[]> {
  const out = new Map<number, LaunchedToken[]>();
  if (bonk.length === 0) return out;
  const usable = (t: LaunchedToken) => subjectKey(t.name, t.symbol).filter((k) => !isGenericKey(k));
  const owner = new Map<string, number>();
  const AMBIGUOUS = -1;
  groups.forEach((g, i) => {
    for (const t of g.tokens)
      for (const k of usable(t)) {
        const cur = owner.get(k);
        if (cur === undefined) owner.set(k, i);
        else if (cur !== i) owner.set(k, AMBIGUOUS);
      }
  });
  for (const t of bonk) {
    const hits = new Set<number>();
    for (const k of usable(t)) {
      const g = owner.get(k);
      if (g !== undefined && g !== AMBIGUOUS) hits.add(g);
    }
    if (hits.size !== 1) continue;
    const i = [...hits][0] as number;
    const list = out.get(i);
    if (list) list.push(t);
    else out.set(i, [t]);
  }
  return out;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => void (timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
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

function countsFor(recs: readonly Rec[], fromMs: number, organicAfterSec: number): MetaCounts {
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

/**
 * Lookup candidates of a group: the newest graduates first (they have pools, and a wave's newest are the ones still trading; the oldest 30
 * of a big group were the stale ones), then the earliest creates; at most `limit`.
 */
function candidates(s: GroupStat, limit: number): string[] {
  return [...s.recs]
    .sort((a, b) => (a.migratedMs === null ? 1 : 0) - (b.migratedMs === null ? 1 : 0) || (b.migratedMs ?? 0) - (a.migratedMs ?? 0) || a.createdMs - b.createdMs || cmpStr(a.token.mint, b.token.mint))
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
  // One read: the pump creates feed everything the launch themes show; the bonk creates only join a subject's copiers (step 3).
  const everyone = store.study.createdBetween(new Date(windowFrom("24h")).toISOString(), now.toISOString(), { includeBonk: true });
  const tokens = everyone.filter((t) => t.pool !== "bonk");
  const bonk = everyone.filter((t) => t.pool === "bonk");
  // The graduations of the same window, by graduation time: a late graduate of an old create counts, a bonk launch has no receipt and never does.
  const graduated = store.study.graduatedBetween(new Date(windowFrom("24h")).toISOString(), now.toISOString());
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
  const grouped = config.theme ? mergeThemes(clones, config.theme) : clones;
  const bonkOf = attachBonk(grouped, bonk);
  const countsOf = (list: readonly Rec[]): Record<MetaWindow, MetaCounts> => ({
    "6h": countsFor(list, windowFrom("6h"), config.organicAfterSec),
    "24h": countsFor(list, windowFrom("24h"), config.organicAfterSec),
  });
  const stats: GroupStat[] = grouped.map((group, gi) => {
    const grecs = group.tokens.map((t) => recs.get(t.mint) as Rec);
    let first = Number.POSITIVE_INFINITY;
    for (const r of grecs) first = Math.min(first, r.createdMs);
    const counts = countsOf(grecs);
    const bonkRecs = (bonkOf.get(gi) ?? []).map((token): Rec => ({ token, createdMs: Date.parse(token.createdAt), migratedMs: null }));
    return {
      group,
      recs: grecs,
      firstSeenAt: new Date(first).toISOString(),
      counts,
      copies: bonkRecs.length > 0 ? countsOf([...grecs, ...bonkRecs]) : counts,
      bonkRecs,
      caps: new Map(),
    };
  });
  /**
   * One subject's stat from the launch themes the grouping step put together: its tokens are the union of theirs (one creator who launched in
   * three themes counts once), its counts and top tokens are computed again from that union, and its caps are theirs. Nothing here reads
   * the model's words but the name.
   */
  const mergeStats = (members: GroupStat[], key: string, label: string): GroupStat => {
    const recs = members.flatMap((m) => m.recs);
    const bonkRecs = members.flatMap((m) => m.bonkRecs);
    const caps = new Map<string, number>();
    for (const m of members) for (const [mint, cap] of m.caps) caps.set(mint, Math.max(caps.get(mint) ?? 0, cap));
    const counts = countsOf(recs);
    return {
      group: { key, label, tokens: members.flatMap((m) => m.group.tokens) },
      recs,
      firstSeenAt: new Date(Math.min(...members.map((m) => Date.parse(m.firstSeenAt)))).toISOString(),
      counts,
      copies: bonkRecs.length > 0 ? countsOf([...recs, ...bonkRecs]) : counts,
      bonkRecs,
      caps,
    };
  };

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
        const byMint = new Map<string, DexPair[]>();
        for (const p of await opts.dex.tokenPairs("solana", mints)) {
          if (!asked.has(p.tokenAddress)) continue;
          const list = byMint.get(p.tokenAddress);
          if (list) list.push(p);
          else byMint.set(p.tokenAddress, [p]);
        }
        // A theme's own token is priced without the $50k liquidity and volume floors (a fresh graduate rarely has them); the cap-to-liquidity
        // test stays, so a fake cap still has no figure here (graduation Meta ticket 01).
        for (const [mint, pairs] of byMint) {
          const verdict = verifyThemeToken(pairs, config);
          if (verdict.ok && verdict.marketCapUsd !== undefined) s.caps.set(mint, Math.max(s.caps.get(mint) ?? 0, verdict.marketCapUsd));
        }
        streak = 0;
      } catch (e) {
        dexFailures++;
        streak++;
        opts.log?.(`[meta] DexScreener lookup failed for ${s.group.key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // 4a. The top-down candidates (ADR 0015): the two trending lists, filtered. Read before the write transaction; never fatal.
  let topDown: TopDownResult = { candidates: [], dropped: [], requests: 0, errors: [] };
  if (opts.topDown) {
    try {
      topDown = await withTimeout(opts.topDown(), opts.topDownTimeoutMs ?? TOPDOWN_TIMEOUT_MS);
      if (topDown.errors.length > 0) opts.log?.(`[meta] top-down sources failed: ${topDown.errors.join("; ")}`);
    } catch (e) {
      opts.log?.(`[meta] top-down sources failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 4b. The market-led Metas (ADR 0014): leaders by current market cap, from the theme lookups above, the top-down candidates and last run's leaders.
  const previous = store.meta.current(now.toISOString());
  const carried = carriedState(previous, now, config.stateMaxMinutes);
  const fresh: LeaderToken[] = [];
  for (const s of stats)
    for (const [mint, cap] of s.caps) {
      const rec = recs.get(mint);
      if (rec) fresh.push({ mint, name: cleanLabel(rec.token.name), symbol: cleanLabel(rec.token.symbol), marketCapUsd: cap, createdAt: rec.token.createdAt, source: "theme", stale: false, freshAt: now.toISOString(), groupKey: s.group.key });
    }
  const lookedUp = await lookUpLeaders({ dex: opts.dex, config, now: now.toISOString(), log: opts.log, have: new Set(fresh.map((t) => t.mint)), previous: carried, candidates: topDown.candidates });
  fresh.push(...lookedUp.tokens);
  dexCalls += lookedUp.calls;
  dexFailures += lookedUp.failures;

  // 4c. The AI grouping step (ticket 06, ADR 0015 decision 4): the trending tokens that passed the filter at the entry cap and the top launch
  // themes go to it as ids; its checked answer says which belong together and what to call them. Awaited before the write transaction, bounded,
  // and never fatal: with no answer the subjects below are the launch themes as the creator vote named them.
  const items = buildGroupItems(trendingInputs(topDown, fresh, lookedUp.verdicts), themeInputs(stats), config.enterMcapUsd);
  const answer = await askGroupStep(opts, items, now);
  const statOf = new Map(stats.map((s) => [s.group.key, s]));
  const applied = answer ? applyGrouping(items, answer.subjects, (key) => statOf.get(key), mergeStats) : undefined;
  // The stored counts of a Meta include bonk launches; the launch-theme rows below keep the pump counts.
  const subjectStats: Array<{ stat: GroupStat; extra: Pick<LeaderSubject, "namedBy" | "memberKeys" | "memberMints" | "themes"> }> = [
    ...(applied?.subjects ?? []).map((a) => ({ stat: a.stat, extra: { namedBy: "ai" as const, memberKeys: a.themeKeys, memberMints: a.mints, themes: a.themes } })),
    ...stats.filter((s) => !applied?.groupedThemeKeys.has(s.group.key)).map((stat) => ({ stat, extra: { namedBy: "rules" as const } })),
  ];
  // The graduations (graduation Meta ticket 01): each graduate joins the subject that holds its create, or the one its name and ticker name.
  // A create-less graduate is matched only to subjects with a graduate of their own or enough creators to be a theme at all.
  const mintSubject = new Map<string, number>();
  subjectStats.forEach(({ stat }, j) => {
    for (const t of stat.group.tokens) mintSubject.set(t.mint, j);
  });
  const hasGraduate = new Set(graduated.flatMap((g) => (mintSubject.has(g.mint) ? [mintSubject.get(g.mint) as number] : [])));
  const assigned = assignGraduates({
    subjects: subjectStats.map(({ stat, extra }) => ({ key: stat.group.key, label: stat.group.label, tokens: stat.group.tokens, ...(extra.memberKeys ? { memberKeys: extra.memberKeys } : {}) })),
    graduates: graduated,
    mintSubject,
    nameable: (j) => hasGraduate.has(j) || (subjectStats[j] as (typeof subjectStats)[number]).stat.counts["24h"].creators >= config.metaMinCreators,
    nowMs,
    minKeyChars: config.newsMinKeyChars,
  });
  // A thin window (a stream gap or a restart left few hours of data) still qualifies a subject; the row carries the covered hours.
  const coverage = metaCoverage(tokens.map((t) => Date.parse(t.createdAt)), nowMs, config.coverageMinCreates);
  const thin = isThin(coverage["24h"], config.coverageNoteBelow);
  const subjects: LeaderSubject[] = subjectStats.flatMap(({ stat, extra }, j) => {
    const grads = (assigned.grads[j] as (typeof assigned.grads)[number]);
    if (grads["24h"] === 0) return [];
    return [
      {
        key: stat.group.key,
        label: stat.group.label,
        counts: stat.copies,
        topTokens: topTokensOf(stat, config.topTokens),
        tokens: stat.group.tokens,
        grads: thin ? { ...grads, coverage: { ...coverage["24h"] } } : grads,
        graduates: (assigned.graduates[j] as GraduatedToken[]).map((g) => ({ mint: g.mint, name: cleanLabel(g.name), symbol: cleanLabel(g.symbol), ...(g.createdAt !== null ? { createdAt: g.createdAt } : {}), migratedAt: g.migratedAt })),
        ...extra,
      },
    ];
  });
  const shownTokens = applied ? new Set(items.flatMap((i) => (i.kind === "token" ? [i.mint] : []))) : undefined;
  const current = currentMetas({ subjects, tokens: fresh, previous: carried, ...(shownTokens ? { grouped: shownTokens } : {}), now, config });

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
  const candidateRows = candidatesOf(topDown, lookedUp.verdicts);
  // An answer the Brain was called for this tick is stored with the run (a reused one is stored already, and keeps its own time so the reuse window ends).
  const grouping: NewMetaGrouping | undefined = answer && !answer.reused ? { inputHash: answer.inputHash, answer: storeAnswer(items, answer.subjects), costUsd: answer.costUsd, brainRunId: answer.brainRunId } : undefined;
  const runId = store.meta.saveRun({ computedAt, note: META_NOTE, rule: config, dexCalls, dexFailures, base, rows, coverage, current, candidates: candidateRows, ...(grouping ? { grouping } : {}) });
  return {
    runId,
    computedAt,
    tokensRead: tokens.length,
    groups: stats.length,
    dexCalls,
    dexFailures,
    leaderCalls: lookedUp.calls,
    topDown: { requests: topDown.requests, kept: topDown.candidates.length, dropped: topDown.dropped.length, errors: topDown.errors },
    metas: current.metas.length,
    watching: current.watching.length,
    current,
    group: { source: applied ? "ai" : "rules", reused: answer?.reused ?? false, subjects: applied?.subjects.length ?? 0 },
  };
}

/**
 * The trending tokens the grouping step may see: those the top-down lists named that passed the filter and whose verified market cap is
 * known this run (a candidate DexScreener's own figures refused is not one; a leader carried from last run, or priced by a launch theme, is,
 * at the figure the run has for it).
 */
function trendingInputs(topDown: TopDownResult, fresh: readonly LeaderToken[], verdicts: ReadonlyMap<string, Verdict>): TrendingInput[] {
  const capOf = new Map<string, number>();
  for (const t of fresh) capOf.set(t.mint, Math.max(capOf.get(t.mint) ?? 0, t.marketCapUsd));
  const out: TrendingInput[] = [];
  for (const c of topDown.candidates) {
    const cap = capOf.get(c.mint);
    if (cap === undefined || verdicts.get(c.mint)?.verified === false) continue;
    out.push({ mint: c.mint, name: c.name, symbol: c.symbol, marketCapUsd: cap, lists: c.sources });
  }
  return out;
}

/** The top launch themes by distinct creators in 24 h (bonk included): their key, label, counts and the names most used in them. */
function themeInputs(stats: readonly GroupStat[]): ThemeInput[] {
  return stats
    .filter((s) => !s.group.key.startsWith("unkeyed:"))
    .sort((a, b) => b.copies["24h"].creators - a.copies["24h"].creators || cmpStr(a.group.key, b.group.key))
    .slice(0, GROUP_MAX_THEMES)
    .map((s) => {
      const used = new Map<string, number>();
      for (const t of s.group.tokens) {
        const name = cleanLabel(t.name);
        if (name !== "") used.set(name, (used.get(name) ?? 0) + 1);
      }
      const names = [...used].sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0])).map(([name]) => name);
      return { key: s.group.key, label: s.group.label, tokens: s.copies["24h"].tokens, creators: s.copies["24h"].creators, names };
    });
}

/** Calls the grouping step within its bound. No step, nothing to group, a timeout or an error all give no answer: the tick groups by rules. */
async function askGroupStep(opts: RecomputeOptions, items: readonly GroupItem[], now: Date): Promise<GroupAnswer | undefined> {
  if (!opts.group || !items.some((i) => i.kind === "theme")) return undefined;
  const controller = new AbortController();
  try {
    return await withTimeout(opts.group({ items, inputHash: itemsHash(items), now, signal: controller.signal }), opts.groupTimeoutMs ?? GROUP_TIMEOUT_MS);
  } catch (e) {
    controller.abort();
    opts.log?.(`[worker] meta group: rules (${e instanceof Error ? e.message : String(e)})`);
    return undefined;
  }
}

/** The stored candidate rows: the kept ones with how DexScreener's check went, then the dropped ones with the filter's reason. */
function candidatesOf(topDown: TopDownResult, verdicts: ReadonlyMap<string, Verdict>): NewMetaCandidate[] {
  const shape = (c: TopDownCandidate | DroppedCandidate) => ({
    mint: c.mint,
    name: c.name,
    symbol: c.symbol,
    ...(c.marketCapUsd !== undefined ? { marketCapUsd: c.marketCapUsd } : {}),
    ...(c.liquidityUsd !== undefined ? { liquidityUsd: c.liquidityUsd } : {}),
    ...(c.volume24hUsd !== undefined ? { volume24hUsd: c.volume24hUsd } : {}),
    sources: [...c.sources],
    ranks: { ...c.ranks } as Record<string, number>,
  });
  const kept = topDown.candidates.map((c): NewMetaCandidate => {
    const v = verdicts.get(c.mint);
    return { ...shape(c), verified: v?.verified ?? null, ...(v?.reason !== undefined ? { reason: v.reason } : {}) };
  });
  const dropped = topDown.dropped.map((c): NewMetaCandidate => ({ ...shape(c), verified: null, reason: c.reason }));
  return [...kept, ...dropped];
}

/** The last failure reason logged per mint, kept per log function (the worker passes one for its whole life; a test's own log starts empty). */
const failureLogs = new WeakMap<(message: string) => void, Map<string, string | undefined>>();
function loggedFailure(log: ((message: string) => void) | undefined): Map<string, string | undefined> | undefined {
  if (!log) return undefined;
  let m = failureLogs.get(log);
  if (!m) failureLogs.set(log, (m = new Map()));
  return m;
}

interface LeaderLookupInput {
  dex: MetaDexClient | undefined;
  config: MetaConfig;
  /** The run's time (ISO): the `freshAt` of every figure this lookup reads. */
  now: string;
  log: ((message: string) => void) | undefined;
  /** Mints whose market cap this run already has (the theme lookups): not asked again. */
  have: ReadonlySet<string>;
  previous: PreviousMetas | undefined;
  /** The top-down candidates that passed the filter, highest source market cap first. */
  candidates: readonly TopDownCandidate[];
}

/**
 * The leaders' current market caps within `config.leaderCalls` calls of up to 30 tokens each. Order: last run's leaders first (a Meta is
 * never lost to the budget), then the top-down candidates (highest source market cap first). Every leader, a previous one too, is
 * accepted only when DexScreener's own figures pass the three tests of the fake-token filter (`verifyAgainstDex`, the one rule for every
 * leader path, Q16; the cap-to-liquidity test reads the
 * larger of DexScreener's liquidity and the list's when Jupiter's organic score for the token is high enough, see `verifyAgainstDex`), and its market cap is that of its deepest pair (ADR 0015
 * decision 2): one that fails is logged and is no leader. A token DexScreener did not answer, or a call that failed
 * or fell outside the budget, simply yields no token here; `currentMetas` carries a previous leader at its last figure and never creates
 * a Meta from it. Three failed calls in a row end the lookups of the run.
 */
async function lookUpLeaders(input: LeaderLookupInput): Promise<{ tokens: LeaderToken[]; calls: number; failures: number; verdicts: Map<string, Verdict> }> {
  const out = { tokens: [] as LeaderToken[], calls: 0, failures: 0, verdicts: new Map<string, Verdict>() };
  const { dex, config } = input;
  const skipped = (reason: string): Verdict => ({ verified: null, reason });
  if (!dex || config.leaderCalls <= 0) {
    for (const c of input.candidates) out.verdicts.set(c.mint, skipped("not looked up: no DexScreener lookups"));
    return out;
  }
  interface Known {
    name: string;
    symbol: string;
    source: "trending" | "theme";
    createdAt?: string;
    /** A top-down candidate: verified on DexScreener's figures, not taken on the max-cap rule. */
    topDown: boolean;
    /** A previous leader that had no price (a graduate shown with a dash): asked again for a price, and its failing is no news, so not logged. */
    unpriced?: boolean;
    /** The token-level liquidity the trending lists gave a top-down candidate (read by the cap-to-liquidity test of the verification). */
    listLiquidityUsd?: number;
    /** The list's market cap and 24 h volume: read only when every DexScreener pair of the token is unpriced. */
    listMarketCapUsd?: number;
    listVolume24hUsd?: number;
    /** The candidate's Jupiter organic score, when it is on Jupiter's list: the list's liquidity counts only above the knob. */
    listOrganicScore?: number;
  }
  const known = new Map<string, Known>();
  const order: string[] = [];
  const want = (mint: string, k: Known): boolean => {
    if (input.have.has(mint) || known.has(mint)) return false;
    known.set(mint, k);
    order.push(mint);
    return true;
  };
  for (const row of [...(input.previous?.metas ?? []), ...(input.previous?.watching ?? [])]) {
    const l = row.leader;
    want(l.mint, { name: l.name, symbol: l.symbol, source: l.source, topDown: false, ...(l.marketCapUsd <= 0 ? { unpriced: true } : {}), ...(l.createdAt !== undefined ? { createdAt: l.createdAt } : {}) });
  }
  const byCap = (a: TopDownCandidate, b: TopDownCandidate) => b.marketCapUsd - a.marketCapUsd || cmpStr(a.mint, b.mint);
  for (const c of [...input.candidates].sort(byCap)) {
    // A previous leader that is also trending keeps the list's liquidity and organic score for its verification (the Q14 credit), else it would fail the strict 100x on its next tick.
    const held = known.get(c.mint);
    if (held && !held.topDown) {
      held.listLiquidityUsd = c.liquidityUsd;
      held.listMarketCapUsd = c.marketCapUsd;
      held.listVolume24hUsd = c.volume24hUsd;
      if (c.organicScore !== undefined) held.listOrganicScore = c.organicScore;
    }
    const wanted = want(c.mint, { name: c.name, symbol: c.symbol, source: "trending", topDown: true, listLiquidityUsd: c.liquidityUsd, listMarketCapUsd: c.marketCapUsd, listVolume24hUsd: c.volume24hUsd, ...(c.organicScore !== undefined ? { listOrganicScore: c.organicScore } : {}), ...(c.createdAt !== undefined ? { createdAt: c.createdAt } : {}) });
    out.verdicts.set(c.mint, skipped(wanted ? "not looked up: leader call budget used" : "not looked up: already a previous leader or priced by a launch theme"));
  }

  let streak = 0;
  for (let at = 0, n = 0; at < order.length && n < config.leaderCalls; at += LOOKUP_BATCH, n++) {
    if (streak >= DEX_MAX_CONSECUTIVE_FAILURES) {
      for (const mint of order.slice(at)) if (known.get(mint)?.topDown) out.verdicts.set(mint, skipped("not looked up: DexScreener failed three calls in a row"));
      break;
    }
    const mints = order.slice(at, at + LOOKUP_BATCH);
    out.calls++;
    try {
      const asked = new Set(mints);
      const byMint = new Map<string, DexPair[]>();
      for (const p of await dex.tokenPairs("solana", mints)) {
        if (!asked.has(p.tokenAddress)) continue;
        const list = byMint.get(p.tokenAddress);
        if (list) list.push(p);
        else byMint.set(p.tokenAddress, [p]);
      }
      for (const mint of mints) {
        const k = known.get(mint) as Known;
        const pairs = byMint.get(mint) ?? [];
        const createdMs = pairs.flatMap((p) => (p.pairCreatedAt !== undefined && p.pairCreatedAt > 0 ? [p.pairCreatedAt] : []));
        const first = createdMs.length > 0 ? Math.min(...createdMs) : undefined;
        const created = k.createdAt ?? (first !== undefined && Number.isFinite(new Date(first).getTime()) ? new Date(first).toISOString() : undefined);
        let cap: number | undefined;
        // A previous leader that came from a launch theme (a graduate, priced or not) is judged like a theme token: no floors, the fake-cap test only.
        const verdict =
          !k.topDown && k.source === "theme" && k.listLiquidityUsd === undefined
            ? verifyThemeToken(pairs, config)
            : verifyAgainstDex(pairs, config, {
                ...(k.listLiquidityUsd !== undefined ? { liquidityUsd: k.listLiquidityUsd } : {}),
                ...(k.listMarketCapUsd !== undefined ? { marketCapUsd: k.listMarketCapUsd } : {}),
                ...(k.listVolume24hUsd !== undefined ? { volume24hUsd: k.listVolume24hUsd } : {}),
                ...(k.listOrganicScore !== undefined ? { organicScore: k.listOrganicScore } : {}),
              });
        if (verdict.ok) {
          cap = verdict.marketCapUsd;
          if (k.topDown) out.verdicts.set(mint, { verified: true });
          loggedFailure(input.log)?.delete(mint);
        } else {
          if (k.topDown) out.verdicts.set(mint, { verified: false, reason: `failed verification: ${verdict.reason ?? "unknown"}` });
          // Once per state change: the same mint failing for the same reason on the next tick is not logged again.
          const seen = loggedFailure(input.log);
          if (!k.unpriced && seen?.get(mint) !== verdict.reason) {
            seen?.set(mint, verdict.reason);
            input.log?.(`[meta] leader ${cleanLabel(k.symbol) || cleanLabel(k.name) || mint.slice(0, 8)} failed verification: ${verdict.reason ?? "unknown"}`);
          }
        }
        if (cap !== undefined) out.tokens.push({ mint, name: k.name, symbol: k.symbol, marketCapUsd: cap, ...(created !== undefined ? { createdAt: created } : {}), source: k.source, stale: false, freshAt: input.now });
      }
      streak = 0;
    } catch (e) {
      out.failures++;
      streak++;
      for (const mint of mints) if (known.get(mint)?.topDown) out.verdicts.set(mint, skipped("not looked up: DexScreener lookup failed"));
      input.log?.(`[meta] DexScreener leader lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
