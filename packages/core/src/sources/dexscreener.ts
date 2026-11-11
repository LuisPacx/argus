import { timedFetchText, type FetchText } from "./http.ts";
import { safeUrl, stripHtml } from "./rss.ts";
import type { Signal, Source } from "./source.ts";

/** DexScreener's public API needs no key. Its limits are about 60 requests a minute on boosts and 300 on search and token lookups. */
const API_BASE = "https://api.dexscreener.com";
const API_TIMEOUT_MS = 10_000;
const API_MAX_BYTES = 2 * 1024 * 1024;
/** Only the first this-many entries of any response are read. */
const MAX_ENTRIES = 100;
/** `/tokens/v1/{chain}/{addresses}` accepts at most 30 addresses. */
const MAX_LOOKUP = 30;
const MAX_NAME_CHARS = 100;
const MAX_SYMBOL_CHARS = 30;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_SUMMARY_CHARS = 1_000;
// Chain ids and token addresses come out of a remote response and go into a URL path: only plain tokens are used.
const CHAIN_RE = /^[a-z0-9-]{1,32}$/;
const ADDRESS_RE = /^[A-Za-z0-9]{20,66}$/;

export interface BoostedToken {
  chainId: string;
  tokenAddress: string;
  description: string;
}

/** One trading pair, reduced to what Argus uses. Numbers are 0 when DexScreener gave none. */
export interface DexPair {
  chainId: string;
  tokenAddress: string;
  name: string;
  symbol: string;
  /** An https DexScreener link, or empty. */
  url: string;
  liquidityUsd: number;
  volume24hUsd: number;
  priceChange24hPct: number;
  /** Epoch ms the pair was created, when known. */
  pairCreatedAt?: number;
  /** Market cap in USD, absent when DexScreener gave none (never 0 for "unknown"). */
  marketCapUsd?: number;
  /** Fully diluted valuation in USD, absent when none was given. */
  fdvUsd?: number;
}

