import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HttpError, type ConditionalRequest, type ConditionalResponse } from "../../sources/http.ts";
import { aFeed, T0 } from "../../testing/radar.ts";
import { RADAR_CONFIG } from "../config.ts";
import { RssFeedReader } from "./rss.ts";

/** The news feed reader (ticket 02): recorded feeds, a fake fetch, one state per feed. */
const RSS = readFileSync(new URL("../fixtures/feed-rss2.xml", import.meta.url), "utf8");
const ATOM = readFileSync(new URL("../fixtures/feed-atom.xml", import.meta.url), "utf8");
const FEED = aFeed("games");
const NOW = T0.getTime(); // 2026-11-19T12:00:00Z
const MIN = 60_000;
const ok = (body: string, extra: Partial<Extract<ConditionalResponse, { notModified: false }>> = {}): ConditionalResponse => ({ notModified: false, body, ...extra });

/** A fetch that answers from a script and records what it was asked. */
function script(answers: Array<ConditionalResponse | Error>) {
  const asked: Array<{ url: string; cond: ConditionalRequest }> = [];
  let i = 0;
  const fetch = async (url: string, cond: ConditionalRequest): Promise<ConditionalResponse> => {
    asked.push({ url, cond });
    const a = answers[Math.min(i++, answers.length - 1)]!;
    if (a instanceof Error) throw a;
    return a;
  };
  return { fetch, asked };
}

describe("a good poll", () => {
  it("parses the items of an RSS feed: title cleaned, link kept, the item's own date; old and undated items are left out", async () => {
    const { fetch } = script([ok(RSS)]);
    const r = await new RssFeedReader({ fetch }).read(FEED, NOW);
    expect(r).toMatchObject({ sourceId: "radar:games", status: "ok", reason: "", fetched: true, notModified: false, undated: 1 });
    expect(r.items.map((i) => i.title)).toEqual(["Zelda movie trailer drops", "GTA VI & the long wait"]);
    expect(r.items[0]).toMatchObject({ url: "https://games.example/zelda-movie-trailer", at: Date.parse("2026-11-19T11:50:00Z") });
  });

  it("parses an Atom feed, markup in the title removed", async () => {
    const r = await new RssFeedReader({ fetch: script([ok(ATOM)]).fetch }).read(aFeed("sport"), NOW);
    expect(r.status).toBe("ok");
    expect(r.items.map((i) => i.title)).toEqual(["Derby preview: big match tonight"]);
    expect(r.items[0]!.url).toBe("https://sport.example/derby-preview");
  });

  it("an item dated in the future is read as now", async () => {
    const future = RSS.replace("Thu, 19 Nov 2026 11:50:00 +0000", "Thu, 19 Nov 2026 18:00:00 +0000");
    const r = await new RssFeedReader({ fetch: script([ok(future)]).fetch }).read(FEED, NOW);
    expect(r.items[0]!.at).toBe(NOW);
  });
});

describe("the conditional GET", () => {
  it("sends the validators it was given and a 304 is a good poll with no new items", async () => {
    const { fetch, asked } = script([ok(RSS, { etag: '"abc"', lastModified: "Thu, 19 Nov 2026 11:50:00 GMT" }), { notModified: true }]);
    const reader = new RssFeedReader({ fetch });
    await reader.read(FEED, NOW);
    expect(asked[0]!.cond).toEqual({ etag: undefined, lastModified: undefined });
    const r = await reader.read(FEED, NOW + 15 * MIN);
    expect(asked[1]!.cond).toEqual({ etag: '"abc"', lastModified: "Thu, 19 Nov 2026 11:50:00 GMT" });
    expect(r).toMatchObject({ status: "ok", notModified: true, items: [], fetched: true });
  });

  it("a validator that could carry a header break is never sent back", async () => {
    const { fetch, asked } = script([ok(RSS, { etag: '"a"\r\nX-Evil: 1', lastModified: "é".repeat(5) }), { notModified: true }]);
    const reader = new RssFeedReader({ fetch });
    await reader.read(FEED, NOW);
    await reader.read(FEED, NOW + 15 * MIN);
    expect(asked[1]!.cond).toEqual({ etag: undefined, lastModified: undefined });
  });
});

