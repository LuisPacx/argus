import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import type { DexPair } from "../sources/dexscreener.ts";
import { aMeta, saveCurrentRun } from "../testing/meta-current.ts";
import { aCandidate, aFeed, aPair, anItem, anOkFeedRead, anOkRead, at, T0 } from "../testing/radar.ts";
import { tempDir } from "../testing/temp.ts";
import type { RadarFeed } from "./feeds.ts";
import { createRadarJob, type RadarJobDeps } from "./job.ts";
import { GoogleTrendsReader, type ReadResult } from "./readers/google-trends.ts";
import type { FeedItem, FeedReadResult } from "./readers/rss.ts";
import { radarSettingsFromEnv } from "./settings.ts";

const FEED = readFileSync(new URL("./fixtures/google-trends-us.xml", import.meta.url), "utf8");
const ON = { enabled: true, searchesPerTick: 30 };
const open = () => Datastore.open(path.join(tempDir("radar-job-"), "argus.db"));

/** A job over a real store with a fake clock that the test moves, a reader that says what the test says, and a DexScreener that records its searches. */
function rig(over: Partial<RadarJobDeps> & { reads?: () => ReadResult[]; pairs?: (q: string) => DexPair[] | Error } = {}) {
  const store = open();
  let minutes = 0;
  const searched: string[] = [];
  let reads: () => ReadResult[] = over.reads ?? (() => [anOkRead([])]);
  const job = createRadarJob({
    store,
    settings: ON,
    reader: { read: async (geo) => (reads().find((r) => r.sourceId === `radar:google:${geo}`) ?? reads()[0]!) },
    dex: {
      search: async (q) => {
        searched.push(q);
        const r = over.pairs ? over.pairs(q) : [];
        return r instanceof Error ? Promise.reject(r) : r;
      },
    },
    now: () => at(minutes),
    sleep: async () => {},
    geos: ["US"],
    ...over,
  });
  return { store, job, searched, setReads: (f: () => ReadResult[]) => (reads = f), goTo: (m: number) => (minutes = m) };
}

/** `n` shown Trends made directly in the store, 10 an hour is a limit of the job and not of the store. */
function seedTrends(store: Datastore, n: number, minutes = 0): void {
  for (let i = 0; i < n; i++) {
    const c = aCandidate(`Subject Number ${i + 1}`, 25_000);
    store.radar.touchSeen(c.key, at(minutes));
    store.radar.createTrend({ key: c.key, label: c.term, firstSeen: at(minutes).toISOString(), score: 40, candidate: c });
  }
}

describe("a poll", () => {
  it("stores the readings and makes a shown Trend only for a new key that reaches 40 points (Google alone: 20,000 searches)", async () => {
    const store = open();
    const job = createRadarJob({ store, settings: ON, reader: new GoogleTrendsReader({ fetchText: async () => FEED }), geos: ["US"], dex: { search: async () => [] }, now: () => at(0), sleep: async () => {} });
    const r = await job();
    expect(r).toMatchObject({ status: "ok", readings: 10, newTrends: 1, belowBar: 9, skipped: 0, checked: 1, searches: 1 });
    const view = store.radar.view(at(1));
    expect(view.trends.map((t) => t.term)).toEqual(["puka nacua"]); // 50,000 searches: 20 + 20 points; the others are 20 or 30
    expect(view.trends[0]).toMatchObject({ score: 40, side: "untokenized", why: { geos: ["US"], feeds: [], trafficText: "50000+" } });
    expect(view.trends[0]!.why!.parts.map((p) => p.points)).toEqual([20, 20]);
    expect(view.counts).toEqual({ shown: 1, untokenized: 1 });
    expect(store.radar.sourceStates()).toEqual([{ source: "radar:google:US", label: "", status: "ok", reason: "", lastOk: at(0).toISOString(), since: at(0).toISOString() }]);
    store.close();
  });

  it("the same country 3 or more times over: three countries carrying a 10,000 term make 20 + 10 + 10 = 40 and it is shown", async () => {
    const store = open();
    const job = createRadarJob({ store, settings: ON, reader: new GoogleTrendsReader({ fetchText: async () => FEED }), geos: ["US", "GB", "CA"], dex: { search: async () => [] }, now: () => at(0), sleep: async () => {} });
    await job();
    const terms = store.radar.view(at(1)).trends.map((t) => [t.term, t.score]);
    expect(terms).toEqual([["puka nacua", 50], ["zverev", 40]]);
    expect(store.radar.trendByKey("zverev")!.why).toMatchObject({ geos: ["CA", "GB", "US"] });
    store.close();
  });

  it("the same feed a quarter hour later adds no Trend and no second row, and updates last_seen and the traffic", async () => {
    const { store, job, setReads, goTo } = rig({ geos: ["US"], reads: () => [anOkRead([aCandidate("Zverev", 25_000), aCandidate("Quiet", 200)])] });
    expect(await job()).toMatchObject({ newTrends: 1, belowBar: 1 });
    goTo(15);
    setReads(() => [anOkRead([aCandidate("zverev", 30_000), aCandidate("Quiet", 5_000)])]);
    expect(await job()).toMatchObject({ readings: 2, newTrends: 0 });
    expect(store.radar.view(at(16)).trends).toHaveLength(1); // "Quiet" stays at 30 points: not shown
    expect(store.radar.trendByKey("zverev")).toMatchObject({ lastSeen: at(15).toISOString(), trafficMin: 30_000 });
    store.close();
  });

  it("a term first seen more than 3 hours before it reaches 40 points is not new", async () => {
    const { store, job, setReads, goTo } = rig({ geos: ["US"], reads: () => [anOkRead([aCandidate("Quiet", 200)])] });
    await job();
    goTo(3 * 60 + 15);
    setReads(() => [anOkRead([aCandidate("Quiet", 30_000)])]);
    expect(await job()).toMatchObject({ newTrends: 0, notNew: 1 });
    store.close();
  });

  it("each tick leaves a note that the worker ticked, for the page's own idea of 'on'", async () => {
    const { store, job } = rig({ geos: ["US"] });
    store.radar.recordWorker({ enabled: true, dryRun: false, startedAt: at(0).toISOString(), lastTickAt: null, geos: 1, feeds: 0 });
    await job();
    expect(store.radar.workerState()).toMatchObject({ enabled: true, lastTickAt: at(0).toISOString() });
    store.close();
  });
});

