import { createHash } from "node:crypto";
import { timedFetchText, type FetchText } from "./http.ts";
import type { Signal, Source } from "./source.ts";

export type { FetchText } from "./http.ts";

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

export class RssSource implements Source {
  readonly id: string;
  readonly label: string;
  private readonly url: string;
  private readonly fetchText: FetchText;

  constructor(opts: RssSourceOptions) {
    this.id = opts.id;
    this.label = opts.label;
    this.url = opts.url;
    this.fetchText = opts.fetchText ?? timedFetchText({ what: "RSS", timeoutMs: opts.timeoutMs ?? FEED_FETCH_TIMEOUT_MS, maxBytes: FEED_MAX_BYTES });
  }

  async poll(): Promise<Signal[]> {
    const xml = await this.fetchText(this.url);
    return parseRssItems(xml).map((item) => this.normalize(item));
  }

  private normalize(item: RssItem): Signal {
    // Without a guid the title (with the Source id in the Signal id) is the identity: links often carry changing tracking parameters.
    // Accepted: this changes the id of guid-less items, so they are re-ingested once after the upgrade (bounded by FEED_MAX_ITEMS).
    const identity = item.guid || item.title || item.link;
    return {
      id: `${this.id}:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
      sourceId: this.id,
      sourceLabel: this.label,
      title: (item.titleIsHtml ? stripHtml(decodeEntities(item.title)) : decodeEntities(item.title)).trim().slice(0, MAX_TITLE_CHARS),
      summary: stripHtml(decodeEntities(item.description)).trim().slice(0, MAX_SUMMARY_CHARS),
      url: safeUrl(decodeEntities(item.link).trim()),
      publishedAt: normalizeDate(item.pubDate),
    };
  }
}

export interface RssItem {
  title: string;
  link: string;
  description: string;
  guid?: string;
  pubDate?: string;
  /** Atom `<title type="html">`: the title is markup and its tags are stripped. */
  titleIsHtml?: boolean;
  /** The raw text between `<item>` and `</item>`, for adapters that read extension tags with `tag`. */
  block: string;
}

/** Linear in the input: each `<item>` is found with indexOf, and an item with no close ends the scan. */
export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  // Atom is told by the root element (<feed>, against <rss> or <rdf:RDF>), never by a substring: a CDATA body may hold a literal <item.
  const isAtom = /^(?:[\w.-]+:)?feed$/i.test(rootName(xml));
  const el = isAtom ? "entry" : "item";
  let at = 0;
  while (items.length < FEED_MAX_ITEMS) {
    const open = findOpen(xml, el, at);
    if (open === undefined) break;
    const close = xml.indexOf(`</${el}>`, open.contentStart);
    if (close === -1) break;
    const block = xml.slice(open.contentStart, close);
    at = close + el.length + 3;
    if (isAtom) {
      const title = tag(block, "title");
      const link = atomLink(block);
      if (!title && !link) continue;
      items.push({
        title,
        link,
        description: tag(block, "summary") || tag(block, "content"),
        guid: tag(block, "id").trim() || undefined,
        pubDate: tag(block, "published") || tag(block, "updated") || undefined,
        titleIsHtml: /^x?html$/i.test(attr(openTag(block, "title"), "type")),
        block,
      });
      continue;
    }
    const title = tag(block, "title");
    const link = tag(block, "link");
    if (!title && !link) continue;
    items.push({ title, link, description: tag(block, "description"), guid: tag(block, "guid") || undefined, pubDate: tag(block, "pubDate") || undefined, block });
  }
  return items;
}

/** The name of the first element, skipping the XML declaration, comments and the doctype. Linear. */
function rootName(xml: string): string {
  let i = 0;
  for (;;) {
    i = xml.indexOf("<", i);
    if (i === -1) return "";
    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      if (end === -1) return "";
      i = end + 3;
    } else if (xml[i + 1] === "?" || xml[i + 1] === "!") {
      const end = xml.indexOf(">", i);
      if (end === -1) return "";
      i = end + 1;
    } else {
      const m = /^[^\s/>]*/.exec(xml.slice(i + 1, i + 101));
      return m ? m[0] : "";
    }
  }
}

/** Finds `<name ...>` (not `<names>`) at or after `from`; returns where the tag and its content start. */
function findOpen(s: string, name: string, from: number): { tagStart: number; contentStart: number } | undefined {
  let i = from;
  for (;;) {
    const tagStart = s.indexOf(`<${name}`, i);
    if (tagStart === -1) return undefined;
    const after = s[tagStart + name.length + 1];
    i = tagStart + name.length + 1;
    if (after === ">" || after === " " || after === "\t" || after === "\n" || after === "\r" || after === "/") {
      const end = s.indexOf(">", i);
      if (end === -1) return undefined;
      return { tagStart, contentStart: end + 1 };
    }
  }
}

/** The raw `<name ...>` open tag of the first `<name>` in `block`, or empty. */
function openTag(block: string, name: string): string {
  const open = findOpen(block, name, 0);
  return open ? block.slice(open.tagStart, open.contentStart) : "";
}

/** One literal pattern per attribute we read (no RegExp is built from a name). */
const ATTR_PATTERNS = {
  type: /\stype\s*=\s*(?:"([^"]*)"|'([^']*)')/i,
  rel: /\srel\s*=\s*(?:"([^"]*)"|'([^']*)')/i,
  href: /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/i,
};

/** One attribute's value from an open tag, or empty. The tag is already cut at its `>`. */
function attr(openTagText: string, name: "type" | "rel" | "href"): string {
  const m = ATTR_PATTERNS[name].exec(openTagText);
  return m ? (m[1] ?? m[2] ?? "") : "";
}

/** The href of the first `<link>` that is rel="alternate" or has no rel. */
function atomLink(block: string): string {
  let at = 0;
  for (;;) {
    const open = findOpen(block, "link", at);
    if (!open) return "";
    const text = block.slice(open.tagStart, open.contentStart);
    at = open.contentStart;
    const rel = attr(text, "rel");
    if (rel === "" || rel.toLowerCase() === "alternate") {
      const href = attr(text, "href");
      if (href) return href;
    }
  }
}

/** The text of the first `<name>` element in `block` (CDATA unwrapped), or empty. Linear: it looks at one open tag. */
export function tag(block: string, name: string): string {
  const open = findOpen(block, name, 0);
  if (!open) return "";
  const close = block.indexOf(`</${name}>`, open.contentStart);
  if (close === -1) return "";
  const inner = block.slice(open.contentStart, close);
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner);
  return cdata ? (cdata[1] ?? "") : inner;
}

export const stripHtml = (s: string) => s.replace(/<[^>]*>/g, "");

const NAMED: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

/** One pass, so `&amp;lt;` decodes to `&lt;` and no further. Numeric entities outside Unicode decode to themselves. */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,6})|(lt|gt|quot|apos|amp));/g, (whole, dec?: string, hex?: string, named?: string) => {
    if (named) return NAMED[named]!;
    const cp = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole;
  });
}

/** Feed content is untrusted and rendered as a link: only http(s) survives, and an over-long link is dropped rather than cut. */
export function safeUrl(raw: string): string {
  return raw.length <= MAX_URL_CHARS && /^https?:\/\//i.test(raw) ? raw : "";
}

export function normalizeDate(pubDate?: string): string {
  const d = pubDate ? new Date(pubDate) : new Date(0);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}
