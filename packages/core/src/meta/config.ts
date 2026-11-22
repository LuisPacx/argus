/**
 * The Meta ranking rule and its knobs (ticket 03, slice 3), in one place so the order can change without touching the code that applies it.
 *
 * The order was decided by the user on 2026-11-11 (the ticket's rank-order question):
 *
 *   1. distinct creators      the demand measure: one creator spamming 50 clones is one person's interest, not 50 tokens' worth
 *   2. migrationsAfter60s     migrations more than 60 s after the create, the crude organic proxy: a migration bundled with the create
 *                             (about a third of them) is mostly bot-driven and says little. The unfiltered `migrations` is still stored and
 *                             shown on every row, and can be ranked on through `ARGUS_META_RANK_ORDER`.
 *   3. market cap             the group's summed top tokens where DexScreener has them; a group with none sorts after one with a figure
 *   4. distinct tokens        raw volume of launches, last because the cheapest to inflate
 *
 * Why not raw token count first: the biggest token counts come from spam (one ticker alone is about 1,400 tokens from 11 creators in the
 * three-day DB); distinct creators count people, not launches.
 * Ties after the last key fall to the group key, so the order never depends on input order.
 */

import { DEFAULT_THEME_CONFIG, type ThemeConfig } from "./theme.ts";

export const META_WINDOWS = ["6h", "24h"] as const;
export type MetaWindow = (typeof META_WINDOWS)[number];
export const META_WINDOW_HOURS: Record<MetaWindow, number> = { "6h": 6, "24h": 24 };

export const isMetaWindow = (v: unknown): v is MetaWindow => v === "6h" || v === "24h";

export type RankKey = "creators" | "migrations" | "migrationsAfter60s" | "marketCapUsd" | "tokens";

export interface MetaConfig {
  /** The ranking order, most significant first. Every key sorts descending; an absent market cap sorts after any present one. */
  rankOrder: readonly RankKey[];
  /** A group with fewer distinct tokens in the window is not a Meta (viral sources ticket 05: 5). */
  minTokens: number;
  /** A group with fewer distinct creators in the window is not a Meta: one creator's 34 tokens are one person's interest (ticket 05: 3). */
  minCreators: number;
  /** An hour counts as covered by data when at least this many tokens were created in it (a normal hour holds hundreds). */
  coverageMinCreates: number;
  /** A window whose covered hours are below this share of its length gets a "warming up" note, and a 24 h window below it drops the judge/propose Meta block. */
  coverageNoteBelow: number;
  /** Rows stored per window per run. */
  maxRowsPerWindow: number;
  /** A migration more than this many seconds after the create counts in `migrationsAfter60s`, the crude organic proxy. */
  organicAfterSec: number;
  /** Runs (and their rows) older than this many days before a new run are deleted. */
  retentionDays: number;
  /** DexScreener market cap is looked up for this many top groups per window (the same group in both windows costs one call). */
  dexGroups: number;
  /** Hard ceiling on DexScreener calls in one run; one call per group, up to 30 candidate tokens in it. DexScreener allows about 300 a minute. */
  dexMaxCalls: number;
  /** Candidate tokens sent in one group's lookup (DexScreener accepts 30 addresses). The three highest market caps are kept as the group's top tokens. */
  dexCandidates: number;
  /** How many top tokens a row shows. */
  topTokens: number;
  /** Theme Metas (slice 2, `theme.ts`): small clusters that name a big Meta's subject join it. Null switches it off. */
  theme: ThemeConfig | null;
  /** New Meta (meta redesign ticket 03): a stored event stays live, shown on the War Room and read by the meme pass, for this many hours. */
  newMetaLiveHours: number;
  /** Matching news (context, ADR 0011): only headlines published within this many hours. */
  newsWindowHours: number;
  /** Matching news: at most this many headlines per Meta. */
  newsMaxItems: number;
  /** Matching news: a Meta key shorter than this many characters (spaces removed) is too short to name a subject in a headline. */
  newsMinKeyChars: number;
  /**
   * A trending token at or above this market cap is shown to the AI grouping step (ADR 0015). Market cap is no longer part of the Meta rule:
   * a Meta is several tokens graduating on one narrative (graduation Meta ticket 01), so this only bounds what the grouping step reads.
   */
  enterMcapUsd: number;
  /** Graduation Meta: a subject becomes a Meta with at least this many graduations in 24 h ... */
  metaMinGrads: number;
  /** ... and a Meta stays one with at least this many graduations in 24 h (never above `metaMinGrads`). */
  metaStayGrads: number;
  /** ... from at least this many distinct creators in 24 h ... */
  metaMinCreators: number;
  /** ... and at least this many graduations in the last 6 h (a live wave, not a finished one). */
  metaLiveGrads6h: number;
  /** Watching: a subject that is not a Meta with at least this many graduations in 24 h ... */
  watchMinGrads: number;
  /** ... or at least this many in the last 6 h. */
  watchGrads6h: number;
  /** At most this many Metas, most 24 h graduations first, then 6 h, then creators. */
  maxMetas: number;
  /** At most this many Watching subjects, most 6 h graduations first, then 24 h. */
  watching: number;
  /** DexScreener calls per Meta tick for the leaders' current market caps (each takes up to 30 tokens), beside the launch-theme lookups. */
  leaderCalls: number;
  /** Stored Meta state older than this many minutes (a pause) is not carried into the next run. */
  stateMaxMinutes: number;
  /** Top-down leaders (ADR 0015): HTTP requests per tick to the two trending lists together, retries included. A normal tick makes 4. */
  topDownCalls: number;
  /** The fake-token filter: a candidate's liquidity must be at least this many USD. */
  topDownMinLiquidityUsd: number;
  /** The fake-token filter: its market cap may be at most this many times its liquidity. */
  topDownMaxCapLiquidityRatio: number;
  /** The fake-token filter: its 24 h volume must be at least this many USD. */
  topDownMinVolumeUsd: number;
  /** Verification: the list's token-level liquidity counts toward the cap-to-liquidity test only when the token's Jupiter organic score is at least this (0 to 100). */
  topDownMinOrganicScore: number;
}