describe("a source that does not answer is never 'no trends'", () => {
  it("a failed or changed poll stores nothing and leaves the seen-set alone", async () => {
    const { store, job } = rig({ reads: () => [{ sourceId: "radar:google:US", status: "format changed", reason: "the answer is not the feed or has no items", candidates: [], fetched: true, waitUntil: null }] });
    const r = await job();
    expect(r).toMatchObject({ status: "ok", readings: 0, newTrends: 0, failed: ["radar:google:US"], searches: 0 });
    expect(store.radar.sourceStates()[0]).toMatchObject({ status: "format changed" });
    expect(store.radar.touchSeen("anything", at(0))).toBe(true);
    expect(store.radar.view(at(1)).trends).toEqual([]);
    store.close();
  });

  it("a source still in backing off skips its turn, says so, and keeps the reason it was given", async () => {
    const { store, job, setReads, goTo } = rig({ reads: () => [{ sourceId: "radar:google:US", status: "backing off", reason: "HTTP 429", candidates: [], fetched: true, waitUntil: at(30).getTime() }] });
    await job();
    goTo(15);
    setReads(() => [{ sourceId: "radar:google:US", status: "backing off", reason: "waiting out the backoff", candidates: [], fetched: false, waitUntil: at(30).getTime() }]);
    const r = await job();
    expect(r.waiting).toEqual(["radar:google:US"]);
    expect(r.failed).toEqual([]);
    expect(store.radar.sourceStates()[0]).toMatchObject({ status: "backing off", reason: "HTTP 429", since: at(0).toISOString() });
    store.close();
  });
});

