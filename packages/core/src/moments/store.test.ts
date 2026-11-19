import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore, type WarRoomStore } from "../datastore.ts";
import { tempDir } from "../testing/temp.ts";
import type { PostCounts } from "./counts.ts";
import { storedText, type ScannedPost } from "./store.ts";

const open = () => {
  const file = path.join(tempDir("moments-store-"), "argus.db");
  return { file, store: Datastore.open(file) };
};
const T0 = new Date("2026-11-19T15:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000).toISOString();
/** A status ID whose time is `minutes` after T0 (the ID encodes its own time). */
const idAt = (minutes: number, seq = 1) => ((BigInt(T0.getTime() + minutes * 60_000 - 1_288_834_974_657) << 22n) | BigInt(seq)).toString();
const counts = (views: number | null, likes: number | null = 100): PostCounts => ({ replies: 1, reposts: 2, likes, bookmarks: 3, views });
const post = (statusId: string, over: Partial<ScannedPost> = {}): ScannedPost => ({ statusId, handle: "alice", text: "a clip", hasVideo: true, counts: counts(100_000), ...over });
const scan = (store: Datastore, minutes: number, status: "ok" | "stopped" | "skipped" = "ok", topic = "GTA VI", loads = 2) => store.moments.recordScan({ at: at(minutes), topic, status, loads, signals: [], reason: "" });

describe("readings are append only", () => {
  it("a post is stored once with a reading per scan; a repeated scan id adds nothing", () => {
    const { store } = open();
    const id = idAt(-120);
    const s1 = scan(store, 0);
    expect(store.moments.recordPosts(s1, at(1), [post(id)])).toEqual({ posts: 1, readings: 1, skipped: 0 });
    // the same scan again, with other counts: no new post, no new reading, and the first reading stands
    expect(store.moments.recordPosts(s1, at(2), [post(id, { counts: counts(999_999) })])).toEqual({ posts: 0, readings: 0, skipped: 0 });
    const s2 = scan(store, 30);
    expect(store.moments.recordPosts(s2, at(31), [post(id, { counts: counts(250_000) })])).toEqual({ posts: 0, readings: 1, skipped: 0 });
    const p =store.moments.rising("GTA VI", new Date(at(32)))[0]!;
    expect(p).toMatchObject({ statusId: id, views: 250_000, readings: 2 });
    store.close();
  });

  it("the database itself refuses to change or remove a reading", () => {
    const { file, store } = open();
    const s = scan(store, 0);
    store.moments.recordPosts(s, at(1), [post(idAt(-60))]);
    store.close();
    const raw = new DatabaseSync(file);
    expect(() => raw.exec("UPDATE moment_post_readings SET views = 1")).toThrow(/append only/);
    expect(() => raw.exec("DELETE FROM moment_post_readings")).toThrow(/append only/);
    expect(raw.prepare("SELECT views FROM moment_post_readings").get()).toEqual({ views: 100_000 });
    raw.close();
  });

  it("a figure that was not shown is stored as NULL, never 0", () => {
    const { file, store } = open();
    const s = scan(store, 0);
    store.moments.recordPosts(s, at(1), [post(idAt(-60), { counts: { replies: null, reposts: null, likes: 5, bookmarks: null, views: null } })]);
    store.close();
    const raw = new DatabaseSync(file);
    expect(raw.prepare("SELECT replies, reposts, likes, bookmarks, views FROM moment_post_readings").get()).toEqual({ replies: null, reposts: null, likes: 5, bookmarks: null, views: null });
    raw.close();
  });
});

describe("what is stored of a post", () => {
  it("cuts the text to 600 characters, flattens it to one line and removes < and >", () => {
    expect(storedText("<img src=x onerror=1>\nline two\r\n\tthree")).toBe("img src=x onerror=1 line two three");
    expect(storedText("x".repeat(10_000))).toHaveLength(601); // 600 and the ellipsis
    expect(storedText("a\u0000b‮c d")).toBe("a b c d");
    expect(storedText(undefined)).toBe("");
    const { file, store } = open();
    const s = scan(store, 0);
    store.moments.recordPosts(s, at(1), [post(idAt(-60), { text: `<script>alert(1)</script>\n${"y".repeat(5000)}` })]);
    store.close();
    const raw = new DatabaseSync(file);
    const text = (raw.prepare("SELECT text FROM moment_posts").get() as { text: string }).text;
    expect(text).not.toMatch(/[<>\n]/);
    expect(text.length).toBeLessThanOrEqual(601);
    raw.close();
  });

  it("skips a post whose ID or handle is not well formed, and stores the rest", () => {
    const { store } = open();
    const s = scan(store, 0);
    const r = store.moments.recordPosts(s, at(1), [post("123"), post(idAt(-60), { handle: "bad handle!" }), post(idAt(-60, 2), { handle: "x".repeat(16) }), post(idAt(-60, 3))]);
    expect(r).toEqual({ posts: 1, readings: 1, skipped: 3 });
    store.close();
  });

  it("the time of a post is decoded from its ID, whatever the caller says", () => {
    const { file, store } = open();
    const s = scan(store, 0);
    store.moments.recordPosts(s, at(1), [post(idAt(-90))]);
    store.close();
    const raw = new DatabaseSync(file);
    expect(Math.abs(Date.parse((raw.prepare("SELECT posted_at FROM moment_posts").get() as { posted_at: string }).posted_at) - Date.parse(at(-90)))).toBeLessThan(1);
    raw.close();
  });
});

describe("the tables are created on an old database", () => {
  it("a database without them opens and gets them, without touching what was there", () => {
    const { file, store } = open();
    store.close();
    const raw = new DatabaseSync(file);
    for (const t of ["moment_post_readings", "moment_posts", "moment_scans", "x_session_resume_requests", "x_session_state"]) raw.exec(`DROP TABLE ${t}`);
    raw.close();
    const again = Datastore.open(file);
    const s = scan(again, 0);
    expect(again.moments.recordPosts(s, at(1), [post(idAt(-60))]).readings).toBe(1);
    expect(again.xSession.state(T0).status).toBe("ok");
    again.close();
    const third = Datastore.open(file);
    expect(third.moments.scans()).toHaveLength(1); // a second open adds nothing and loses nothing
    third.close();
  });
});

describe("the list of rising posts", () => {
  it("lists a post at 50,000 views an hour or more, newest reading first, and leaves out the slow, the unrated and the old", () => {
    const { store } = open();
    const fast = idAt(-120, 1); // 120,000 views at 2 h: 60,000 an hour
    const slow = idAt(-120, 2); // 60,000 views at 2 h: 30,000 an hour
    const noViews = idAt(-120, 3);
    const young = idAt(-10, 4); // 10 minutes old: no rate
    const s1 = scan(store, 0);
    store.moments.recordPosts(s1, at(0), [post(fast, { counts: counts(120_000) }), post(slow, { counts: counts(60_000) }), post(noViews, { counts: counts(null, 5_000) }), post(young, { counts: counts(40_000) })]);
    const s2 = scan(store, 30);
    store.moments.recordPosts(s2, at(30), [post(idAt(-60, 5), { counts: counts(120_000), handle: "bob" })]); // 1.5 h old at its reading, 120,000 views: 80,000 an hour, read later
    const rows = store.moments.rising("GTA VI", new Date(at(31)));
    expect(rows.map((r) => r.handle + ":" + Math.round(r.viewsPerHour! / 1000))).toEqual(["bob:80", "alice:60"]);
    expect(rows[0]!.url).toBe(`https://x.com/bob/status/${idAt(-60, 5)}`);
    // 24 hours on, the readings are old: nothing is listed
    expect(store.moments.rising("GTA VI", new Date(at(30 + 25 * 60)))).toEqual([]);
    // another topic sees none of these
    expect(store.moments.rising("Other topic", new Date(at(31)))).toEqual([]);
    store.close();
  });

  it("lists a post that is slow on average but rising by its recent rate (the Area 51 clip)", () => {
    const { store } = open();
    const id = idAt(-5 * 60);
    store.moments.recordPosts(scan(store, 0), at(0), [post(id, { counts: counts(148_000) })]);
    store.moments.recordPosts(scan(store, 75), at(75), [post(id, { counts: counts(638_000) })]);
    const [row] = store.moments.rising("GTA VI", new Date(at(76)));
    expect(Math.round(row!.recentRate! / 10_000) * 10).toBe(390);
    expect(row!.readings).toBe(2);
    // only the first reading: 148,000 at 5 h is 29,600 an hour, not rising
    const lone = open().store;
    lone.moments.recordPosts(scan(lone, 0), at(0), [post(idAt(-5 * 60), { counts: counts(148_000) })]);
    expect(lone.moments.rising("GTA VI", new Date(at(1)))).toEqual([]);
    lone.close();
    store.close();
  });

  it("caps the list at the limit", () => {
    const { store } = open();
    const s = scan(store, 0);
    store.moments.recordPosts(s, at(0), Array.from({ length: 12 }, (_, i) => post(idAt(-120, i + 1), { counts: counts(200_000), handle: `u${i}` })));
    expect(store.moments.rising("GTA VI", new Date(at(1)), 5)).toHaveLength(5);
    store.close();
  });
});

describe("scans and loads", () => {
  it("counts the loads of scans from a time on and finds the last scan and the last good one", () => {
    const { store } = open();
    scan(store, -60, "ok", "GTA VI", 8);
    scan(store, -30, "skipped", "GTA VI", 0);
    scan(store, -10, "stopped", "GTA VI", 1);
    expect(store.moments.loadsSince(at(-61))).toBe(9);
    expect(store.moments.loadsSince(at(-20))).toBe(1);
    expect(store.moments.lastScan()).toMatchObject({ status: "stopped", loads: 1 });
    expect(store.moments.lastGoodScanAt()).toBe(at(-60));
    expect(store.momentsView(T0)).toMatchObject({ topic: "GTA VI", lastGoodScanAt: at(-60), lastScan: { status: "stopped" }, rising: [] });
    expect(store.moments.scans(2).map((s) => s.status)).toEqual(["stopped", "skipped"]);
    store.close();
  });

  it("an empty database has no scan, no good scan and no topic", () => {
    const { store } = open();
    expect(store.momentsView(T0)).toMatchObject({ topic: null, lastScan: null, lastGoodScanAt: null, rising: [], session: { status: "ok" } });
    store.close();
  });
});

describe("the War Room's view of the store (type test)", () => {
  it("can read the moments view and press Resume, and cannot write a scan, a post or the session state", () => {
    const { store } = open();
    const wr: WarRoomStore = store;
    expect(wr.momentsView).toBeDefined();
    expect(wr.requestXSessionResume).toBeDefined();
    // @ts-expect-error the scanner's tables are the worker's: the War Room's store has no `moments`
    expect(wr.moments).toBeDefined();
    // @ts-expect-error nor the X session's state
    expect(wr.xSession).toBeDefined();
    store.close();
  });
});
