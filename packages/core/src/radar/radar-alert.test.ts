import path from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import { GoogleTrendsReader } from "./readers/google-trends.ts";
import { createRadarJob } from "./job.ts";
import { sourceAlerts } from "./alert.ts";
import { aCandidate, anOkRead, at } from "../testing/radar.ts";
import { tempDir } from "../testing/temp.ts";
import type { SourceState } from "./types.ts";

const open = () => Datastore.open(path.join(tempDir("radar-alert-"), "argus.db"));

describe("the source alert", () => {
  it("a source backing off for 61 minutes shows the banner with its last good poll; at 59 minutes it does not", () => {
    const store = open();
    store.radar.recordSource("radar:google:US", "ok", "", at(0));
    store.radar.recordSource("radar:google:US", "backing off", "HTTP 429", at(10));
    expect(store.radar.view(at(10 + 59)).alerts).toEqual([]);
    expect(store.radar.view(at(10 + 60)).alerts).toEqual([]); // exactly an hour is not "more than"
    expect(store.radar.view(at(10 + 61)).alerts).toEqual([{ source: "radar:google:US", status: "backing off", reason: "HTTP 429", since: at(10).toISOString(), lastOk: at(0).toISOString() }]);
    expect(store.radarStrip(at(10 + 61)).alerts).toHaveLength(1);
    store.close();
  });

  it("a good poll clears it", () => {
    const store = open();
    store.radar.recordSource("radar:google:US", "ok", "", at(0));
    store.radar.recordSource("radar:google:US", "backing off", "HTTP 429", at(10));
    expect(store.radar.view(at(100)).alerts).toHaveLength(1);
    store.radar.recordSource("radar:google:US", "ok", "", at(101));
    expect(store.radar.view(at(102)).alerts).toEqual([]);
    store.close();
  });

  it("a Google feed that returns format changed shows it, from the first bad poll and not from the last", async () => {
    const store = open();
    let minutes = 0;
    const job = createRadarJob({ store, settings: { enabled: true, searchesPerTick: 30 }, reader: new GoogleTrendsReader({ fetchText: async () => "<html>moved</html>", baseUrl: "https://example.invalid/rss" }), dex: { search: async () => [] }, now: () => at(minutes), sleep: async () => {} });
    for (minutes = 0; minutes <= 75; minutes += 15) await job();
    expect(store.radar.sourceStates()[0]).toMatchObject({ status: "format changed", since: at(0).toISOString(), lastOk: null });
    const [alert] = store.radar.view(at(75)).alerts;
    expect(alert).toMatchObject({ source: "radar:google:US", status: "format changed", lastOk: null });
    expect(store.radar.view(at(75)).trends).toEqual([]);
    store.close();
  });

  it("a stretch that moves between not-ok statuses keeps its start, and a source that is ok never alerts", () => {
    const states: SourceState[] = [
      { source: "a", status: "down", reason: "", lastOk: null, since: at(0).toISOString() },
      { source: "b", status: "ok", reason: "", lastOk: at(0).toISOString(), since: at(0).toISOString() },
    ];
    expect(sourceAlerts(states, at(61)).map((a) => a.source)).toEqual(["a"]);
    expect(sourceAlerts(states, at(60))).toEqual([]);
  });

  it("an unreadable since never alerts and never throws", () => {
    expect(sourceAlerts([{ source: "a", status: "down", reason: "", lastOk: null, since: "not a date" }], at(600))).toEqual([]);
  });

  it("the fixture reader and the store agree on a good poll", async () => {
    const store = open();
    const job = createRadarJob({ store, settings: { enabled: true, searchesPerTick: 30 }, reader: { read: async () => anOkRead([aCandidate("Zverev", 10_000)]) }, dex: { search: async () => [] }, now: () => at(0), sleep: async () => {} });
    await job();
    expect(store.radar.view(at(500)).alerts).toEqual([]);
    expect(store.radar.view(at(1)).lastGoodPollAt).toBe(at(0).toISOString());
    store.close();
  });
});