describe("the check", () => {
  it("never makes more than 30 searches in a tick; the rest wait for the next one, a new Trend before a re-check", async () => {
    const { store, job, searched, goTo } = rig();
    seedTrends(store, 45);
    const first = await job();
    expect(first).toMatchObject({ newTrends: 0, searches: 30, checked: 30 });
    expect(searched).toHaveLength(30);
    goTo(15);
    const second = await job();
    expect(second).toMatchObject({ newTrends: 0, searches: 15, checked: 15 }); // the 15 never checked, not the 30 checked 15 minutes ago
    expect(searched).toHaveLength(45);
    expect(store.radar.view(at(16)).trends.every((t) => t.side === "untokenized")).toBe(true);
    store.close();
  });

  it("ARGUS_RADAR_SEARCHES_PER_TICK can lower the cap", async () => {
    const { store, job, searched } = rig({ settings: radarSettingsFromEnv({ ARGUS_RADAR: "1", ARGUS_RADAR_SEARCHES_PER_TICK: "7" }) });
    seedTrends(store, 20);
    expect(await job()).toMatchObject({ searches: 7, checked: 7 });
    expect(searched).toHaveLength(7);
    store.close();
  });

  it("three 'not traced' in a row end the tick's checks (a rate-limit storm); the next tick takes the rest, the unchecked first", async () => {
    let failing = true;
    const { store, job, searched, goTo } = rig({ pairs: () => (failing ? new Error("DexScreener 429") : []) });
    seedTrends(store, 6);
    const first = await job();
    expect(first).toMatchObject({ checked: 3, searches: 3, stoppedEarly: true });
    expect(searched).toHaveLength(3);
    expect(store.radar.view(at(1)).trends.filter((t) => t.side === "not traced")).toHaveLength(3);
    goTo(15);
    failing = false;
    const second = await job();
    expect(second).toMatchObject({ checked: 3, searches: 3, stoppedEarly: false }); // the 3 the storm cut off; the 3 not traced wait for their hour
    expect(searched).toHaveLength(6);
    expect(new Set(searched).size).toBe(6);
    store.close();
  });

  it("a good check between two bad ones resets the streak", async () => {
    let n = 0;
    const { store, job } = rig({ pairs: () => (++n % 3 === 0 ? [] : new Error("DexScreener 503")) });
    seedTrends(store, 6);
    expect(await job()).toMatchObject({ checked: 6, stoppedEarly: false });
    store.close();
  });

  it("re-checks a live Trend every 60 minutes and never one unseen for 24 hours", async () => {
    const { store, job, searched, setReads, goTo } = rig({ reads: () => [anOkRead([aCandidate("Zverev", 25_000)])] });
    await job();
    expect(searched).toHaveLength(1);
    for (const m of [15, 30, 45]) {
      goTo(m);
      await job();
    }
    expect(searched).toHaveLength(1);
    goTo(60);
    await job();
    expect(searched).toHaveLength(2);
    // the term leaves Google's list; 25 hours after it was last seen it is dead and is not checked again
    setReads(() => [anOkRead([aCandidate("Other thing", 500)])]);
    goTo(60 + 25 * 60);
    expect(await job()).toMatchObject({ searches: 0, checked: 0 });
    expect(searched).toHaveLength(2);
    store.close();
  });

  it("a search that throws is not traced, keeps the last good trace and is never untokenized", async () => {
    let fail = false;
    const { store, job, setReads, goTo } = rig({ reads: () => [anOkRead([aCandidate("Alpha Bear", 25_000)])], pairs: () => (fail ? new Error("DexScreener 503") : [aPair({ name: "Alpha Bear", marketCapUsd: 8_000, liquidityUsd: 6_000 })]) });
    await job();
    expect(store.radar.trendByKey("alphabear")).toMatchObject({ side: "contested", trace: { at: at(0).toISOString() } });
    fail = true;
    goTo(60);
    setReads(() => [anOkRead([aCandidate("Alpha Bear", 25_000)])]);
    await job();
    const t = store.radar.trendByKey("alphabear")!;
    expect(t).toMatchObject({ side: "not traced", lastChecked: at(60).toISOString() });
    expect(t.trace!.at).toBe(at(0).toISOString());
    expect(t.trace!.live).toHaveLength(1);
    expect(store.radar.counts(at(61))).toEqual({ shown: 1, untokenized: 0 });
    store.close();
  });

  it("reads the local creates from the stored creates of the last 48 hours, once a tick", async () => {
    const { store, job } = rig({ reads: () => [anOkRead([aCandidate("Alpha Bear", 25_000), aCandidate("Gamma Wolf", 25_000)])] });
    const study = store.study as unknown as { createsSince: (since: string, limit: number) => unknown[] };
    let reads = 0;
    const real = study.createsSince.bind(store.study);
    study.createsSince = (since, limit) => (reads++, real(since, limit));
    await job();
    expect(reads).toBe(1);
    store.close();
  });
});

