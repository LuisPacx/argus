import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore, type WarRoomStore } from "../datastore.ts";
import { aCandidate, at, T0 } from "../testing/radar.ts";
import { tempDir } from "../testing/temp.ts";
import type { CheckResult } from "./types.ts";

const open = () => {
  const file = path.join(tempDir("radar-store-"), "argus.db");
  return { file, store: Datastore.open(file) };
};
const DAY = 24 * 60;

function trendFor(store: Datastore, term: string, traffic: number, minutes = 0): number {
  const c = aCandidate(term, traffic);
  expect(store.radar.touchSeen(c.key, at(minutes))).toBe(true);
  return store.radar.createTrend({ key: c.key, label: term, firstSeen: at(minutes).toISOString(), score: 20, candidate: c });
}

describe("the seen-set", () => {
  it("a key seen again updates last_seen and makes no second Trend", () => {
    const { store } = open();
    const c = aCandidate("GTA VI", 2_000);
    expect(store.radar.touchSeen(c.key, at(0))).toBe(true);
    store.radar.createTrend({ key: c.key, label: c.term, firstSeen: at(0).toISOString(), score: 20, candidate: c });
    expect(store.radar.touchSeen(c.key, at(15))).toBe(false);
    store.radar.touchTrend(c.key, aCandidate("GTA VI", 6_000, { newsTitle: "Trailer 3" }), 30, at(15));
    expect(store.radar.touchSeen(aCandidate("gta 6", 1).key, at(30))).toBe(false); // the same key under another spelling
    expect(store.radar.view(at(31)).trends).toHaveLength(1);
    expect(store.radar.trendByKey(c.key)).toMatchObject({ firstSeen: at(0).toISOString(), lastSeen: at(15).toISOString(), trafficMin: 6_000, score: 30, newsTitle: "Trailer 3" });
    store.close();
  });

  it("a key not seen for 14 days and seen again is new, with a new Trend; one seen within 14 days is not", () => {
    const { store } = open();
    const id = trendFor(store, "Alpha", 2_000, 0);
    expect(store.radar.touchSeen("alpha", at(13 * DAY))).toBe(false);
    expect(store.radar.touchSeen("alpha", at(27 * DAY))).toBe(false); // 14 days after the last sighting is still inside
    expect(store.radar.touchSeen("alpha", at(27 * DAY + 14 * DAY + 1))).toBe(true);
    expect(store.radar.trendByKey("alpha")).toBeUndefined(); // the old Trend went with the old sighting
    const again = store.radar.createTrend({ key: "alpha", label: "Alpha", firstSeen: at(41 * DAY + 1).toISOString(), score: 20, candidate: aCandidate("Alpha", 3_000) });
    expect(again).not.toBe(id);
    store.close();
  });

  it("prune drops keys and Trends older than 14 days and leaves the readings", () => {
    const { store } = open();
    trendFor(store, "Old one", 2_000, 0);
    store.radar.recordReading(aCandidate("Old one", 2_000), at(0).toISOString());
    trendFor(store, "New one", 2_000, 13 * DAY);
    expect(store.radar.prune(at(15 * DAY))).toBe(1);
    expect(store.radar.trendByKey("oldone")).toBeUndefined();
    expect(store.radar.trendByKey("newone")).toBeDefined();
    expect(store.radar.touchSeen("oldone", at(15 * DAY))).toBe(true);
    store.close();
  });
});

describe("readings are append only", () => {
  it("the database itself refuses to change or remove a reading", () => {
    const { file, store } = open();
    store.radar.recordReading(aCandidate("Alpha", 2_000, { newsTitle: "hello" }), at(0).toISOString());
    store.close();
    const raw = new DatabaseSync(file);
    expect(() => raw.exec("UPDATE radar_readings SET term = 'x'")).toThrow(/append only/);
    expect(() => raw.exec("DELETE FROM radar_readings")).toThrow(/append only/);
    expect(raw.prepare("SELECT term, traffic_min, news_title FROM radar_readings").get()).toEqual({ term: "Alpha", traffic_min: 2_000, news_title: "hello" });
    raw.close();
  });
});

describe("the tables are created on an old database", () => {
  it("a database without them opens and gets them, without touching what was there", () => {
    const { file, store } = open();
    store.close();
    const raw = new DatabaseSync(file);
    for (const t of ["radar_readings", "radar_seen", "radar_trends", "radar_source_state"]) raw.exec(`DROP TABLE ${t}`);
    raw.close();
    const again = Datastore.open(file);
    trendFor(again, "Alpha", 2_000);
    again.radar.recordSource("radar:google:US", "ok", "", at(0));
    again.close();
    const third = Datastore.open(file);
    expect(third.radar.trendByKey("alpha")).toBeDefined(); // a second open adds nothing and loses nothing
    expect(third.radar.sourceStates()).toHaveLength(1);
    third.close();
  });
});

