import type { GeckoPool } from "../sources/geckoterminal.ts";
import type { JupiterToken } from "../sources/jupiter.ts";
import type { DexPair } from "../sources/dexscreener.ts";
import type { MetaConfig } from "./config.ts";
import { isGenericKey } from "./group.ts";
import { subjectKey } from "./key.ts";

/**
 * Top-down leaders (ADR 0015, meta-redesign ticket 05), pure: merges the two trending lists per token, drops what cannot lead a Meta (a
 * quote token, a tokenized stock, a generic name, a fake) and says why. No clock, no network, no database. Every string here was written
 * by a remote party; nothing builds a pattern from it, and the stock markers are a literal list.
 *
 * The fake-token filter, all three must hold: liquidity at least `topDownMinLiquidityUsd`, market cap at most `topDownMaxCapLiquidityRatio`
 * times liquidity, 24 h volume at least `topDownMinVolumeUsd`. A missing figure fails the test it is needed for. The evidence is in ADR 0015:
 * a fake "GTA VI" showed $12.07B on $48.3M of liquidity (250 times) and $2.28 of volume, the real one about 26 times.
 */

export type TopDownSource = "jupiter" | "geckoterminal";

export type TopDownFilterConfig = Pick<MetaConfig, "topDownMinLiquidityUsd" | "topDownMaxCapLiquidityRatio" | "topDownMinVolumeUsd">;

export interface TopDownCandidate {
  mint: string;
  /** Written by the token's creator: untrusted, cleaned and cut. */
  name: string;
  symbol: string;
  marketCapUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  sources: TopDownSource[];
  /** The token's place (1 = first) on each list it was on. GeckoTerminal's is its best pool's place across the pages read. */
  ranks: Partial<Record<TopDownSource, number>>;
  createdAt?: string;
  /** Jupiter's organic score (0 to 100), absent for a token not on Jupiter's list. Read by the verification. */
  organicScore?: number;
}

/** A token the filter dropped, with the figures it had (absent where the lists gave none) and the reason, for the War Room and the replay. */
export interface DroppedCandidate {
  mint: string;
  name: string;
  symbol: string;
  marketCapUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  sources: TopDownSource[];
  ranks: Partial<Record<TopDownSource, number>>;
  reason: string;
}

export interface TopDownFiltered {
  /** Highest market cap first, ties by mint. */
  candidates: TopDownCandidate[];
  dropped: DroppedCandidate[];
}

/** What one tick read from the two lists: the filtered candidates, the requests made and what failed. */
export interface TopDownResult extends TopDownFiltered {
  requests: number;
  /** One line per failed list or page; empty when everything answered. */
  errors: string[];
}

// Tokens that only quote other tokens (SOL, the dollar coins): never a Meta's leader.
const QUOTE_MINTS: ReadonlySet<string> = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
]);
const QUOTE_SYMBOLS: ReadonlySet<string> = new Set(["SOL", "WSOL", "USDC", "USDT", "PYUSD", "USDS"]);

/**
 * What marks a tokenized stock, read from live Jupiter answers on 2026-11-16: every one of the eight stock tokens in the top 50 carried the
 * tag `stocks` (with `rwa`), the xStocks family also `xstocks` and `equities`, and none of the other 42 tokens carried any of them. The name
 * marker covers a list that has no tags (GeckoTerminal names the Take-Two token "Take-Two Interactive Software - Backpack Securities").
 * A literal list; matched with `includes` on the lower-cased cut name, never as a pattern.
 */
export const STOCK_TAGS: readonly string[] = ["stocks", "xstocks", "equities", "rwa"];
export const STOCK_NAME_MARKERS: readonly string[] = ["backpack securities", "xstock"];

export function isStockToken(t: { name: string; symbol: string; tags?: readonly string[] }): boolean {
  if ((t.tags ?? []).some((tag) => STOCK_TAGS.includes(tag.toLowerCase()))) return true;
  const name = t.name.slice(0, 200).toLowerCase();
  return STOCK_NAME_MARKERS.some((m) => name.includes(m));
}

const isQuoteToken = (t: { mint: string; symbol: string }): boolean => QUOTE_MINTS.has(t.mint) || QUOTE_SYMBOLS.has(t.symbol.toUpperCase());

/** True when no name or ticker key of the token can name a subject (all generic, or none at all). */
const hasNoSubjectKey = (t: { name: string; symbol: string }): boolean => subjectKey(t.name, t.symbol).every((k) => isGenericKey(k));

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const positive = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n > 0;

/**
 * The three tests on one set of figures; the reasons of every test that fails, empty when all pass. A missing figure fails.
 * `ratioLiquidityUsd` replaces the liquidity in the cap-to-liquidity test only (the liquidity minimum always reads `liquidityUsd`).
 */
