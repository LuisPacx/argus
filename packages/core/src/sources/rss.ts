import { createHash } from "node:crypto";
import type { Signal, Source } from "./source.ts";

export type FetchText = (url: string) => Promise<string>;

/** A feed that takes longer than this to answer (headers and body) fails its poll, so one hung feed cannot stall the tick. */
export const FEED_FETCH_TIMEOUT_MS = 10_000;

export interface RssSourceOptions {
  /** Stable id stamped onto every Signal, e.g. `rss:apnews`. */
  id: string;
  label: string;
  url: string;
  /** Replaces the network fetch (tests pass recorded feed XML). */
  fetchText?: FetchText;
  /** Bound on the default fetch. */
  timeoutMs?: number;
}

/** Fetches with a timer that stays armed until the body is read, so a trickled body is bounded too. */
function timedFetchText(timeoutMs: number): FetchText {
  return async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  };
}

export class RssSource implements Source {
  readonly id: string;
  readonly label: string;
  private readonly url: string;
  private readonly fetchText: FetchText;

  constructor(opts: RssSourceOptions) {
    this.id = opts.id;
    this.label = opts.label;
    this.url = opts.url;
    this.fetchText = opts.fetchText ?? timedFetchText(opts.timeoutMs ?? FEED_FETCH_TIMEOUT_MS);
  }

  async poll(): Promise<Signal[]> {
    const xml = await this.fetchText(this.url);
    return parseRssItems(xml).map((item) => this.normalize(item));
  }

  private normalize(item: RssItem): Signal {
    const identity = item.guid || item.link || item.title;
    return {
      id: `${this.id}:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
      sourceId: this.id,
      sourceLabel: this.label,
      title: decodeEntities(item.title).trim(),
      summary: stripHtml(decodeEntities(item.description)).trim(),
      url: safeUrl(item.link.trim()),
      publishedAt: normalizeDate(item.pubDate),
    };
  }
}

interface RssItem {
  title: string;
  link: string;
  description: string;
  guid?: string;
  pubDate?: string;
}

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = m[1] ?? "";
    const title = tag(block, "title");
    const link = tag(block, "link");
    if (!title && !link) continue;
    items.push({
      title,
      link,
      description: tag(block, "description"),
      guid: tag(block, "guid") || undefined,
      pubDate: tag(block, "pubDate") || undefined,
    });
  }
  return items;
}

function tag(block: string, name: string): string {
  const found = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
  if (!found) return "";
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(found[1] ?? "");
  return cdata ? (cdata[1] ?? "") : (found[1] ?? "");
}

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, "");

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** Feed content is untrusted and rendered as a link: only http(s) survives. */
function safeUrl(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : "";
}

function normalizeDate(pubDate?: string): string {
  const d = pubDate ? new Date(pubDate) : new Date(0);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}
