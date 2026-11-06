import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GoogleTrendsSource } from "./google-trends.ts";

const fixture = readFileSync(join(import.meta.dirname, "../fixtures", "google-trends.rss.xml"), "utf8");
const source = (xml: string, geo?: string) => new GoogleTrendsSource({ fetchText: async () => xml, geo });

describe("GoogleTrendsSource", () => {
  it("has a stable id and a label", () => {
    const s = source("");
    expect([s.id, s.label]).toEqual(["trends:google", "Google Trends"]);
  });

  it("normalizes the recorded trending feed into Signals", async () => {
    const signals = await source(fixture).poll();
    expect(signals.map(({ id: _id, ...rest }) => rest)).toEqual([
      {
        sourceId: "trends:google",
        sourceLabel: "Google Trends",
        title: "moon cat",
        summary: "Trending on Google, about 500,000+ searches. Moon Cat video goes & viral: A cat on a lunar-themed set won hearts.",
        url: "https://news.example.com/moon-cat",
        publishedAt: "2026-11-05T22:00:00.000Z",
      },
      {
        sourceId: "trends:google",
        sourceLabel: "Google Trends",
        title: "Rocket & Robots",
        summary: "Trending on Google, about 20K+ searches.",
        url: "https://trends.google.com/trending/rss?geo=US",
        publishedAt: "2026-11-05T20:30:00.000Z",
      },
      {
        sourceId: "trends:google",
        sourceLabel: "Google Trends",
        title: "unsafe news link",
        summary: "Trending on Google, about 1K+ searches. t",
        url: "",
        publishedAt: "2026-11-05T20:00:00.000Z",
      },
    ]);
  });

  it("gives a term the same id on every poll, so storing it again is a no-op", async () => {
    const a = await source(fixture).poll();
    const b = await source(fixture).poll();
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
    expect(new Set(a.map((s) => s.id)).size).toBe(3);
    expect(a[0]!.id.startsWith("trends:google:")).toBe(true);
  });

  it("returns no Signals for a feed with no items", async () => {
    expect(await source('<rss><channel><title>x</title></channel></rss>').poll()).toEqual([]);
  });

  it("asks Google for the configured country, URL-encoded", async () => {
    const fetchText = vi.fn(async () => "");
    await new GoogleTrendsSource({ fetchText, geo: "G&B" }).poll();
    expect(fetchText).toHaveBeenCalledWith("https://trends.google.com/trending/rss?geo=G%26B");
  });

  it("takes only the first 100 items and truncates a hostile term", async () => {
    const xml = `<rss><channel>${Array.from({ length: 5_000 }, (_, i) => `<item><title>${i === 0 ? "T".repeat(5_000) : `t${i}`}</title></item>`).join("")}</channel></rss>`;
    const signals = await source(xml).poll();
    expect(signals).toHaveLength(100);
    expect(signals[0]!.title).toHaveLength(300);
  });
});
