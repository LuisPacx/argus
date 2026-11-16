import type { FetchText } from "./http.ts";
import { amount, isoTime, listFetch, listOf, MAX_NAME_CHARS, MAX_SYMBOL_CHARS, MINT_RE, parseJson, text } from "./trending-common.ts";
import { isRecord } from "./untrusted-text.ts";

/**
 * GeckoTerminal's public Solana trending pools, read only (meta-redesign ticket 05, ADR 0015 decision 1). Keyless; the public limit is 30
 * calls a minute and a page holds 20 pools, so the Meta tick reads at most 3 pages. A pool's base token is the token; one token can sit in
 * several pools, so the caller merges on the mint.
 */

const API_BASE = "https://api.geckoterminal.com";
/** Pinning the API version keeps the field set stable. */
const ACCEPT = "application/json;version=20230302";
const TOKEN_ID_PREFIX = "solana_";
/** Pools on one page (the service's fixed page size). */
export const POOLS_PER_PAGE = 20;
const MAX_PAGE = 10;

/** One trending pool, reduced to what the Meta tick uses, keyed by its base token. Numbers are absent when the answer had none or a bad one. */
export interface GeckoPool {
  /** The base token's mint. */
  mint: string;
  name: string;
  symbol: string;
  /** `market_cap_usd` when present and positive, else `fdv_usd`. GeckoTerminal leaves the market cap null for most memecoins. */
  marketCapUsd?: number;
  fdvUsd?: number;
  /** This pool's reserves in USD. */
  liquidityUsd?: number;
  volume24hUsd?: number;
  /** When the pool was created (ISO). */
  createdAt?: string;
}

export interface GeckoTerminalClientOptions {
  /** Replaces the network fetch (tests pass recorded JSON). */
  fetchText?: FetchText;
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  retryBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Called before every HTTP request, retries included (the per-tick call budget). */
  onRequest?: () => void;
}

const positive = (n: number | undefined): number | undefined => (n !== undefined && n > 0 ? n : undefined);

/** Read-only GeckoTerminal client. */
export class GeckoTerminalClient {
  private readonly fetchText: FetchText;
  private readonly baseUrl: string;

  constructor(opts: GeckoTerminalClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? API_BASE;
    this.fetchText = listFetch({ what: "GeckoTerminal", headers: { accept: ACCEPT }, ...opts });
  }

  /** One page of trending Solana pools in GeckoTerminal's order (best first), 20 at most. Throws on an answer that is not JSON or has no `data` list. */
  async trendingPools(page = 1): Promise<GeckoPool[]> {
    const p = Math.max(1, Math.min(MAX_PAGE, Math.floor(page)));
    const data = parseJson("GeckoTerminal", await this.fetchText(`${this.baseUrl}/api/v2/networks/solana/trending_pools?include=base_token&page=${p}`));
    if (!isRecord(data)) throw new Error("GeckoTerminal: unexpected response (no data list)");
    const pools = listOf("GeckoTerminal", data.data);
    // The included tokens carry the names; an entry that is not a token record, or has no usable id, is skipped.
    const tokens = new Map<string, Record<string, unknown>>();
    if (Array.isArray(data.included))
      for (const t of data.included.slice(0, 2 * pools.length + 2)) if (isRecord(t) && typeof t.id === "string" && isRecord(t.attributes)) tokens.set(t.id, t.attributes);

    const out: GeckoPool[] = [];
    for (const entry of pools) {
      if (!isRecord(entry) || !isRecord(entry.attributes) || !isRecord(entry.relationships)) continue;
      const base = entry.relationships.base_token;
      const tokenId = isRecord(base) && isRecord(base.data) && typeof base.data.id === "string" ? base.data.id : "";
      if (!tokenId.startsWith(TOKEN_ID_PREFIX)) continue;
      const mint = tokenId.slice(TOKEN_ID_PREFIX.length);
      if (!MINT_RE.test(mint)) continue;
      const a = entry.attributes;
      const token = tokens.get(tokenId);
      const poolName = text(a.name, 2 * MAX_SYMBOL_CHARS + 6);
      const symbol = text(token?.symbol, MAX_SYMBOL_CHARS) || text(poolName.split(" / ")[0], MAX_SYMBOL_CHARS);
      const fdv = amount(a.fdv_usd);
      const marketCap = positive(amount(a.market_cap_usd)) ?? positive(fdv);
      const liquidity = amount(a.reserve_in_usd);
      const volume = isRecord(a.volume_usd) ? amount(a.volume_usd.h24) : undefined;
      const created = isoTime(a.pool_created_at);
      out.push({
        mint,
        name: text(token?.name, MAX_NAME_CHARS),
        symbol,
        ...(marketCap !== undefined ? { marketCapUsd: marketCap } : {}),
        ...(fdv !== undefined ? { fdvUsd: fdv } : {}),
        ...(liquidity !== undefined ? { liquidityUsd: liquidity } : {}),
        ...(volume !== undefined ? { volume24hUsd: volume } : {}),
        ...(created !== undefined ? { createdAt: created } : {}),
      });
    }
    return out;
  }
}
