import { HttpError, timedFetchText, type FetchText } from "../../sources/http.ts";
import { decodeEntities, parseRssItems, safeUrl, tag } from "../../sources/rss.ts";
import { cleanTerm } from "../clean.ts";
import { RADAR_CONFIG } from "../config.ts";
import { radarKey } from "../key.ts";
import type { SourceStatus } from "../types.ts";

/**
 * The radar's own reader of Google Trends' realtime RSS (ticket 01). It is not a `Source`: it makes no Signal and writes nothing. It reuses the
 * feed address, the RSS parser and the fetch of `sources/`, and keeps its own backoff per country. The `trends:google` Source keeps polling the
 * US on its own; this is one extra request per country every 15 minutes.
 *
 * An empty answer is never "no trends": a network error, a 429 or a 5xx is `backing off`; a body that is not the feed, or a feed with no items,
 * or items with no traffic figure, is `format changed`. Neither returns a candidate.
 */

export interface Candidate {
  /** `radar:google:US`. */
  sourceId: string;
  /** `radarKey(term)`; never empty. */
  key: string;
  /** Third-party text, cleaned and cut. */
  term: string;
  /** "2000+" as Google wrote it, cleaned. */
  trafficText: string;
  /** The number in "2000+" (a K or M suffix is read); 0 when there is none. */
  trafficMin: number;
  /** The first news item's title (cleaned) and link (http or https only, else empty). */
  newsTitle: string;
  newsUrl: string;
  /** The time of the poll (ISO). */
  at: string;
}

export interface ReadResult {
  sourceId: string;
  status: SourceStatus;
  reason: string;
  candidates: Candidate[];
  /** False when the source was still waiting out its backoff and no request was made. */
  fetched: boolean;
  /** When the next request may be made (epoch ms), or null when none is waiting. */
  waitUntil: number | null;
}

export interface GoogleTrendsReaderOptions {
  /** Replaces the network fetch (tests pass recorded feed XML). */
  fetchText?: FetchText;
  /** Replaces the feed address (tests and local mirrors). The country is appended as `?geo=`. */
  baseUrl?: string;
}

const TRAFFIC_RE = /^(\d+(?:\.\d+)?)\s*([KMB])?\+?$/i;
const MULTIPLIER: Record<string, number> = { K: 1e3, k: 1e3, M: 1e6, m: 1e6, B: 1e9, b: 1e9 };

/** "2000+" is 2000, "1,000+" is 1000, "2M+" is 2,000,000; 0 for anything else. */
export function parseTraffic(text: string): number {
  const m = TRAFFIC_RE.exec(text.replaceAll(",", "").trim());
  if (!m) return 0;
  const n = Number(m[1]) * (m[2] ? (MULTIPLIER[m[2]] ?? 1) : 1);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

const GEO_RE = /^[A-Z]{2}$/;

export class GoogleTrendsReader {
  private readonly fetchText: FetchText;
  private readonly baseUrl: string;
  private readonly state = new Map<string, { failures: number; blockedUntil: number }>();

  constructor(opts: GoogleTrendsReaderOptions = {}) {
    this.baseUrl = opts.baseUrl ?? RADAR_CONFIG.googleUrl;
    this.fetchText = opts.fetchText ?? timedFetchText({ what: "Google Trends", timeoutMs: RADAR_CONFIG.fetchTimeoutMs, maxBytes: RADAR_CONFIG.fetchMaxBytes });
  }

  /** One country. Never throws: whatever happens is the result's status. `nowMs` is the poll time. */
  async read(geo: string, nowMs: number): Promise<ReadResult> {
    const sourceId = `radar:google:${geo}`;
    const st = this.state.get(sourceId) ?? { failures: 0, blockedUntil: 0 };
    this.state.set(sourceId, st);
    const result = (status: SourceStatus, reason: string, over: Partial<ReadResult> = {}): ReadResult => ({ sourceId, status, reason, candidates: [], fetched: true, waitUntil: st.blockedUntil > nowMs ? st.blockedUntil : null, ...over });
    if (!GEO_RE.test(geo)) return result("down", `"${cleanTerm(geo, 8)}" is not a two-letter country code`, { fetched: false });
    if (nowMs < st.blockedUntil) return result(st.failures >= RADAR_CONFIG.downAfterFailures ? "down" : "backing off", "waiting out the backoff", { fetched: false });

    let xml: string;
    try {
      xml = await this.fetchText(`${this.baseUrl}?geo=${geo}`);
    } catch (e) {
      st.failures++;
      const exponential = RADAR_CONFIG.backoffBaseMs * 2 ** Math.min(st.failures - 1, 20);
      const asked = e instanceof HttpError ? (e.retryAfterMs ?? 0) : 0;
      st.blockedUntil = nowMs + Math.min(Math.max(exponential, asked), RADAR_CONFIG.backoffMaxMs);
      const why = e instanceof HttpError ? `HTTP ${e.status}` : cleanTerm(e instanceof Error ? e.message : String(e), 120);
      return result(st.failures >= RADAR_CONFIG.downAfterFailures ? "down" : "backing off", why, { waitUntil: st.blockedUntil });
    }
    // The answer arrived: the fetch failures are over, whatever the body says.
    st.failures = 0;
    st.blockedUntil = 0;
    const parsed = parseFeed(xml, sourceId, new Date(nowMs).toISOString());
    if (parsed.problem !== null) return result("format changed", parsed.problem, { waitUntil: null });
    return result("ok", "", { candidates: parsed.candidates, waitUntil: null });
  }
}

/** The candidates of one feed body, or the reason it is not the feed it should be. Linear in the body. */
function parseFeed(xml: string, sourceId: string, at: string): { problem: string | null; candidates: Candidate[] } {
  if (xml.trim() === "") return { problem: "the answer was empty", candidates: [] };
  const items = parseRssItems(xml).slice(0, RADAR_CONFIG.maxItemsPerFeed);
  if (items.length === 0) return { problem: "the answer is not the feed or has no items", candidates: [] };
  const byKey = new Map<string, Candidate>();
  let withTraffic = 0;
  for (const item of items) {
    const trafficText = cleanTerm(decodeEntities(tag(item.block, "ht:approx_traffic")), 40);
    const trafficMin = parseTraffic(trafficText);
    if (trafficMin > 0) withTraffic++;
    const term = cleanTerm(decodeEntities(item.title));
    const key = radarKey(term);
    if (key === "") continue;
    const news = tag(item.block, "ht:news_item");
    const candidate: Candidate = {
      sourceId,
      key,
      term,
      trafficText,
      trafficMin,
      newsTitle: cleanTerm(decodeEntities(tag(news, "ht:news_item_title")), RADAR_CONFIG.newsTitleChars),
      newsUrl: safeUrl(decodeEntities(tag(news, "ht:news_item_url")).trim()),
      at,
    };
    const have = byKey.get(key);
    if (!have || candidate.trafficMin > have.trafficMin) byKey.set(key, candidate);
  }
  if (withTraffic === 0) return { problem: "no item carries a traffic figure", candidates: [] };
  return { problem: null, candidates: [...byKey.values()] };
}
