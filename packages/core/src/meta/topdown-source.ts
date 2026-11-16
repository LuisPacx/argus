import { GeckoTerminalClient, type GeckoPool } from "../sources/geckoterminal.ts";
import type { FetchText } from "../sources/http.ts";
import { JupiterTokensClient, type JupiterToken } from "../sources/jupiter.ts";
import type { MetaConfig } from "./config.ts";
import { topDownCandidates, type TopDownResult } from "./topdown.ts";

/**
 * The network half of the top-down leaders (ADR 0015 decision 1): one Meta tick reads Jupiter's trending list once and GeckoTerminal's
 * trending pools page by page, within one request budget (`topDownCalls`, default 5) counted at the HTTP request, retries included. A normal
 * tick makes 4 requests (1 + 3 pages); Jupiter's own retries are at most 2, so it never makes more than 3 in a tick and the keyless service's
 * 5-call window is never reached by this job. The request after the budget throws a plain error, which the retry wrapper never retries.
 * Nothing here is fatal: a failed list is an entry in `errors` and the other list still counts.
 */

export const TOPDOWN_BUDGET_ERROR = "top-down call budget used";

/** How many GeckoTerminal pages one tick reads (20 pools each), and how many Jupiter tokens it asks for. */
export const GECKO_PAGES = 3;
export const JUPITER_LIMIT = 50;

export interface TopDownReaderOptions {
  config: Pick<MetaConfig, "topDownCalls" | "topDownMinLiquidityUsd" | "topDownMaxCapLiquidityRatio" | "topDownMinVolumeUsd">;
  /** Replaces the Jupiter list prefix (a loopback server or mirror). */
  jupiterUrl?: string;
  /** Replaces GeckoTerminal's base URL. */
  geckoUrl?: string;
  /** Replace the network fetch of one list (tests pass recorded JSON). */
  fetchJupiter?: FetchText;
  fetchGecko?: FetchText;
  /** Make the retries run on an injected timer and say where retries are noted. Retries are on (2) whenever one of these is set. */
  retries?: number;
  retryBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * A function that reads both lists once and returns the filtered candidates. The request counter is made fresh on every call, so each
 * Meta tick has its own budget.
 */
export function createTopDownReader(opts: TopDownReaderOptions): () => Promise<TopDownResult> {
  return async () => {
    let requests = 0;
    const onRequest = () => {
      if (requests >= opts.config.topDownCalls) throw new Error(TOPDOWN_BUDGET_ERROR);
      requests++;
    };
    const shared = { onRequest, ...(opts.retries !== undefined ? { retries: opts.retries } : {}), ...(opts.retryBaseMs !== undefined ? { retryBaseMs: opts.retryBaseMs } : {}), ...(opts.sleep ? { sleep: opts.sleep } : {}), ...(opts.log ? { log: opts.log } : {}) };
    const jupiterClient = new JupiterTokensClient({ ...shared, ...(opts.jupiterUrl ? { baseUrl: opts.jupiterUrl } : {}), ...(opts.fetchJupiter ? { fetchText: opts.fetchJupiter } : {}) });
    const geckoClient = new GeckoTerminalClient({ ...shared, ...(opts.geckoUrl ? { baseUrl: opts.geckoUrl } : {}), ...(opts.fetchGecko ? { fetchText: opts.fetchGecko } : {}) });
    const errors: string[] = [];

    let jupiter: JupiterToken[] = [];
    try {
      jupiter = await jupiterClient.topTrending("1h", JUPITER_LIMIT);
    } catch (e) {
      errors.push(`jupiter: ${message(e)}`);
    }

    const gecko: GeckoPool[] = [];
    for (let page = 1; page <= GECKO_PAGES; page++) {
      try {
        const pools = await geckoClient.trendingPools(page);
        gecko.push(...pools);
        if (pools.length === 0) break;
      } catch (e) {
        errors.push(`geckoterminal page ${page}: ${message(e)}`);
        break; // a failing host fails the next page too, and each try costs budget
      }
    }

    return { ...topDownCandidates({ jupiter, gecko, config: opts.config }), requests, errors };
  };
}
