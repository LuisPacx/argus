import type { FetchText } from "./http.ts";
import { amount, isoTime, listFetch, listOf, MAX_NAME_CHARS, MAX_SYMBOL_CHARS, MAX_TAG_CHARS, MAX_TAGS, MINT_RE, parseJson, text } from "./trending-common.ts";
import { isRecord } from "./untrusted-text.ts";

/**
 * Jupiter's public trending-token list, read only (meta-redesign ticket 05, ADR 0015 decision 1). This is the one module the ADR 0002 test
 * lets name Jupiter's host, and only for the `/tokens/v2/toptrending/` list: no quote, swap, price-for-trading or wallet endpoint, no key,
 * no SDK. The prefix below is the whole allowance; a path is appended to it, never a host. The keyless service allows 5 calls in a short
 * window, so the Meta tick makes one request here (and at most two retries of it).
 */

/** The pinned list prefix. Widening it, or naming any other Jupiter path, needs the Operator's say-so (ADR 0002 test). */
export const TOPTRENDING_PREFIX = "https://lite-api.jup.ag/tokens/v2/toptrending/";

export type TrendingInterval = "5m" | "1h" | "6h" | "24h";
const MAX_LIMIT = 100;

/** One trending token as the Meta tick uses it. Numbers are absent (never 0) when the answer had none or a bad one. */
export interface JupiterToken {
  mint: string;
  name: string;
  symbol: string;
  /** `mcap` in USD. */
  marketCapUsd?: number;
  fdvUsd?: number;
  /** Token-level liquidity across its pools, USD. */
  liquidityUsd?: number;
  /** Buy plus sell volume of the last 24 h, USD. */
  volume24hUsd?: number;
  holderCount?: number;
  organicScore?: number;
  /** When the token's first pool was created (ISO). */
  createdAt?: string;
  /** Jupiter's own labels (`verified`, `stocks`, `rwa`, ...), cut. */
  tags: string[];
}

export interface JupiterClientOptions {
  /** Replaces the network fetch (tests pass recorded JSON). */
  fetchText?: FetchText;
  /** Replaces `TOPTRENDING_PREFIX` (a test's loopback server or a local mirror); must end in a slash. */
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  retryBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Called before every HTTP request, retries included (the per-tick call budget). */
  onRequest?: () => void;
}

const sum = (a: number | undefined, b: number | undefined): number | undefined => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));

/** Read-only client of Jupiter's trending list. */
export class JupiterTokensClient {
  private readonly fetchText: FetchText;
  private readonly prefix: string;

  constructor(opts: JupiterClientOptions = {}) {
    this.prefix = opts.baseUrl ?? TOPTRENDING_PREFIX;
    this.fetchText = listFetch({ what: "Jupiter", ...opts });
  }

  /** The trending tokens of one interval, in Jupiter's order (rank 1 first), at most 100. Throws on an answer that is not JSON or not a list. */
  async topTrending(interval: TrendingInterval = "1h", limit = 50): Promise<JupiterToken[]> {
    const n = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
    const data = parseJson("Jupiter", await this.fetchText(`${this.prefix}${interval}?limit=${n}`));
    const out: JupiterToken[] = [];
    for (const entry of listOf("Jupiter", data)) {
      if (!isRecord(entry)) continue;
      const mint = typeof entry.id === "string" ? entry.id : "";
      if (!MINT_RE.test(mint)) continue;
      const stats = isRecord(entry.stats24h) ? entry.stats24h : {};
      const marketCap = amount(entry.mcap);
      const fdv = amount(entry.fdv);
      const liquidity = amount(entry.liquidity);
      const volume = sum(amount(stats.buyVolume), amount(stats.sellVolume));
      const holders = amount(entry.holderCount);
      const organic = amount(entry.organicScore);
      const created = isRecord(entry.firstPool) ? isoTime(entry.firstPool.createdAt) : undefined;
      const tags = Array.isArray(entry.tags) ? entry.tags.slice(0, MAX_TAGS).map((t) => text(t, MAX_TAG_CHARS)).filter((t) => t !== "") : [];
      out.push({
        mint,
        name: text(entry.name, MAX_NAME_CHARS),
        symbol: text(entry.symbol, MAX_SYMBOL_CHARS),
        ...(marketCap !== undefined ? { marketCapUsd: marketCap } : {}),
        ...(fdv !== undefined ? { fdvUsd: fdv } : {}),
        ...(liquidity !== undefined ? { liquidityUsd: liquidity } : {}),
        ...(volume !== undefined ? { volume24hUsd: volume } : {}),
        ...(holders !== undefined ? { holderCount: holders } : {}),
        ...(organic !== undefined ? { organicScore: organic } : {}),
        ...(created !== undefined ? { createdAt: created } : {}),
        tags,
      });
    }
    return out;
  }
}
