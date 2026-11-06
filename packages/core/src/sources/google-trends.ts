import { createHash } from "node:crypto";
import { timedFetchText, type FetchText } from "./http.ts";
import { decodeEntities, normalizeDate, parseRssItems, safeUrl, stripHtml, tag, type RssItem } from "./rss.ts";
import type { Signal, Source } from "./source.ts";

/** Google's trending-searches feed: unauthenticated, one `<item>` per trending term. */
const TRENDS_URL = "https://trends.google.com/trending/rss";
const TRENDS_TIMEOUT_MS = 10_000;
const TRENDS_MAX_BYTES = 2 * 1024 * 1024;
const MAX_TERM_CHARS = 300;
const MAX_SUMMARY_CHARS = 1_000;

export interface GoogleTrendsOptions {
  /** ISO country code of the feed, default US. */
  geo?: string;
  /** Replaces the network fetch (tests pass recorded feed XML). */
  fetchText?: FetchText;
  /** Overrides the feed address (for tests and local mirrors). The country is appended as `?geo=`. */
  baseUrl?: string;
  timeoutMs?: number;
}

/** Trending search terms from Google Trends RSS (helios `trends-feeds` pattern), one Signal per term. */
export class GoogleTrendsSource implements Source {
  readonly id = "trends:google";
  readonly label = "Google Trends";
  private readonly url: string;
  private readonly fetchText: FetchText;

  constructor(opts: GoogleTrendsOptions = {}) {
    this.url = `${opts.baseUrl ?? TRENDS_URL}?geo=${encodeURIComponent(opts.geo ?? "US")}`;
    this.fetchText = opts.fetchText ?? timedFetchText({ what: "Google Trends", timeoutMs: opts.timeoutMs ?? TRENDS_TIMEOUT_MS, maxBytes: TRENDS_MAX_BYTES });
  }

  async poll(): Promise<Signal[]> {
    const xml = await this.fetchText(this.url);
    return parseRssItems(xml)
      .filter((item) => item.title.trim() !== "")
      .map((item) => this.normalize(item));
  }

  private normalize(item: RssItem): Signal {
    const term = decodeEntities(item.title).trim().slice(0, MAX_TERM_CHARS);
    const traffic = decodeEntities(tag(item.block, "ht:approx_traffic")).trim().slice(0, 40);
    const news = tag(item.block, "ht:news_item");
    const newsTitle = stripHtml(decodeEntities(tag(news, "ht:news_item_title"))).trim();
    const snippet = stripHtml(decodeEntities(tag(news, "ht:news_item_snippet"))).trim();
    const lead = `Trending on Google${traffic ? `, about ${traffic} searches` : ""}.`;
    const story = newsTitle ? ` ${newsTitle}${snippet ? `: ${snippet}` : ""}` : "";
    // A term trends for a stretch with one pubDate, so term + pubDate is one Signal for the whole run and a later re-trend is a new one.
    const identity = `${term.toLowerCase()}|${item.pubDate ?? ""}`;
    return {
      id: `${this.id}:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
      sourceId: this.id,
      sourceLabel: this.label,
      title: term,
      summary: `${lead}${story}`.slice(0, MAX_SUMMARY_CHARS),
      url: safeUrl(decodeEntities(tag(news, "ht:news_item_url")).trim()) || safeUrl(decodeEntities(item.link).trim()),
      publishedAt: normalizeDate(item.pubDate),
    };
  }
}