describe("the switch", () => {
  it("unset, empty or 0 does nothing; 1 turns it on; junk is an error", async () => {
    for (const v of [undefined, "", "0"]) expect(radarSettingsFromEnv({ ARGUS_RADAR: v })).toEqual({ enabled: false, searchesPerTick: 30 });
    expect(radarSettingsFromEnv({ ARGUS_RADAR: "1" }).enabled).toBe(true);
    for (const v of ["true", "yes", "2", "on", " no "]) expect(() => radarSettingsFromEnv({ ARGUS_RADAR: v }), v).toThrow(/ARGUS_RADAR must be/);
    for (const v of ["0", "31", "-1", "abc", "5.5"]) expect(() => radarSettingsFromEnv({ ARGUS_RADAR: "1", ARGUS_RADAR_SEARCHES_PER_TICK: v }), v).toThrow(/at most|from 1 to 30/);
  });

  it("with the switch off the job reads nothing, searches nothing and writes nothing", async () => {
    let called = 0;
    const store = open();
    const job = createRadarJob({ store, settings: { enabled: false, searchesPerTick: 30 }, reader: { read: async () => (called++, anOkRead([aCandidate("Zverev", 10_000)])) }, dex: { search: async () => (called++, []) } });
    expect(await job()).toMatchObject({ status: "off", readings: 0, searches: 0 });
    expect(called).toBe(0);
    expect(store.radar.sourceStates()).toEqual([]);
    store.close();
  });

  it("a dry run polls nothing and searches nothing", async () => {
    let called = 0;
    const store = open();
    const lines: string[] = [];
    const job = createRadarJob({ store, settings: ON, dryRun: true, log: (l) => lines.push(l), reader: { read: async () => (called++, anOkRead([aCandidate("Zverev", 10_000)])) }, dex: { search: async () => (called++, []) } });
    expect(await job()).toMatchObject({ status: "dry-run" });
    expect(called).toBe(0);
    expect(store.radar.view(T0).trends).toEqual([]);
    expect(lines.join("\n")).toContain("dry-run");
    store.close();
  });

  it("two ticks never overlap", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const store = open();
    const job = createRadarJob({ store, settings: ON, reader: { read: async () => (await gate, anOkRead([])) }, dex: { search: async () => [] }, now: () => at(0), sleep: async () => {} });
    const first = job();
    expect((await job()).status).toBe("overlap");
    release();
    expect((await first).status).toBe("ok");
    store.close();
  });
});

