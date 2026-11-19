import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Datastore } from "../../datastore.ts";
import { aFeed, anOkRead, at } from "../../testing/radar.ts";
import { tempDir } from "../../testing/temp.ts";
import { RADAR_CONFIG } from "../config.ts";
import type { RadarFeed } from "../feeds.ts";
import { createRadarJob } from "../job.ts";
import { RssFeedReader } from "./rss.ts";

/**
 * Storage of feed text (ticket 02): a real Datastore on a temp dir and the real feed reader over hostile bodies. Whatever a feed puts in a headline or
 * a link, what reaches `radar_readings` and `radar_trends` is flat, markup-free and cut, and a link that is not a plain http(s) address is stored empty.
 */
const CUT = RADAR_CONFIG.newsTitleChars + 1;

/** The code points of a string that the cleaner removes: angle brackets, control characters (line breaks included) and the bidi controls. */
function removable(text: string): string[] {
  const found: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === "<" || ch === ">" || cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) found.push(`U+${cp.toString(16)}`);
  }
  return found;
}
const FEEDS =["alpha", "bravo", "charlie", "delta"].map((s) => aFeed(s));
const HOSTILE_TITLE = `Zelda <script>alert(1)</script> movie\u0007\u0000\nleak <img src=x onerror=alert(1)> trailer\r\n\t drops ${String.fromCharCode(0x202e)} ${"A".repeat(100_000)}`;
const LINKS: Record<string, string> = {
  "radar:alpha": "javascript:alert(1)",
  "radar:bravo": "data:text/html,<script>alert(1)</script>",
  "radar:charlie": `https://news.example/${"a".repeat(3_000)}`,
  "radar:delta": "https://news.example/zelda?x=1",
};

const rss = (title: string, link: string, publishedAt: Date) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><title><![CDATA[${title}]]></title><link>${link.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</link><pubDate>${publishedAt.toUTCString()}</pubDate></item></channel></rss>`;

describe("hostile feed text, stored", () => {
  it("is flattened, markup-free and cut to the cleaner's limit; a javascript:, data: or over-long link is stored empty", async () => {
    const file = path.join(tempDir("radar-storage-"), "argus.db");
    const store = Datastore.open(file);
    let minutes = 0;
    const fetch = async (url: string) => {
      const feed = FEEDS.find((f) => f.url === url) as RadarFeed;
      const body = minutes === 0 ? rss("Dull headline about the weather", "https://news.example/dull", at(minutes - 5)) : rss(HOSTILE_TITLE, LINKS[feed.id]!, at(minutes - 5));
      return { notModified: false as const, body };
    };
    const job = createRadarJob({
      store,
      settings: { enabled: true, searchesPerTick: 30 },
      geos: ["US"],
      reader: { read: async (geo) => anOkRead([], `radar:google:${geo}`) },
      feedReader: new RssFeedReader({ fetch }),
      feeds: FEEDS,
      dex: { search: async () => [] },
      now: () => at(minutes),
      sleep: async () => {},
    });
    await job();
    minutes = 200;
    const r = await job();
    expect(r.newTrends).toBe(1);
    store.close();

    const raw = new DatabaseSync(file);
    const readings = raw.prepare("SELECT source, key, term, news_title, news_url FROM radar_readings").all() as Array<Record<string, string>>;
    expect(readings.length).toBeGreaterThanOrEqual(4);
    // Anything the cleaner removes: markup brackets, control characters, line breaks, the bidi override.
    for (const row of readings) {
      for (const col of ["term", "news_title", "news_url", "key"]) expect(removable(row[col]!), `${row.source} ${col}`).toEqual([]);
      expect(row.news_title!.length, row.source).toBeLessThanOrEqual(CUT); // the cleaner's cut leaves one ellipsis after the limit
      expect(row.term!.length, row.source).toBeLessThanOrEqual(CUT);
    }
    expect(readings.every((x) => x.news_title!.startsWith("Zelda"))).toBe(true);
    const urls = Object.fromEntries(readings.map((x) => [x.source, x.news_url]));
    expect(urls).toEqual({ "radar:alpha": "", "radar:bravo": "", "radar:charlie": "", "radar:delta": "https://news.example/zelda?x=1" });

    const trends = raw.prepare("SELECT label, news_title, news_url, why FROM radar_trends").all() as Array<Record<string, string>>;
    expect(trends).toHaveLength(1);
    for (const t of trends) for (const col of ["label", "news_title", "news_url", "why"]) expect(removable(t[col]!), col).toEqual([]);
    expect(trends[0]!.news_title!.length).toBeLessThanOrEqual(CUT);
    expect(trends[0]!.label!.length).toBeLessThanOrEqual(CUT);
    // The radar is not a Source: nothing of it is a Signal.
    expect((raw.prepare("SELECT COUNT(*) AS n FROM signals").get() as { n: number }).n).toBe(0);
    raw.close();
  });
});
