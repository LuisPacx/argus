import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FEED_MAX_ITEMS, RssSource } from "./rss.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "../fixtures", name), "utf8");
const poll = (xml: string) => new RssSource({ id: "rss:verge", label: "The Verge", url: "https://v.example/feed", fetchText: async () => xml }).poll();
const atom = (entries: string) => `<feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;

describe("RssSource on Atom", () => {
  it("normalizes a recorded Verge Atom feed into Signals", async () => {
    const signals = await poll(fixture("verge.atom.xml"));
    expect(signals.map(({ id: _id, ...rest }) => rest)).toEqual([
      {
        sourceId: "rss:verge",
        sourceLabel: "The Verge",
        title: "OpenAI is stepping back from NDAs for data center projects",
        summary: "Following this week's midterms, OpenAI today announced new commitments to communities where it is working on data center projects.",
        url: "https://www.theverge.com/ai-artificial-intelligence/1028454/openai-data-center-nda",
        publishedAt: "2026-11-06T00:37:56.000Z",
      },
      {
        sourceId: "rss:verge",
        sourceLabel: "The Verge",
        title: "Airbnb is working on an AI travel agent",
        summary: 'Airbnb plans to roll out an AI agent in the first half of 2027 that will help users plan and book travel. "But […]',
        url: "https://www.theverge.com/tech/1028412/airbnb-ai-travel-agent-q3-2026-earnings",
        publishedAt: "2026-11-06T00:06:12.000Z",
      },
      {
        sourceId: "rss:verge",
        sourceLabel: "The Verge",
        title: "The New York Times is in talks to buy Letterboxd for around $330 million",
        summary: "The New York Times Company is in talks to acquire Letterboxd, the social network for film lovers, for around $330 million.",
        url: "https://www.theverge.com/news/1028375/the-new-york-times-letterboxd-acquisition-report",
        publishedAt: "2026-11-05T23:45:10.000Z",
      },
    ]);
  });

  it("takes the alternate link, or a link with no rel, never self or enclosure", async () => {
    const [a, b] = await poll(
      atom(
        `<entry><title>A</title><link rel="self" href="https://x.example/self"/><link rel="enclosure" href="https://x.example/mp3"/><link rel="alternate" href="https://x.example/a"/></entry>` +
          `<entry><title>B</title><link href="https://x.example/b"/></entry>`,
      ),
    );
    expect([a?.url, b?.url]).toEqual(["https://x.example/a", "https://x.example/b"]);
  });

  it("drops a non-http link href and decodes entities in a good one", async () => {
    const [bad, good] = await poll(
      atom(
        `<entry><title>Bad</title><link href="javascript:alert(1)"/></entry>` + `<entry><title>Good</title><link href="https://x.example/p?a=1&amp;b=2"/></entry>`,
      ),
    );
    expect([bad?.url, good?.url]).toEqual(["", "https://x.example/p?a=1&b=2"]);
  });

  it("strips tags from an html title, escaped or in CDATA, but keeps a text title literal", async () => {
    const signals = await poll(
      atom(
        `<entry><title type="html">&lt;b&gt;Bold&lt;/b&gt; &amp;amp; more</title><link href="https://x.example/1"/></entry>` +
          `<entry><title type="html"><![CDATA[<i>Italic</i> title]]></title><link href="https://x.example/2"/></entry>` +
          `<entry><title type="text">1 &lt; 2</title><link href="https://x.example/3"/></entry>`,
      ),
    );
    expect(signals.map((s) => s.title)).toEqual(["Bold &amp; more", "Italic title", "1 < 2"]);
  });

  it("falls back to content for the summary and to updated for the date", async () => {
    const [s] = await poll(
      atom(`<entry><title>T</title><link href="https://x.example/1"/><updated>2026-01-02T03:04:05Z</updated><content type="html">&lt;p&gt;Body&lt;/p&gt;</content></entry>`),
    );
    expect([s?.summary, s?.publishedAt]).toEqual(["Body", "2026-01-02T03:04:05.000Z"]);
  });

  it("caps items and truncates fields like RSS", async () => {
    const many = Array.from({ length: FEED_MAX_ITEMS + 20 }, (_, i) => `<entry><title>T${i}</title><link href="https://x.example/${i}"/></entry>`).join("");
    expect(await poll(atom(many))).toHaveLength(FEED_MAX_ITEMS);
    const [long] = await poll(atom(`<entry><title>${"t".repeat(500)}</title><summary>${"s".repeat(2_000)}</summary><link href="https://x.example/1"/></entry>`));
    expect([long?.title.length, long?.summary.length]).toEqual([300, 1_000]);
  });

  it("drops an over-long link href", async () => {
    const [s] = await poll(atom(`<entry><title>T</title><link href="https://x.example/${"a".repeat(2_100)}"/></entry>`));
    expect(s?.url).toBe("");
  });
});