export function fakeTestFailures(f: { marketCapUsd?: number | undefined; liquidityUsd?: number | undefined; volume24hUsd?: number | undefined }, c: TopDownFilterConfig, ratioLiquidityUsd?: number): string[] {
  const failed: string[] = [];
  const { marketCapUsd: cap, liquidityUsd: liq, volume24hUsd: vol } = f;
  const ratioLiq = ratioLiquidityUsd ?? liq;
  if (!positive(liq)) failed.push("liquidity missing");
  else if (liq < c.topDownMinLiquidityUsd) failed.push(`liquidity ${usd(liq)} under ${usd(c.topDownMinLiquidityUsd)}`);
  if (!positive(cap)) failed.push("market cap missing");
  else if (!positive(ratioLiq)) failed.push("cap-to-liquidity ratio unknown");
  else if (cap > c.topDownMaxCapLiquidityRatio * ratioLiq) failed.push(`cap ${Math.round(cap / ratioLiq)}x liquidity (over ${c.topDownMaxCapLiquidityRatio}x)`);
  if (!positive(vol)) failed.push("24 h volume missing");
  else if (vol < c.topDownMinVolumeUsd) failed.push(`24 h volume ${usd(vol)} under ${usd(c.topDownMinVolumeUsd)}`);
  return failed;
}

interface Merged {
  mint: string;
  name: string;
  symbol: string;
  tags: string[];
  jupiter?: JupiterToken;
  pools: GeckoPool[];
  ranks: Partial<Record<TopDownSource, number>>;
}

/**
 * Merges the two lists per token and filters. `jupiter` is in Jupiter's order (rank 1 first) and `gecko` is every pool read, pages in order
 * (a pool's rank is its place in that list). Token-level figures: market cap from Jupiter, else the pools' (the larger of their market cap or
 * FDV figures), else Jupiter's FDV; liquidity from Jupiter, else the sum of the pools' reserves; volume from Jupiter, else the sum of the pools' 24 h volume.
 */
export function topDownCandidates(input: { jupiter: readonly JupiterToken[]; gecko: readonly GeckoPool[]; config: TopDownFilterConfig }): TopDownFiltered {
  const byMint = new Map<string, Merged>();
  const entry = (mint: string, name: string, symbol: string): Merged => {
    let m = byMint.get(mint);
    if (!m) byMint.set(mint, (m = { mint, name, symbol, tags: [], pools: [], ranks: {} }));
    return m;
  };
  input.jupiter.forEach((t, i) => {
    const m = entry(t.mint, t.name, t.symbol);
    if (m.jupiter) return; // a repeated mint keeps its first place
    m.jupiter = t;
    m.ranks.jupiter = i + 1;
    m.tags = [...t.tags];
    if (t.name !== "") m.name = t.name;
    if (t.symbol !== "") m.symbol = t.symbol;
  });
  input.gecko.forEach((p, i) => {
    const m = entry(p.mint, p.name, p.symbol);
    m.pools.push(p);
    m.ranks.geckoterminal ??= i + 1;
    if (m.name === "") m.name = p.name;
    if (m.symbol === "") m.symbol = p.symbol;
  });

  const candidates: TopDownCandidate[] = [];
  const dropped: DroppedCandidate[] = [];
  for (const m of byMint.values()) {
    const sources: TopDownSource[] = [...(m.jupiter ? (["jupiter"] as const) : []), ...(m.pools.length > 0 ? (["geckoterminal"] as const) : [])];
    const poolCap = m.pools.reduce<number | undefined>((best, p) => (positive(p.marketCapUsd) && (best === undefined || p.marketCapUsd > best) ? p.marketCapUsd : best), undefined);
    const marketCapUsd = positive(m.jupiter?.marketCapUsd) ? m.jupiter.marketCapUsd : (poolCap ?? (positive(m.jupiter?.fdvUsd) ? m.jupiter.fdvUsd : undefined));
    const poolSum = (pick: (p: GeckoPool) => number | undefined): number | undefined => (m.pools.some((p) => pick(p) !== undefined) ? m.pools.reduce((s, p) => s + (pick(p) ?? 0), 0) : undefined);
    const liquidityUsd = m.jupiter?.liquidityUsd !== undefined ? m.jupiter.liquidityUsd : poolSum((p) => p.liquidityUsd);
    const volume24hUsd = m.jupiter?.volume24hUsd !== undefined ? m.jupiter.volume24hUsd : poolSum((p) => p.volume24hUsd);
    const figures = { ...(marketCapUsd !== undefined ? { marketCapUsd } : {}), ...(liquidityUsd !== undefined ? { liquidityUsd } : {}), ...(volume24hUsd !== undefined ? { volume24hUsd } : {}) };
    const base = { mint: m.mint, name: m.name, symbol: m.symbol, sources, ranks: m.ranks };
    const drop = (reason: string) => dropped.push({ ...base, ...figures, reason });

    if (isQuoteToken(m)) drop("quote token");
    else if (isStockToken({ name: m.name, symbol: m.symbol, tags: m.tags })) drop("stock token");
    else if (hasNoSubjectKey(m)) drop("generic name");
    else {
      const failed = fakeTestFailures(figures, input.config);
      if (failed.length > 0) drop(`fake: ${failed.join("; ")}`);
      else {
        const created = [m.jupiter?.createdAt, ...m.pools.map((p) => p.createdAt)].filter((c): c is string => c !== undefined).sort()[0];
        candidates.push({ ...base, marketCapUsd: marketCapUsd as number, liquidityUsd: liquidityUsd as number, volume24hUsd: volume24hUsd as number, ...(created !== undefined ? { createdAt: created } : {}), ...(m.jupiter?.organicScore !== undefined ? { organicScore: m.jupiter.organicScore } : {}) });
      }
    }
  }
  candidates.sort((a, b) => b.marketCapUsd - a.marketCapUsd || cmpStr(a.mint, b.mint));
  dropped.sort((a, b) => (b.marketCapUsd ?? -1) - (a.marketCapUsd ?? -1) || cmpStr(a.mint, b.mint));
  return { candidates, dropped };
}

