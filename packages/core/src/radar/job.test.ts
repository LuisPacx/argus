import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import type { DexPair } from "../sources/dexscreener.ts";
import { aCandidate, aPair, anOkRead, at, T0 } from "../testing/radar.ts";
import { tempDir } from "../testing/temp.ts";
import { createRadarJob, type RadarJobDeps } from "./job.ts";
import { GoogleTrendsReader, type ReadResult } from "./readers/google-trends.ts";
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
    ...over,
  });
  return { store, job, searched, setReads: (f: () => ReadResult[]) => (reads = f), goTo: (m: number) => (minutes = m) };
}

describe("a poll", () => {
  it("stores the readings and makes a shown Trend only for a new key above the traffic bar", async () => {
    const store = open();
    const job = createRadarJob({ store, settings: ON, reader: new GoogleTrendsReader({ fetchText: async () => FEED }), dex: { search: async () => [] }, now: () => at(0), sleep: async () => {} });
    const r = await job();
    expect(r).toMatchObject({ status: "ok", readings: 10, newTrends: 5, belowBar: 5, skipped: 0, checked: 5, searches: 5 });
    const view = store.radar.view(at(1));
    expect(view.trends.map((t) => t.term).sort()).toEqual(["alexander zverev", "drew mestemaker", "federal emergency management agency", "puka nacua", "zverev"]);
    expect(view.trends.map((t) => t.term)[0]).toBe("puka nacua"); // 50,000 searches: the highest score first
    expect(view.trends.every((t) => t.side === "untokenized")).toBe(true);
    expect(view.counts).toEqual({ shown: 5, untokenized: 5 });
    expect(store.radar.sourceStates()).toEqual([{ source: "radar:google:US", status: "ok", reason: "", lastOk: at(0).toISOString(), since: at(0).toISOString() }]);
    store.close();
  });

  it("the same feed an hour later adds no Trend and no second row, and updates last_seen", async () => {
    const { store, job, setReads, goTo } = rig({ reads: () => [anOkRead([aCandidate("Zverev", 10_000), aCandidate("Quiet", 200)])] });
    expect(await job()).toMatchObject({ newTrends: 1, belowBar: 1 });
    goTo(15);
    setReads(() => [anOkRead([aCandidate("zverev", 12_000), aCandidate("Quiet", 5_000)])]);
    expect(await job()).toMatchObject({ readings: 2, newTrends: 0, belowBar: 0 });
    expect(store.radar.view(at(16)).trends).toHaveLength(1); // "Quiet" was seen first below the bar and is not new again
    expect(store.radar.trendByKey("zverev")).toMatchObject({ lastSeen: at(15).toISOString(), trafficMin: 12_000 });
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
  const many = (n: number) => anOkRead(Array.from({ length: n }, (_, i) => aCandidate(`Subject Number ${i + 1}`, 2_000 + i)));

  it("never makes more than 30 searches in a tick; the rest wait for the next one, a new Trend before a re-check", async () => {
    const { store, job, searched, setReads, goTo } = rig({ reads: () => [many(45)] });
    const first = await job();
    expect(first).toMatchObject({ newTrends: 45, searches: 30, checked: 30 });
    expect(searched).toHaveLength(30);
    goTo(15);
    setReads(() => [many(45)]);
    const second = await job();
    expect(second).toMatchObject({ newTrends: 0, searches: 15, checked: 15 }); // the 15 never checked, not the 30 checked 15 minutes ago
    expect(searched).toHaveLength(45);
    expect(store.radar.view(at(16)).trends.every((t) => t.side === "untokenized")).toBe(true);
    store.close();
  });

  it("ARGUS_RADAR_SEARCHES_PER_TICK can lower the cap", async () => {
    const { store, job, searched } = rig({ reads: () => [many(20)], settings: radarSettingsFromEnv({ ARGUS_RADAR: "1", ARGUS_RADAR_SEARCHES_PER_TICK: "7" }) });
    expect(await job()).toMatchObject({ searches: 7, checked: 7 });
    expect(searched).toHaveLength(7);
    store.close();
  });

  it("re-checks a live Trend every 60 minutes and never one unseen for 24 hours", async () => {
    const { store, job, searched, setReads, goTo } = rig({ reads: () => [anOkRead([aCandidate("Zverev", 10_000)])] });
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
    const { store, job, setReads, goTo } = rig({ reads: () => [anOkRead([aCandidate("Alpha Bear", 10_000)])], pairs: () => (fail ? new Error("DexScreener 503") : [aPair({ name: "Alpha Bear", marketCapUsd: 8_000, liquidityUsd: 6_000 })]) });
    await job();
    expect(store.radar.trendByKey("alphabear")).toMatchObject({ side: "contested", trace: { at: at(0).toISOString() } });
    fail = true;
    goTo(60);
    setReads(() => [anOkRead([aCandidate("Alpha Bear", 10_000)])]);
    await job();
    const t = store.radar.trendByKey("alphabear")!;
    expect(t).toMatchObject({ side: "not traced", lastChecked: at(60).toISOString() });
    expect(t.trace!.at).toBe(at(0).toISOString());
    expect(t.trace!.live).toHaveLength(1);
    expect(store.radar.counts(at(61))).toEqual({ shown: 1, untokenized: 0 });
    store.close();
  });

  it("reads the local creates from the stored creates of the last 48 hours, once a tick", async () => {
    const { store, job } = rig({ reads: () => [anOkRead([aCandidate("Alpha Bear", 10_000), aCandidate("Gamma Wolf", 10_000)])] });
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