describe("a feed that fails", () => {
  const err = (status: number, retryAfterMs?: number) => new HttpError(`news feed fetch failed: ${status}`, status, retryAfterMs);

  it("a 429 backs off for that feed, honouring Retry-After and never past an hour, and makes no request while it waits", async () => {
    const { fetch, asked } = script([err(429, 40 * MIN)]);
    const reader = new RssFeedReader({ fetch });
    const first = await reader.read(FEED, NOW);
    expect(first).toMatchObject({ status: "backing off", reason: "HTTP 429", fetched: true, waitUntil: NOW + 40 * MIN, items: [] });
    const waiting = await reader.read(FEED, NOW + 15 * MIN);
    expect(waiting).toMatchObject({ status: "backing off", fetched: false, reason: "waiting out the backoff" });
    expect(asked).toHaveLength(1);
    const huge = await new RssFeedReader({ fetch: script([err(429, 10 * 3_600_000)]).fetch }).read(FEED, NOW);
    expect(huge.waitUntil).toBe(NOW + RADAR_CONFIG.backoffMaxMs);
  });

  it("the wait doubles with each failure in a row, from 15 minutes to an hour", async () => {
    const reader = new RssFeedReader({ fetch: script([err(503)]).fetch });
    let now = NOW;
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await reader.read(FEED, now);
      waits.push((r.waitUntil ?? now) - now);
      now = r.waitUntil ?? now;
    }
    expect(waits).toEqual([15 * MIN, 30 * MIN, 60 * MIN, 60 * MIN]);
  });

  it("three failures in a row mark it down, and it is retried hourly; a good answer makes it ok again", async () => {
    const { fetch, asked } = script([err(500), err(500), err(500), ok(RSS)]);
    const reader = new RssFeedReader({ fetch });
    let now = NOW;
    const statuses: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await reader.read(FEED, now);
      statuses.push(r.status);
      now = r.waitUntil!;
    }
    expect(statuses).toEqual(["backing off", "backing off", "down"]);
    const during = await reader.read(FEED, now - 30 * MIN);
    expect(during).toMatchObject({ status: "down", fetched: false });
    expect(now - NOW).toBe((15 + 30 + 60) * MIN);
    const back = await reader.read(FEED, now);
    expect(back).toMatchObject({ status: "ok", fetched: true });
    expect(asked).toHaveLength(4);
    const again = await reader.read(FEED, now + MIN);
    expect(again.status).toBe("ok"); // the failures are forgotten
  });

  it("a network error or a timeout is backing off with its message cleaned", async () => {
    const r = await new RssFeedReader({ fetch: script([new Error("fetch failed\n<script>x</script>")]).fetch }).read(FEED, NOW);
    expect(r.status).toBe("backing off");
    expect(r.reason).not.toMatch(/[<>\n]/);
  });

  it("a body that is not a feed is `format changed`, never 'no news'", async () => {
    for (const body of ["<html><body>moved</body></html>", "", "   \n", "not xml at all", "<rss><channel><title>x</title></channel></rss>"]) {
      const r = await new RssFeedReader({ fetch: script([ok(body)]).fetch }).read(FEED, NOW);
      expect(r, JSON.stringify(body)).toMatchObject({ status: "format changed", items: [] });
    }
  });

  it("a feed whose items carry no readable date is `format changed`", async () => {
    const undated = RSS.replaceAll(/<pubDate>[^<]*<\/pubDate>/g, "");
    const r = await new RssFeedReader({ fetch: script([ok(undated)]).fetch }).read(FEED, NOW);
    expect(r).toMatchObject({ status: "format changed", reason: "no item carries a readable date" });
  });

  it("a feed that answered, even with a changed body, is not a failure and is asked again next tick", async () => {
    const { fetch, asked } = script([ok("<html></html>"), ok(RSS)]);
    const reader = new RssFeedReader({ fetch });
    expect((await reader.read(FEED, NOW)).status).toBe("format changed");
    expect((await reader.read(FEED, NOW + 15 * MIN)).status).toBe("ok");
    expect(asked).toHaveLength(2);
  });

  it("one feed failing leaves the others polled", async () => {
    const other = aFeed("other");
    const fetch = async (url: string): Promise<ConditionalResponse> => {
      if (url.includes("games")) throw err(500);
      return ok(ATOM);
    };
    const reader = new RssFeedReader({ fetch });
    const results = [await reader.read(FEED, NOW), await reader.read(other, NOW)];
    expect(results.map((r) => r.status)).toEqual(["backing off", "ok"]);
    expect(results[1]!.items).toHaveLength(1);
  });
});
