import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HttpError } from "../../sources/http.ts";
import { RADAR_CONFIG } from "../config.ts";
import { GoogleTrendsReader, parseTraffic } from "./google-trends.ts";

/** A feed recorded from trends.google.com/trending/rss?geo=US on 2026-11-19: 10 items. */
const FEED = readFileSync(new URL("../fixtures/google-trends-us.xml", import.meta.url), "utf8");
const NOW = Date.parse("2026-11-19T20:00:00Z");
const MIN = 60_000;
const serve = (body: string) => new GoogleTrendsReader({ fetchText: async () => body });

describe("the recorded feed", () => {
  it("gives its 10 items with traffic and news links", async () => {
    const r = await serve(FEED).read("US", NOW);
    expect(r).toMatchObject({ sourceId: "radar:google:US", status: "ok", reason: "", fetched: true, waitUntil: null });
    expect(r.candidates).toHaveLength(10);
    const by = Object.fromEntries(r.candidates.map((c) => [c.term, c]));
    expect(by["drew mestemaker"]).toMatchObject({ key: "drewmestemaker", trafficText: "1000+", trafficMin: 1_000, sourceId: "radar:google:US", at: new Date(NOW).toISOString() });
    expect(by["zverev"]!.trafficMin).toBe(10_000);
    expect(by["puka nacua"]!.trafficMin).toBe(50_000);
    expect(by["rams schedule"]).toMatchObject({ trafficMin: 500, newsTitle: "A Rams bye means time for rest and ramping up", newsUrl: "https://www.espn.com/nfl/story/_/id/50512215/rams-bye-rest-ramp-week-11" });
    for (const c of r.candidates) expect(c.newsUrl).toMatch(/^https?:\/\//);
  });

  it("asks for the country it was given, and only an address from its own settings", async () => {
    const asked: string[] = [];
    const reader = new GoogleTrendsReader({ fetchText: async (url) => (asked.push(url), FEED) });
    await reader.read("GB", NOW);
    expect(asked).toEqual(["https://trends.google.com/trending/rss?geo=GB"]);
    const bad = await reader.read("../x", NOW);
    expect(bad.status).toBe("down");
    expect(asked).toHaveLength(1);
  });

  it("a javascript: news link is dropped, and markup in a term or title is removed", async () => {
    const hostile = FEED.replace("https://www.espn.com/nfl/story/_/id/50512215/rams-bye-rest-ramp-week-11", "javascript:alert(1)").replace("<title>sentence</title>", "<title>&lt;img src=x onerror=1&gt;sentence</title>");
    const r = await serve(hostile).read("US", NOW);
    expect(r.candidates.find((c) => c.term === "rams schedule")!.newsUrl).toBe("");
    expect(r.candidates.find((c) => c.key === "sentence")!.term).toBe("sentence");
  });

  it("a term of only punctuation or emoji is dropped; the same key twice keeps the larger traffic", async () => {
    const feed = `<rss xmlns:ht="x"><channel><item><title>🔥🔥</title><ht:approx_traffic>2000+</ht:approx_traffic></item><item><title>GTA VI</title><ht:approx_traffic>1000+</ht:approx_traffic></item><item><title>gta 6</title><ht:approx_traffic>5000+</ht:approx_traffic></item></channel></rss>`;
    const r = await serve(feed).read("US", NOW);
    expect(r.candidates.map((c) => [c.key, c.trafficMin])).toEqual([["gta6", 5_000]]);
  });
});

describe("traffic figures", () => {
  it("reads the number in 2000+, with commas and a K or M suffix; 0 for anything else", () => {
    expect([parseTraffic("1000+"), parseTraffic("2000+"), parseTraffic("1,000+"), parseTraffic("50K+"), parseTraffic("2M+"), parseTraffic("1.5M+")]).toEqual([1_000, 2_000, 1_000, 50_000, 2_000_000, 1_500_000]);
    expect([parseTraffic(""), parseTraffic("lots"), parseTraffic("<b>5</b>")]).toEqual([0, 0, 0]);
  });
});

describe("a feed that is not the feed is never 'no trends'", () => {
  it.each([
    ["an HTML page", "<!doctype html><html><body>Sorry, the page moved</body></html>"],
    ["a feed with zero items from a non-empty body", `<?xml version="1.0"?><rss version="2.0"><channel><title>Daily Search Trends</title></channel></rss>`],
    ["an empty answer", ""],
    ["items with no traffic figure at all", `<rss><channel><item><title>a</title></item><item><title>b</title></item></channel></rss>`],
    ["JSON", `{"default":{"trendingSearchesDays":[]}}`],
  ])("%s is format changed, with no candidates", async (_name, body) => {
    const r = await serve(body).read("US", NOW);
    expect(r).toMatchObject({ status: "format changed", candidates: [], fetched: true, waitUntil: null });
    expect(r.reason).not.toBe("");
  });
});

describe("failures back the source off", () => {
  const failing = (e: unknown) => {
    const calls: number[] = [];
    const reader = new GoogleTrendsReader({ fetchText: async () => (calls.push(1), Promise.reject(e)) });
    return { reader, calls };
  };

  it("a 429 with Retry-After is backing off and honours the wait; the source is not asked again before it", async () => {
    const { reader, calls } = failing(new HttpError("429", 429, 40 * MIN));
    const first = await reader.read("US", NOW);
    expect(first).toMatchObject({ status: "backing off", candidates: [], reason: "HTTP 429", waitUntil: NOW + 40 * MIN });
    const waiting = await reader.read("US", NOW + 39 * MIN);
    expect(waiting).toMatchObject({ status: "backing off", fetched: false, candidates: [], waitUntil: NOW + 40 * MIN });
    expect(calls).toHaveLength(1);
    await reader.read("US", NOW + 41 * MIN);
    expect(calls).toHaveLength(2);
  });

  it("waits double each time without a Retry-After, never above an hour, and is down after three failures in a row", async () => {
    const { reader } = failing(new TypeError("fetch failed"));
    let t = NOW;
    const waits: number[] = [];
    const statuses: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await reader.read("US", t);
      waits.push((r.waitUntil ?? 0) - t);
      statuses.push(r.status);
      t = r.waitUntil ?? t;
    }
    expect(waits).toEqual([15 * MIN, 30 * MIN, 60 * MIN, 60 * MIN, 60 * MIN]);
    expect(statuses).toEqual(["backing off", "backing off", "down", "down", "down"]);
  });

  it("a Retry-After over an hour is not honoured past an hour", async () => {
    const { reader } = failing(new HttpError("503", 503, 10 * 60 * MIN));
    expect((await reader.read("US", NOW)).waitUntil).toBe(NOW + 60 * MIN);
  });

  it("a good answer clears the backoff; one country failing does not hold back another", async () => {
    let fail = true;
    const reader = new GoogleTrendsReader({ fetchText: async (url) => (fail && url.endsWith("GB") ? Promise.reject(new HttpError("500", 500)) : FEED) });
    expect((await reader.read("GB", NOW)).status).toBe("backing off");
    expect((await reader.read("US", NOW)).status).toBe("ok");
    fail = false;
    expect((await reader.read("GB", NOW + 20 * MIN)).status).toBe("ok");
    expect((await reader.read("GB", NOW + 21 * MIN)).waitUntil).toBeNull();
  });

  it("an answer that arrives but is not the feed ends the fetch failures and asks again next tick", async () => {
    let body: string | Error = new HttpError("500", 500);
    const reader = new GoogleTrendsReader({ fetchText: async () => (typeof body === "string" ? body : Promise.reject(body)) });
    expect((await reader.read("US", NOW)).status).toBe("backing off");
    body = "<html></html>";
    expect((await reader.read("US", NOW + 16 * MIN)).status).toBe("format changed");
    expect((await reader.read("US", NOW + 17 * MIN)).fetched).toBe(true);
  });
});

describe("the config", () => {
  it("polls the US only, every 15 minutes (ticket 02 widens it)", () => {
    expect([...RADAR_CONFIG.googleGeos]).toEqual(["US"]);
    expect(RADAR_CONFIG.tickMinutes).toBe(15);
  });
});