export const META_RULE: MetaConfig = {
  rankOrder: ["creators", "migrationsAfter60s", "marketCapUsd", "tokens"],
  minTokens: 5,
  minCreators: 3,
  coverageMinCreates: 10,
  coverageNoteBelow: 0.8,
  maxRowsPerWindow: 50,
  organicAfterSec: 60,
  retentionDays: 14,
  dexGroups: 10,
  dexMaxCalls: 20,
  dexCandidates: 30,
  topTokens: 3,
  theme: DEFAULT_THEME_CONFIG,
  newMetaLiveHours: 6,
  newsWindowHours: 24,
  newsMaxItems: 5,
  newsMinKeyChars: 4,
  enterMcapUsd: 1_000_000,
  metaMinGrads: 10,
  metaStayGrads: 5,
  metaMinCreators: 6,
  metaLiveGrads6h: 3,
  watchMinGrads: 5,
  watchGrads6h: 3,
  maxMetas: 3,
  watching: 3,
  leaderCalls: 4,
  stateMaxMinutes: 120,
  topDownCalls: 5,
  topDownMinLiquidityUsd: 50_000,
  topDownMaxCapLiquidityRatio: 100,
  topDownMinVolumeUsd: 50_000,
  topDownMinOrganicScore: 50,
};

/** How often the worker recomputes, in minutes. */
export const DEFAULT_META_INTERVAL_MINUTES = 15;

const intIn = (raw: string | undefined, min: number, max: number, fallback: number): number => {
  if (!raw || !/^\d{1,9}$/.test(raw)) return fallback;
  const n = Number(raw);
  return n >= min && n <= max ? n : fallback;
};

/** A decimal share 0 to 1 ("0.8", "1", ".5"); junk keeps the fallback. */
const shareIn = (raw: string | undefined, fallback: number): number => {
  if (!raw || !/^(?:\d(?:\.\d{1,3})?|\.\d{1,3})$/.test(raw)) return fallback;
  const n = Number(raw);
  return n >= 0 && n <= 1 ? n : fallback;
};

/** `ARGUS_META_INTERVAL_MINUTES` (1 to 1440), junk ignored. */
export function metaIntervalMinutes(env: Record<string, string | undefined> = process.env): number {
  return intIn(env.ARGUS_META_INTERVAL_MINUTES, 1, 1_440, DEFAULT_META_INTERVAL_MINUTES);
}

const RANK_KEYS: readonly RankKey[] = ["creators", "migrations", "migrationsAfter60s", "marketCapUsd", "tokens"];

/** `creators,migrations,...` as an order; undefined for anything else (unknown, repeated or empty keys), so junk keeps the default. */
function parseRankOrder(raw: string | undefined): RankKey[] | undefined {
  if (!raw) return undefined;
  const out: RankKey[] = [];
  for (const piece of raw.split(",")) {
    const key = RANK_KEYS.find((k) => k === piece.trim());
    if (key === undefined || out.includes(key)) return undefined;
    out.push(key);
  }
  return out;
}

