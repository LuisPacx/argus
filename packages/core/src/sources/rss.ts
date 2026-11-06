import { createHash } from "node:crypto";
import type { Signal, Source } from "./source.ts";

export type FetchText = (url: string) => Promise<string>;

/** A feed that takes longer than this to answer (headers and body) fails its poll, so one hung feed cannot stall the tick. */
export const FEED_FETCH_TIMEOUT_MS = 10_000;
/** A feed body larger than this fails its poll: feeds are untrusted and a hostile one could be endless. */
export const FEED_MAX_BYTES = 2 * 1024 * 1024;
/** Only the first this-many items of a feed are taken. */
export const FEED_MAX_ITEMS = 100;
const MAX_TITLE_CHARS = 300;
const MAX_SUMMARY_CHARS = 1_000;
const MAX_URL_CHARS = 2_000;

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

/** Reads a body as text, cancelling the stream as soon as it passes `maxBytes`. */
async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`RSS body too large (over ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Fetches with a timer that stays armed until the body is read, so a trickled body is bounded too. */
function timedFetchText(timeoutMs: number): FetchText {
  return async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`);
      return await readLimited(res, FEED_MAX_BYTES);
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
      title: decodeEntities(item.title).trim().slice(0, MAX_TITLE_CHARS),
      summary: stripHtml(decodeEntities(item.description)).trim().slice(0, MAX_SUMMARY_CHARS),
      url: safeUrl(decodeEntities(item.link).trim()),
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

/** Linear in the input: each `<item>` is found with indexOf, and an item with no close ends the scan. */
function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  let at = 0;
  while (items.length < FEED_MAX_ITEMS) {
    const open = findOpen(xml, "item", at);
    if (open === undefined) break;
    const close = xml.indexOf("</item>", open.contentStart);
    if (close === -1) break;
    const block = xml.slice(open.contentStart, close);
    at = close + "</item>".length;
    const title = tag(block, "title");
    const link = tag(block, "link");
    if (!title && !link) continue;
    items.push({ title, link, description: tag(block, "description"), guid: tag(block, "guid") || undefined, pubDate: tag(block, "pubDate") || undefined });
  }
  return items;
}

/** Finds `<name ...>` (not `<names>`) at or after `from`; returns where its content starts. */
function findOpen(s: string, name: string, from: number): { contentStart: number } | undefined {
  let i = from;
  for (;;) {
    i = s.indexOf(`<${name}`, i);
    if (i === -1) return undefined;
    const after = s[i + name.length + 1];
    i += name.length + 1;
    if (after === ">" || after === " " || after === "\t" || after === "\n" || after === "\r" || after === "/") {
      const end = s.indexOf(">", i);
      if (end === -1) return undefined;
      return { contentStart: end + 1 };
    }
  }
}

/** The text of the first `<name>` element in `block` (CDATA unwrapped), or empty. Linear: it looks at one open tag. */
function tag(block: string, name: string): string {
  const open = findOpen(block, name, 0);
  if (!open) return "";
  const close = block.indexOf(`</${name}>`, open.contentStart);
  if (close === -1) return "";
  const inner = block.slice(open.contentStart, close);
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner);
  return cdata ? (cdata[1] ?? "") : inner;
}

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, "");

const NAMED: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

/** One pass, so `&amp;lt;` decodes to `&lt;` and no further. Numeric entities outside Unicode decode to themselves. */
function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,6})|(lt|gt|quot|apos|amp));/g, (whole, dec?: string, hex?: string, named?: string) => {
    if (named) return NAMED[named]!;
    const cp = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole;
  });
}

/** Feed content is untrusted and rendered as a link: only http(s) survives, and an over-long link is dropped rather than cut. */
function safeUrl(raw: string): string {
  return raw.length <= MAX_URL_CHARS && /^https?:\/\//i.test(raw) ? raw : "";
}

function normalizeDate(pubDate?: string): string {
  const d = pubDate ? new Date(pubDate) : new Date(0);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}
