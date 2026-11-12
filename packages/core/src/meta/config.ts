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

export const META_WINDOWS =["6h", "24h"] as const;
export type MetaWindow = (typeof META_WINDOWS)[number];
export const META_WINDOW_HOURS: Record<MetaWindow, number> = { "6h": 6, "24h": 24 };

export const isMetaWindow = (v: unknown): v is MetaWindow => v === "6h" || v === "24h";

export type RankKey = "creators" | "migrations" | "migrationsAfter60s" | "marketCapUsd" | "tokens";

export interface MetaConfig {
  /** The ranking order, most significant first. Every key sorts descending; an absent market cap sorts after any present one. */
  rankOrder: readonly RankKey[];
  /** A group with fewer distinct tokens in the window is not a Meta. */
  minTokens: number;
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
}

export const META_RULE: MetaConfig = {
  rankOrder: ["creators", "migrationsAfter60s", "marketCapUsd", "tokens"],
  minTokens: 2,
  maxRowsPerWindow: 50,
  organicAfterSec: 60,
  retentionDays: 14,
  dexGroups: 10,
  dexMaxCalls: 20,
  dexCandidates: 30,
  topTokens: 3,
  theme: DEFAULT_THEME_CONFIG,
};

/** How often the worker recomputes, in minutes. */
export const DEFAULT_META_INTERVAL_MINUTES = 15;

const intIn = (raw: string | undefined, min: number, max: number, fallback: number): number => {
  if (!raw || !/^\d{1,9}$/.test(raw)) return fallback;
  const n = Number(raw);
  return n >= min && n <= max ? n : fallback;
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
 * `ARGUS_META_THEMES=0` (theme merging off: clone clusters only).
 */
export function metaConfigFromEnv(env: Record<string, string | undefined> = process.env): MetaConfig {
  return {
    ...META_RULE,
    rankOrder: parseRankOrder(env.ARGUS_META_RANK_ORDER) ?? META_RULE.rankOrder,
    dexGroups: intIn(env.ARGUS_META_DEX_GROUPS, 0, 50, META_RULE.dexGroups),
    dexMaxCalls: intIn(env.ARGUS_META_DEX_CALLS, 0, 60, META_RULE.dexMaxCalls),
    theme: env.ARGUS_META_THEMES === "0" ? null : META_RULE.theme,
  };
}