describe("the agreement of feeds and countries", () => {
  const [A, B, C, D, E] = ["alpha", "bravo", "charlie", "delta", "echo"].map((s) => aFeed(s)) as [RadarFeed, RadarFeed, RadarFeed, RadarFeed, RadarFeed];
  type Items = (feed: RadarFeed, minutes: number) => FeedItem[] | "fail";

  function feedRig(items: Items, over: Partial<RadarJobDeps> & { google?: (minutes: number) => ReadResult[] } = {}) {
    const file = path.join(tempDir("radar-feeds-"), "argus.db");
    const store = Datastore.open(file);
    let minutes = 0;
    const { google, ...deps } = over;
    const job = createRadarJob({
      store,
      settings: ON,
      geos: ["US"],
      reader: { read: async (geo) => google?.(minutes).find((r) => r.sourceId === `radar:google:${geo}`) ?? anOkRead([], `radar:google:${geo}`) },
      feedReader: {
        read: async (f): Promise<FeedReadResult> => {
          const got = items(f, minutes);
          return got === "fail" ? { ...anOkFeedRead(f, []), status: "backing off", reason: "HTTP 429" } : anOkFeedRead(f, got);
        },
      },
      feeds: [A, B, C, D, E],
      dex: { search: async () => [] },
      now: () => at(minutes),
      sleep: async () => {},
      ...deps,
    });
    return { store, file, job, goTo: (m: number) => (minutes = m) };
  }
  /** The feeds serve `title` from `from` on, published at `from`; every feed also serves the same dull headline all day. */
  const story = (carriers: RadarFeed[], title: string, from: number): Items => (f, m) => [
    anItem("Weather today sunny", 5, at(m)),
    ...(carriers.includes(f) && m >= from ? [{ ...anItem(title, 0, at(from)) }] : []),
  ];

  it("a new phrase in 3 distinct feeds inside 3 hours is a shown Trend with 60 points and its feeds; nothing is stored in signals", async () => {
    const { store, file, job, goTo } = feedRig(story([A, B, C], "Zelda movie trailer drops", 200));
    expect(await job()).toMatchObject({ newTrends: 0, feedItems: 5 }); // the first poll: its backlog is background, not news
    goTo(200);
    const r = await job();
    expect(r).toMatchObject({ newTrends: 1 });
    const [t] = store.radar.view(at(201)).trends;
    expect(t).toMatchObject({ term: "zelda movie trailer drops", score: 60, why: { geos: [], trafficText: "" } });
    expect(t!.why!.feeds.map((f) => f.label)).toEqual(["ALPHA", "BRAVO", "CHARLIE"]);
    expect(t!.why!.parts).toEqual([{ label: "3 independent sources within 3 hours", points: 60 }]);
    expect(t!.newsTitle).toBe("Zelda movie trailer drops");
    expect(store.radar.view(at(201)).trends).toHaveLength(1); // the shorter cuts of the same headline are the same story
    const raw = new DatabaseSync(file);
    expect(raw.prepare("SELECT source FROM radar_readings WHERE key = 'zeldamovietrailerdrops' ORDER BY source").all()).toEqual([{ source: "radar:alpha" }, { source: "radar:bravo" }, { source: "radar:charlie" }]);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM signals").get() as { n: number }).n).toBe(0);
    raw.close();
    store.close();
  });

  it("two feeds are not enough, and the same phrase many times in one feed counts once", async () => {
    const two = feedRig(story([A, B], "Zelda movie trailer drops", 200));
    await two.job();
    two.goTo(200);
    expect(await two.job()).toMatchObject({ newTrends: 0 });
    two.store.close();
    const many = feedRig((f, m) => (f === A && m >= 200 ? Array.from({ length: 5 }, (_, i) => anItem("Zelda movie trailer drops", i, at(m))) : [anItem("Weather today sunny", 5, at(m))]));
    await many.job();
    many.goTo(200);
    expect(await many.job()).toMatchObject({ newTrends: 0 });
    many.store.close();
  });

  it("3 feeds spread over 5 hours are not an agreement", async () => {
    const items: Items = (f, m) => {
      const pub = f === A ? 200 : f === B ? 320 : f === C ? 440 : 99_999;
      return [anItem("Weather today sunny", 5, at(m)), ...(m >= pub ? [anItem("Zelda movie trailer drops", 0, at(pub))] : [])];
    };
    const { store, job, goTo } = feedRig(items);
    for (let m = 0; m <= 500; m += 20) {
      goTo(m);
      expect(await job(), `at ${m}`).toMatchObject({ newTrends: 0 });
    }
    expect(store.radar.view(at(501)).trends).toEqual([]);
    store.close();
  });

  it("what the feeds carried at the first poll is background, and no phrase is a Trend by the feeds' word alone in the first 3 hours", async () => {
    const first = feedRig(story([A, B, C], "Zelda movie trailer drops", 0));
    const r = await first.job();
    expect(r).toMatchObject({ newTrends: 0 });
    expect(r.warming).toBeGreaterThan(0);
    first.store.close();
    const early = feedRig(story([A, B, C], "Mario film teaser lands", 100)); // a new headline, but only 100 minutes after the first poll
    await early.job();
    early.goTo(100);
    const second = await early.job();
    expect(second).toMatchObject({ newTrends: 0 });
    expect(second.warming).toBeGreaterThan(0);
    early.store.close();
  });

  it("a Meta's label from a fixture is skipped, and so are the other cuts of its headline", async () => {
    const store = open();
    saveCurrentRun(store, T0, { metas: [aMeta("gta", { label: "GTA 6" })], watching: [] });
    let minutes = 0;
    const items = story([A, B, C], "GTA VI trailer", 200);
    const job = createRadarJob({
      store,
      settings: ON,
      geos: ["US"],
      reader: { read: async (geo) => anOkRead([], `radar:google:${geo}`) },
      feedReader: { read: async (f) => anOkFeedRead(f, items(f, minutes) as FeedItem[]) },
      feeds: [A, B, C, D, E],
      dex: { search: async () => [] },
      now: () => at(minutes),
      sleep: async () => {},
    });
    await job();
    minutes = 200;
    const r = await job();
    expect(store.radar.view(at(201)).trends.map((t) => t.term)).toEqual([]);
    expect(r).toMatchObject({ newTrends: 0 });
    expect(r.skipped).toBeGreaterThan(0);
    store.close();
  });

  it("Google in 3 countries at 25,000 plus one feed is 20 + 20 + 20 + 10 = 70", async () => {
    const countries = ["US", "GB", "CA"];
    const google = () => countries.map((g) => anOkRead([aCandidate("Zelda movie", 25_000, { sourceId: `radar:google:${g}` })], `radar:google:${g}`));
    const items: Items = (f, m) => [anItem("Weather today sunny", 5, at(m)), ...(f === A ? [anItem("Zelda movie trailer", 5, at(m))] : [])];
    const { store, job } = feedRig(items, { google, geos: countries });
    expect(await job()).toMatchObject({ newTrends: 1 });
    const t = store.radar.trendByKey("zeldamovie")!;
    expect(t).toMatchObject({ score: 70, label: "Zelda movie" });
    expect(t.why!.parts).toEqual([
      { label: "2 independent sources within 3 hours", points: 40 },
      { label: "Google traffic of 20,000 or more", points: 20 },
      { label: "3 Google countries", points: 10 },
    ]);
    expect(t.why).toMatchObject({ geos: ["CA", "GB", "US"], trafficText: "25000+" });
    store.close();
  });

  it("a Trend crossing 70 is 'changed' once, at the crossing, not on every tick after it", async () => {
    const google = () => [anOkRead([aCandidate("Zelda movie", 25_000)])];
    const items: Items = (f, m) => [anItem("Weather today sunny", 5, at(m)), ...((f === A && m >= 15) || (f === B && m >= 30) ? [anItem("Zelda movie news", 2, at(m))] : [])];
    const { store, job, goTo } = feedRig(items, { google });
    const scoreAt = async (m: number) => (goTo(m), await job(), store.radar.trendByKey("zeldamovie")!);
    expect(await scoreAt(0)).toMatchObject({ score: 40, changedAt: null });
    expect(await scoreAt(15)).toMatchObject({ score: 60, changedAt: null });
    expect(await scoreAt(30)).toMatchObject({ score: 80, changedAt: at(30).toISOString(), changedWhy: "score rose to 80" });
    expect(await scoreAt(45)).toMatchObject({ score: 80, changedAt: at(30).toISOString() });
    store.close();
  });

  it("no more than 10 new Trends an hour: the rest are held and made when the hour has passed", async () => {
    const reads = anOkRead(Array.from({ length: 14 }, (_, i) => aCandidate(`Subject Number ${i + 1}`, 25_000 + i)));
    const { store, job, goTo } = rig({ reads: () => [reads] });
    expect(await job()).toMatchObject({ newTrends: 10, held: 4 });
    for (const m of [15, 30, 45, 60]) {
      goTo(m);
      expect(await job(), `at ${m}`).toMatchObject({ newTrends: 0, held: 4 });
    }
    goTo(75);
    expect(await job()).toMatchObject({ newTrends: 4, held: 0 });
    expect(store.radar.counts(at(76))).toMatchObject({ shown: 14 });
    store.close();
  });

  it("the page lists at most 30 rows however many Trends there are", async () => {
    const { store } = rig();
    seedTrends(store, 45);
    expect(store.radar.view(at(1)).trends).toHaveLength(30);
    expect(store.radar.view(at(1)).counts.shown).toBe(45);
    store.close();
  });

  it("a country that is backing off does not stop the others and is not a quiet hour", async () => {
    const { store, job } = rig({
      geos: ["US", "GB", "CA"],
      reads: () => [
        anOkRead([aCandidate("Zelda movie", 25_000)]),
        { sourceId: "radar:google:GB", status: "backing off", reason: "HTTP 429", candidates: [], fetched: true, waitUntil: at(30).getTime() },
        { sourceId: "radar:google:CA", status: "backing off", reason: "waiting out the backoff", candidates: [], fetched: false, waitUntil: at(30).getTime() },
      ],
    });
    const r = await job();
    expect(r).toMatchObject({ newTrends: 1, failed: ["radar:google:GB"], waiting: ["radar:google:CA"], readings: 1 });
    expect(store.radar.sourceStates().map((s) => [s.source, s.status])).toEqual([["radar:google:GB", "backing off"], ["radar:google:US", "ok"]]);
    expect(store.radar.trendByKey("zeldamovie")).toMatchObject({ score: 40 }); // the failed countries added nothing and took nothing away
    store.close();
  });

  it("one feed failing leaves the others polled, with its state and label on the page", async () => {
    const { store, job } = feedRig((f, m) => (f === A ? "fail" : [anItem(`Headline of ${f.id}`, 5, at(m))]));
    const r = await job();
    expect(r).toMatchObject({ failed: ["radar:alpha"], feedItems: 4 });
    const states = store.radar.sourceStates();
    expect(states.find((s) => s.source === "radar:alpha")).toMatchObject({ status: "backing off", reason: "HTTP 429", label: "ALPHA" });
    expect(states.filter((s) => s.status === "ok").map((s) => s.source)).toEqual(["radar:bravo", "radar:charlie", "radar:delta", "radar:echo", "radar:google:US"]);
    store.close();
  });
});
