import { HttpError, timedFetchConditional, type FetchConditional } from "../../sources/http.ts";
import { decodeEntities, parseRssItems, safeUrl } from "../../sources/rss.ts";
import { cleanTerm } from "../clean.ts";
import { RADAR_CONFIG } from "../config.ts";
import type { RadarFeed } from "../feeds.ts";
import type { SourceStatus } from "../types.ts";

/**
 * The radar's reader of its own news feeds (ticket 02). Like the Google reader it is not a `Source`: it makes no Signal and writes nothing. One
 * conditional GET per feed (ETag or Last-Modified, so a 304 is a good poll with no new items), the 2 MB cap and 10 s timeout of `sources/http.ts`,
 * the RSS parser of `sources/rss.ts`, and a status per feed: `ok`, `backing off` (a network error, a 429 or a 5xx, with a doubling wait that honours
 * Retry-After), `format changed` (an answer that is not a feed, has no items, or has no readable dates) and `down` (3 failures in a row; retried hourly).
 * A feed failing never stops the others, and an empty answer is never "nothing new".
 *
 * Every headline passes `cleanTerm` and every link `safeUrl` here, before anything is counted or stored; the raw item text goes no further.
 */

export interface FeedItem {
  /** Cleaned (`cleanTerm`): one flat line, markup removed, at most 300 characters. */
  title: string;
  /** `safeUrl`: http(s) and short, or "". */
  url: string;
  /** The item's own date (epoch ms). */
  at: number;
}

export interface FeedReadResult {
  sourceId: string;
  status: SourceStatus;
  reason: string;
  items: FeedItem[];
  /** False when the feed was still waiting out its backoff and no request was made. */
  fetched: boolean;
  /** True for a 304: a good poll with no new items. */
  notModified: boolean;
  /** Items left out because they had no readable date (they could not be told from old ones). */
  undated: number;
  waitUntil: number | null;
}

export interface RssFeedReaderOptions {
  /** Replaces the network fetch (tests pass recorded feed XML). */
  fetch?: FetchConditional;
}

interface FeedState {
  failures: number;
  blockedUntil: number;
  etag?: string;
  lastModified?: string;
}

/** A validator comes back to us from a server: keep it only if it is short printable ASCII, so it can never carry a header break. */
function validator(v: string | undefined): string | undefined {
  if (v === undefined || v.length === 0 || v.length > 200) return undefined;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return undefined;
  }
  return v;
}

export class RssFeedReader {
  private readonly fetch: FetchConditional;
  private readonly state = new Map<string, FeedState>();

  constructor(opts: RssFeedReaderOptions = {}) {
    this.fetch =
      opts.fetch ??
      timedFetchConditional({
        what: "news feed",
        timeoutMs: RADAR_CONFIG.fetchTimeoutMs,
        maxBytes: RADAR_CONFIG.fetchMaxBytes,
        headers: { "user-agent": RADAR_CONFIG.userAgent, accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5" },
      });
  }

  /** One feed. Never throws: whatever happens is the result's status. `nowMs` is the poll time. */
  async read(feed: RadarFeed, nowMs: number): Promise<FeedReadResult> {
    const sourceId = feed.id;
    const st = this.state.get(sourceId) ?? { failures: 0, blockedUntil: 0 };
    this.state.set(sourceId, st);
    const failedStatus = (): SourceStatus => (st.failures >= RADAR_CONFIG.downAfterFailures ? "down" : "backing off");
    const result = (status: SourceStatus, reason: string, over: Partial<FeedReadResult> = {}): FeedReadResult => ({
      sourceId,
      status,
      reason,
      items: [],
      fetched: true,
      notModified: false,
      undated: 0,
      waitUntil: st.blockedUntil > nowMs ? st.blockedUntil : null,
      ...over,
    });
    if (nowMs < st.blockedUntil) return result(failedStatus(), "waiting out the backoff", { fetched: false });

    let answer;
    try {
      answer = await this.fetch(feed.url, { etag: st.etag, lastModified: st.lastModified });
    } catch (e) {
      st.failures++;
      const exponential = RADAR_CONFIG.backoffBaseMs * 2 ** Math.min(st.failures - 1, 20);
      const asked = e instanceof HttpError ? (e.retryAfterMs ?? 0) : 0;
      st.blockedUntil = nowMs + Math.min(Math.max(exponential, asked), RADAR_CONFIG.backoffMaxMs);
      const why = e instanceof HttpError ? `HTTP ${e.status}` : cleanTerm(e instanceof Error ? e.message : String(e), 120);
      return result(failedStatus(), why, { waitUntil: st.blockedUntil });
    }
    // The answer arrived: the fetch failures are over, whatever the body says.
    st.failures = 0;
    st.blockedUntil = 0;
    if (answer.notModified) return result("ok", "", { notModified: true, waitUntil: null });
    const parsed = parseFeed(answer.body, nowMs);
    if (parsed.problem !== null) return result("format changed", parsed.problem, { waitUntil: null });
    // Validators are kept only for a body that was a feed, so a changed page is read again whole next time.
    st.etag = validator(answer.etag);
    st.lastModified = validator(answer.lastModified);
    return result("ok", "", { items: parsed.items, undated: parsed.undated, waitUntil: null });
  }
}

/** The items of one feed body that are fresh enough to count, or the reason the body is not the feed it should be. Linear in the body. */
function parseFeed(body: string, nowMs: number): { problem: string | null; items: FeedItem[]; undated: number } {
  if (body.trim() === "") return { problem: "the answer was empty", items: [], undated: 0 };
  const raw = parseRssItems(body).slice(0, RADAR_CONFIG.maxItemsPerFeed);
  if (raw.length === 0) return { problem: "the answer is not a feed or has no items", items: [], undated: 0 };
  const items: FeedItem[] = [];
  let undated = 0;
  for (const item of raw) {
    const dated = item.pubDate === undefined ? Number.NaN : Date.parse(item.pubDate);
    if (!Number.isFinite(dated)) {
      undated++;
      continue;
    }
    const at = Math.min(dated, nowMs); // a date in the future is read as now
    if (at < nowMs - RADAR_CONFIG.itemMaxAgeMs) continue;
    const title = cleanTerm(decodeEntities(item.title), RADAR_CONFIG.newsTitleChars);
    if (title === "") continue;
    items.push({ title, url: safeUrl(decodeEntities(item.link).trim()), at });
  }
  if (undated === raw.length) return { problem: "no item carries a readable date", items: [], undated };
  return { problem: null, items, undated };
}