/**
 * The rule with overrides from the environment: `ARGUS_META_RANK_ORDER` (a comma list of creators, migrations, migrationsAfter60s, marketCapUsd, tokens),
 * the DexScreener budget `ARGUS_META_DEX_GROUPS` (0 to 50) and `ARGUS_META_DEX_CALLS` (0 to 60, below the rate limit), and
 * `ARGUS_META_THEMES=0` (theme merging off: clone clusters only), the size floor `ARGUS_META_MIN_TOKENS` and `ARGUS_META_MIN_CREATORS`
 * (1 to 1000), and the window coverage measure `ARGUS_META_COVERAGE_MIN_CREATES` (1 to 100000 creates for an hour to count) and
 * `ARGUS_META_COVERAGE_NOTE_BELOW` (a share from 0 to 1, as a decimal like 0.8). The graduation rule: `ARGUS_META_MIN_GRADS` (graduations in 24 h to
 * become a Meta), `ARGUS_META_STAY_GRADS` (to stay one; above the first keeps both defaults), `ARGUS_META_GRAD_CREATORS` (distinct creators),
 * `ARGUS_META_LIVE_GRADS_6H`, `ARGUS_META_WATCH_MIN_GRADS` and `ARGUS_META_WATCH_GRADS_6H` (each 1 to 1000), `ARGUS_META_ENTER_MCAP_USD` (1 to 999999999:
 * the trending cap the grouping step reads), `ARGUS_META_MAX_METAS` and `ARGUS_META_WATCHING` (0 to 20), `ARGUS_META_LEADER_CALLS` (0 to 20) and
 * `ARGUS_META_STATE_MAX_MINUTES` (1 to 10080).
 * The top-down leaders (ADR 0015): `ARGUS_META_TOPDOWN_CALLS` (1 to 10 requests a tick), and the fake-token filter `ARGUS_META_TOPDOWN_MIN_LIQ_USD` and
 * `ARGUS_META_TOPDOWN_MIN_VOLUME_USD` (0 to 999999999) and `ARGUS_META_TOPDOWN_MAX_CAP_LIQ_RATIO` (1 to 100000), and
 * `ARGUS_META_TOPDOWN_MIN_ORGANIC` (0 to 100): the Jupiter organic score a token needs for the list's liquidity to count in verification.
 */
export function metaConfigFromEnv(env: Record<string, string | undefined> = process.env): MetaConfig {
  const minGrads = intIn(env.ARGUS_META_MIN_GRADS, 1, 1_000, META_RULE.metaMinGrads);
  const stayGrads = intIn(env.ARGUS_META_STAY_GRADS, 1, 1_000, META_RULE.metaStayGrads);
  const pairOk = stayGrads <= minGrads;
  return {
    ...META_RULE,
    rankOrder: parseRankOrder(env.ARGUS_META_RANK_ORDER) ?? META_RULE.rankOrder,
    dexGroups: intIn(env.ARGUS_META_DEX_GROUPS, 0, 50, META_RULE.dexGroups),
    dexMaxCalls: intIn(env.ARGUS_META_DEX_CALLS, 0, 60, META_RULE.dexMaxCalls),
    theme: env.ARGUS_META_THEMES === "0" ? null : META_RULE.theme,
    minTokens: intIn(env.ARGUS_META_MIN_TOKENS, 1, 1_000, META_RULE.minTokens),
    minCreators: intIn(env.ARGUS_META_MIN_CREATORS, 1, 1_000, META_RULE.minCreators),
    coverageMinCreates: intIn(env.ARGUS_META_COVERAGE_MIN_CREATES, 1, 100_000, META_RULE.coverageMinCreates),
    coverageNoteBelow: shareIn(env.ARGUS_META_COVERAGE_NOTE_BELOW, META_RULE.coverageNoteBelow),
    enterMcapUsd: intIn(env.ARGUS_META_ENTER_MCAP_USD, 1, 999_999_999, META_RULE.enterMcapUsd),
    metaMinGrads: pairOk ? minGrads : META_RULE.metaMinGrads,
    metaStayGrads: pairOk ? stayGrads : META_RULE.metaStayGrads,
    metaMinCreators: intIn(env.ARGUS_META_GRAD_CREATORS, 1, 1_000, META_RULE.metaMinCreators),
    metaLiveGrads6h: intIn(env.ARGUS_META_LIVE_GRADS_6H, 1, 1_000, META_RULE.metaLiveGrads6h),
    watchMinGrads: intIn(env.ARGUS_META_WATCH_MIN_GRADS, 1, 1_000, META_RULE.watchMinGrads),
    watchGrads6h: intIn(env.ARGUS_META_WATCH_GRADS_6H, 1, 1_000, META_RULE.watchGrads6h),
    maxMetas: intIn(env.ARGUS_META_MAX_METAS, 0, 20, META_RULE.maxMetas),
    watching: intIn(env.ARGUS_META_WATCHING, 0, 20, META_RULE.watching),
    leaderCalls: intIn(env.ARGUS_META_LEADER_CALLS, 0, 20, META_RULE.leaderCalls),
    stateMaxMinutes: intIn(env.ARGUS_META_STATE_MAX_MINUTES, 1, 10_080, META_RULE.stateMaxMinutes),
    topDownCalls: intIn(env.ARGUS_META_TOPDOWN_CALLS, 1, 10, META_RULE.topDownCalls),
    topDownMinLiquidityUsd: intIn(env.ARGUS_META_TOPDOWN_MIN_LIQ_USD, 0, 999_999_999, META_RULE.topDownMinLiquidityUsd),
    topDownMaxCapLiquidityRatio: intIn(env.ARGUS_META_TOPDOWN_MAX_CAP_LIQ_RATIO, 1, 100_000, META_RULE.topDownMaxCapLiquidityRatio),
    topDownMinVolumeUsd: intIn(env.ARGUS_META_TOPDOWN_MIN_VOLUME_USD, 0, 999_999_999, META_RULE.topDownMinVolumeUsd),
    topDownMinOrganicScore: intIn(env.ARGUS_META_TOPDOWN_MIN_ORGANIC, 0, 100, META_RULE.topDownMinOrganicScore),
  };
}