export interface DexScreenerClientOptions {
  /** Replaces the network fetch (tests pass recorded JSON). */
  fetchText?: FetchText;
  baseUrl?: string;
  timeoutMs?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Remote text: markup removed, trimmed, cut to `max`. */
const str = (v: unknown, max: number): string => (typeof v === "string" ? stripHtml(v).trim().slice(0, max) : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Read-only DexScreener client. Reused by the Trending Source here and by the collision checks (`search`). */
export class DexScreenerClient {
  private readonly fetchText: FetchText;
  private readonly baseUrl: string;

  constructor(opts: DexScreenerClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? API_BASE;
    this.fetchText = opts.fetchText ?? timedFetchText({ what: "DexScreener", timeoutMs: opts.timeoutMs ?? API_TIMEOUT_MS, maxBytes: API_MAX_BYTES, headers: { accept: "application/json" } });
  }

  private async json(path: string): Promise<unknown> {
    return JSON.parse(await this.fetchText(`${this.baseUrl}${path}`)) as unknown;
  }

  /** The most boosted tokens right now, across chains. */
  async topBoosts(): Promise<BoostedToken[]> {
    const data = await this.json("/token-boosts/top/v1");
    if (!Array.isArray(data)) throw new Error("DexScreener: unexpected boosts response");
    const out: BoostedToken[] = [];
    for (const entry of data.slice(0, MAX_ENTRIES)) {
      if (!isRecord(entry)) continue;
      const chainId = str(entry.chainId, 32);
      const tokenAddress = str(entry.tokenAddress, 80);
      if (!CHAIN_RE.test(chainId) || !ADDRESS_RE.test(tokenAddress)) continue;
      out.push({ chainId, tokenAddress, description: str(entry.description, MAX_DESCRIPTION_CHARS) });
    }
    return out;
  }

  /** Pairs trading the given tokens on one chain (up to 30 addresses). Unsafe ids are dropped, never sent. */
  async tokenPairs(chainId: string, addresses: string[]): Promise<DexPair[]> {
    const safe = addresses.filter((a) => ADDRESS_RE.test(a)).slice(0, MAX_LOOKUP);
    if (!CHAIN_RE.test(chainId) || safe.length === 0) return [];
    return this.pairs(await this.json(`/tokens/v1/${chainId}/${safe.join(",")}`));
  }

  /**
   * Pairs matching a name or ticker, best first, for the collision checks. A real no-match answer carries `pairs: []`; a missing,
   * null or non-array `pairs` is an error, so a changed or broken answer can never read as "nothing found". Unlike the lookups the
   * Trending Source makes, entries are kept whatever their chain id or token address looks like (SUI and TON addresses are not
   * Solana- or EVM-shaped): only the name and ticker matter here, and nothing from the entry goes into a URL.
   */
  async search(query: string): Promise<DexPair[]> {
    const data = await this.json(`/latest/dex/search?q=${encodeURIComponent(query)}`);
    if (!isRecord(data) || !Array.isArray(data.pairs)) throw new Error("DexScreener: unexpected search response (no pairs array)");
    return this.pairs(data.pairs, false);
  }

  private pairs(data: unknown, strictIds = true): DexPair[] {
    if (!Array.isArray(data)) throw new Error("DexScreener: unexpected pairs response");
    const out: DexPair[] = [];
    for (const entry of data.slice(0, MAX_ENTRIES)) {
      if (!isRecord(entry) || !isRecord(entry.baseToken)) continue;
      const base = entry.baseToken;
      const chainId = str(entry.chainId, 32);
      const tokenAddress = str(base.address, 80);
      if (strictIds && (!CHAIN_RE.test(chainId) || !ADDRESS_RE.test(tokenAddress))) continue;
      const createdAt = num(entry.pairCreatedAt);
      const marketCap = num(entry.marketCap);
      const fdv = num(entry.fdv);
      out.push({
        chainId,
        tokenAddress,
        name: str(base.name, MAX_NAME_CHARS),
        symbol: str(base.symbol, MAX_SYMBOL_CHARS),
        url: safeUrl(str(entry.url, 2_001)),
        liquidityUsd: (isRecord(entry.liquidity) ? num(entry.liquidity.usd) : undefined) ?? 0,
        volume24hUsd: (isRecord(entry.volume) ? num(entry.volume.h24) : undefined) ?? 0,
        priceChange24hPct: (isRecord(entry.priceChange) ? num(entry.priceChange.h24) : undefined) ?? 0,
        ...(createdAt !== undefined ? { pairCreatedAt: createdAt } : {}),
        ...(marketCap !== undefined ? { marketCapUsd: marketCap } : {}),
        ...(fdv !== undefined ? { fdvUsd: fdv } : {}),
      });
    }
    return out;
  }
}

export interface DexScreenerTrendingOptions {
  client?: DexScreenerClient;
  /** Which chain's boosted tokens become Signals. Default solana, where tokens are launched. */
  chainId?: string;
}

/** Tokens DexScreener's boosts say are trending, one Signal per token. */
export class DexScreenerTrendingSource implements Source {
  readonly id = "dexscreener:trending";
  readonly label = "DexScreener trending";
  private readonly client: DexScreenerClient;
  private readonly chainId: string;

  constructor(opts: DexScreenerTrendingOptions = {}) {
    this.client = opts.client ?? new DexScreenerClient();
    this.chainId = opts.chainId ?? "solana";
  }

  async poll(): Promise<Signal[]> {
    const boosted = (await this.client.topBoosts()).filter((b) => b.chainId === this.chainId).slice(0, MAX_LOOKUP);
    if (boosted.length === 0) return [];
    const pairs = await this.client.tokenPairs(this.chainId, boosted.map((b) => b.tokenAddress));
    // A token trades in several pairs; the deepest one stands for it.
    const deepest = new Map<string, DexPair>();
    for (const p of pairs) {
      const cur = deepest.get(p.tokenAddress);
      if (!cur || p.liquidityUsd > cur.liquidityUsd) deepest.set(p.tokenAddress, p);
    }
    const signals: Signal[] = [];
    for (const b of boosted) {
      const pair = deepest.get(b.tokenAddress);
      if (!pair || !(pair.name || pair.symbol)) continue;
      signals.push({
        id: `${this.id}:${b.chainId}:${b.tokenAddress}`,
        sourceId: this.id,
        sourceLabel: this.label,
        title: `${pair.name || pair.symbol}${pair.name && pair.symbol ? ` ($${pair.symbol})` : ""}`,
        summary: summarize(pair, b.description),
        url: pair.url,
        publishedAt: pair.pairCreatedAt !== undefined ? isoOrEpoch(pair.pairCreatedAt) : new Date(0).toISOString(),
      });
    }
    return signals;
  }
}

function isoOrEpoch(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function summarize(pair: DexPair, description: string): string {
  const stats: string[] = [];
  if (pair.volume24hUsd > 0) stats.push(`24h volume ${usd(pair.volume24hUsd)}`);
  if (pair.priceChange24hPct !== 0) stats.push(`24h change ${pair.priceChange24hPct > 0 ? "+" : ""}${Math.round(pair.priceChange24hPct * 10) / 10}%`);
  if (pair.liquidityUsd > 0) stats.push(`liquidity ${usd(pair.liquidityUsd)}`);
  return `Boosted on DexScreener.${stats.length ? ` ${stats.join(", ")}.` : ""}${description ? ` ${description}` : ""}`.slice(0, MAX_SUMMARY_CHARS);
}