/** What DexScreener's answer for one token comes to, for verification. */
export interface DexVerdict {
  /** True when the token passes the same three tests on DexScreener's own figures. */
  ok: boolean;
  /** Why not, when it does not. */
  reason?: string;
  /** The market cap of the pair with the most liquidity (never the largest over pairs, so a thin fake pair cannot raise it). */
  marketCapUsd?: number;
  liquidityUsd: number;
  volume24hUsd: number;
}

/**
 * The DexScreener side of the filter: liquidity and 24 h volume summed over the token's pairs, market cap from the pair with the most
 * liquidity (market cap, else FDV). `pairs` are the answer's pairs for this one token.
 *
 * The cap-to-liquidity test reads the larger of DexScreener's summed liquidity and the list's token-level liquidity, but only when the
 * token's Jupiter organic score is at least `topDownMinOrganicScore` (the Operator's decision, Q14 a). Found on the live replay of
 * 2026-11-16: the real GTA VI (organic score 73) had $271k of liquidity on Jupiter's list but one $62k pair in DexScreener's token lookup,
 * so its cap stood at 123 times DexScreener's liquidity and the strict reading refused the token this rule exists to find. A token with
 * no Jupiter score (GeckoTerminal only) or a lower one is judged on DexScreener's liquidity alone, so a list figure cannot rescue a fake.
 * Liquidity and volume minimums are always DexScreener's own.
 */
export function verifyAgainstDex(allPairs: readonly DexPair[], config: TopDownFilterConfig & Pick<MetaConfig, "topDownMinOrganicScore">, list?: { liquidityUsd?: number; organicScore?: number; marketCapUsd?: number; volume24hUsd?: number }): DexVerdict {
  if (allPairs.length === 0) return { ok: false, reason: "no DexScreener pair", liquidityUsd: 0, volume24hUsd: 0 };
  // A pair with no figures at all (quoted in another token) is skipped, never read as 0.
  const pairs = allPairs.filter((p) => p.unpriced !== true);
  if (pairs.length === 0) {
    // Every pair is unpriced: the list's own figures (GeckoTerminal / Jupiter, already collected) stand when all three are present and pass the same tests.
    const f = { marketCapUsd: list?.marketCapUsd, liquidityUsd: list?.liquidityUsd, volume24hUsd: list?.volume24hUsd };
    if (positive(f.marketCapUsd) && positive(f.liquidityUsd) && positive(f.volume24hUsd) && fakeTestFailures(f, config).length === 0) {
      return { ok: true, marketCapUsd: f.marketCapUsd, liquidityUsd: f.liquidityUsd, volume24hUsd: f.volume24hUsd };
    }
    return { ok: false, reason: "no priced DexScreener pair", liquidityUsd: 0, volume24hUsd: 0 };
  }
  let deepest = pairs[0] as DexPair;
  let liquidityUsd = 0;
  let volume24hUsd = 0;
  for (const p of pairs) {
    liquidityUsd += p.liquidityUsd;
    volume24hUsd += p.volume24hUsd;
    if (p.liquidityUsd > deepest.liquidityUsd) deepest = p;
  }
  const marketCapUsd = positive(deepest.marketCapUsd) ? deepest.marketCapUsd : positive(deepest.fdvUsd) ? deepest.fdvUsd : undefined;
  const credited = list?.organicScore !== undefined && list.organicScore >= config.topDownMinOrganicScore ? (list.liquidityUsd ?? 0) : 0;
  const failed = fakeTestFailures({ marketCapUsd, liquidityUsd, volume24hUsd }, config, Math.max(liquidityUsd, credited));
  return { ok: failed.length === 0, ...(failed.length > 0 ? { reason: failed.join("; ") } : {}), ...(marketCapUsd !== undefined ? { marketCapUsd } : {}), liquidityUsd, volume24hUsd };
}