describe("the state of a check", () => {
  const traced = (side: CheckResult["side"], at_: Date): CheckResult => ({ side, trace: { at: at_.toISOString(), phrases: ["alpha"], live: [], lookalikes: [] }, localCreates: 3, localCreators: 2 });

  it("keeps the last good trace and local counts when a check fails, and moves the state's time only when the state changes", () => {
    const { store } = open();
    const id = trendFor(store, "Alpha", 2_000);
    expect(store.radar.trend(id)).toMatchObject({ side: "unchecked", trace: null, lastChecked: null });
    store.radar.recordCheck(id, traced("untokenized", at(1)), at(1));
    store.radar.recordCheck(id, traced("untokenized", at(61)), at(61));
    expect(store.radar.trend(id)).toMatchObject({ side: "untokenized", sideAt: at(1).toISOString(), lastChecked: at(61).toISOString() });
    store.radar.recordCheck(id, { side: "not traced", trace: null, localCreates: null, localCreators: null }, at(121));
    expect(store.radar.trend(id)).toMatchObject({ side: "not traced", sideAt: at(121).toISOString(), lastChecked: at(121).toISOString(), localCreates: 3, localCreators: 2, trace: { at: at(61).toISOString() } });
    store.radar.recordCheck(id, traced("taken", at(181)), at(181));
    expect(store.radar.trend(id)).toMatchObject({ side: "taken", sideAt: at(181).toISOString(), trace: { at: at(181).toISOString() } });
    store.close();
  });

  it("which checks are due: never-checked first, then live ones checked an hour ago, oldest first; a dead one never", () => {
    const { store } = open();
    const a = trendFor(store, "Alpha", 2_000, 0);
    const b = trendFor(store, "Bravo", 2_000, 1);
    const c = trendFor(store, "Charlie", 2_000, 2);
    store.radar.recordCheck(a, traced("untokenized", at(5)), at(5));
    store.radar.recordCheck(b, traced("untokenized", at(3)), at(3));
    expect(store.radar.dueChecks(at(10), 10).map((t) => t.id)).toEqual([c]);
    expect(store.radar.dueChecks(at(64), 10).map((t) => t.id)).toEqual([c, b]);
    expect(store.radar.dueChecks(at(70), 10).map((t) => t.id)).toEqual([c, b, a]);
    expect(store.radar.dueChecks(at(70), 2).map((t) => t.id)).toEqual([c, b]);
    expect(store.radar.dueChecks(at(25 * 60), 10)).toEqual([]); // last seen over 24 hours ago
    store.close();
  });
});

describe("source states", () => {
  it("since moves only when the status goes to or from ok; last_ok moves on a good poll", () => {
    const { store } = open();
    store.radar.recordSource("radar:google:US", "ok", "", at(0));
    store.radar.recordSource("radar:google:US", "ok", "", at(15));
    expect(store.radar.sourceStates()).toEqual([{ source: "radar:google:US", status: "ok", reason: "", lastOk: at(15).toISOString(), since: at(0).toISOString() }]);
    store.radar.recordSource("radar:google:US", "backing off", "HTTP 429", at(30));
    store.radar.recordSource("radar:google:US", "down", "HTTP 503", at(60));
    expect(store.radar.sourceStates()[0]).toEqual({ source: "radar:google:US", status: "down", reason: "HTTP 503", lastOk: at(15).toISOString(), since: at(30).toISOString() });
    store.radar.recordSource("radar:google:US", "ok", "", at(90));
    expect(store.radar.sourceStates()[0]).toMatchObject({ status: "ok", reason: "", lastOk: at(90).toISOString(), since: at(90).toISOString() });
    store.close();
  });
});

describe("the War Room's view of the store (type test)", () => {
  it("can read the radar view and strip, and cannot write a reading, a Trend or a source state", () => {
    const { store } = open();
    const wr: WarRoomStore = store;
    expect(wr.radarView(T0)).toMatchObject({ trends: [], sources: [], alerts: [], lastGoodPollAt: null, counts: { shown: 0, untokenized: 0 } });
    expect(wr.radarStrip(T0)).toEqual({ shown: 0, untokenized: 0, alerts: [] });
    // @ts-expect-error the radar's tables are the worker's: the War Room's store has no `radar`
    expect(wr.radar).toBeDefined();
    store.close();
  });
});
