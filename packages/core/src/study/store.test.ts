import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import type { PumpConnectionEvent, PumpTokenEvent } from "../sources/pumpportal.ts";
import { tempDir } from "../testing/temp.ts";
import { join } from "node:path";
import { MAX_CAPTURE_RUNS_PER_DAY, STUDY_CAPTURE_RULE } from "./config.ts";
import { SnapshotNotAllowedError, snapshotHash, type NewSnapshot } from "./store.ts";

const T0 = Date.parse("2026-11-08T10:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000);
const iso = (sec: number) => at(sec).toISOString();
const mintOf = (n: number) => `Mint${n}`.padEnd(40, "x") + "pump";

const create = (n: number, sec = 0, extra: Partial<PumpTokenEvent> = {}): PumpTokenEvent => ({
  kind: "create",
  mint: mintOf(n),
  receivedAt: iso(sec),
  signature: "",
  name: `Token ${n}`,
  symbol: `T${n}`,
  creator: "Creator".padEnd(44, "1"),
  uri: `https://ipfs.io/ipfs/meta${n}`,
  pool: "pump",
  ...extra,
});
const migrate = (n: number, sec: number, extra: Partial<PumpTokenEvent> = {}): PumpTokenEvent => ({ kind: "migrate", mint: mintOf(n), receivedAt: iso(sec), signature: "", name: "", symbol: "", creator: "", uri: "", pool: "pump-amm", ...extra });

const snap = (n: number, extra: Partial<NewSnapshot> = {}): NewSnapshot => ({
  mint: mintOf(n),
  description: "A cat",
  imageUrl: "https://ipfs.io/ipfs/img",
  websiteUrl: "https://cat.example/",
  xUrl: "https://x.com/cat",
  telegramUrl: null,
  selectionReason: "population: website and X links",
  website: { status: "ok", detail: "", httpStatus: 200, finalUrl: "https://cat.example/", contentType: "text/html", title: "Cat", text: "Cats on the moon", truncated: false, responseMs: 120, emptyShell: false },
  ...extra,
});

function open() {
  return Datastore.open(":memory:");
}

describe("recording token events", () => {
  it("records a pump create as pending, with the uri, creator, pool and the receipt time as the create event time", () => {
    const store = open();
    store.study.recordTokenEvent(create(1, 5));
    expect(store.study.getToken(mintOf(1))).toMatchObject({ status: "pending", createdAt: iso(5), uri: "https://ipfs.io/ipfs/meta1", creator: "Creator".padEnd(44, "1"), pool: "pump", name: "Token 1", symbol: "T1", migratedAt: null });
  });

  it("keeps the first create and ignores a repeat", () => {
    const store = open();
    store.study.recordTokenEvent(create(1, 5));
    store.study.recordTokenEvent(create(1, 99, { name: "Other" }));
    expect(store.study.getToken(mintOf(1))).toMatchObject({ createdAt: iso(5), name: "Token 1" });
  });

  it("a create on another launchpad, or without a uri, is out of scope and never captured", () => {
    const store = open();
    store.study.recordTokenEvent(create(1, 0, { pool: "bonk", uri: "" }));
    store.study.recordTokenEvent(create(2, 0, { uri: "" }));
    expect(store.study.getToken(mintOf(1))).toMatchObject({ status: "out-of-scope", statusReason: "not a pump.fun launch (pool bonk)" });
    expect(store.study.getToken(mintOf(2))).toMatchObject({ status: "out-of-scope", statusReason: "create carried no metadata uri" });
    expect(store.study.dueTokens(at(3600), 10)).toEqual([]);
  });

  it("a migrate for a token whose create was seen records the migration time and changes nothing else", () => {
    const store = open();
    store.study.recordTokenEvent(create(1, 0));
    store.study.recordTokenEvent(migrate(1, 40));
    store.study.recordTokenEvent(migrate(1, 90)); // a repeat keeps the first
    expect(store.study.getToken(mintOf(1))).toMatchObject({ status: "pending", migratedAt: iso(40) });
  });

  it("a migrate for a pump token whose create was never seen is recorded as missed", () => {
    const store = open();
    store.study.recordTokenEvent(migrate(7, 100));
    expect(store.study.getToken(mintOf(7))).toMatchObject({ status: "missed", createdAt: null, migratedAt: iso(100), statusReason: "migrate seen, create never seen" });
  });

  it("a migrate for a mint that is not a pump mint is not part of the Study at all", () => {
    const store = open();
    store.study.recordTokenEvent({ ...migrate(8, 100), mint: "Other".padEnd(40, "z") + "Loat" });
    expect(store.study.stats(at(200)).missed).toBe(0);
  });

  it("a create arriving after its migrate does not rescue a missed token", () => {
    const store = open();
    store.study.recordTokenEvent(migrate(9, 10));
    store.study.recordTokenEvent(create(9, 12));
    expect(store.study.getToken(mintOf(9))).toMatchObject({ status: "missed", createdAt: null });
  });
});

describe("a missed create is never given a Snapshot at a later age", () => {
  it("the store refuses a Snapshot for a missed token at any age", () => {
    const store = open();
    store.study.recordTokenEvent(migrate(1, 100));
    for (const sec of [60, 100, 160, 3600, 86_400]) expect(() => store.study.recordSnapshot(snap(1), at(sec)), `age ${sec}`).toThrow(SnapshotNotAllowedError);
    expect(store.study.getSnapshot(mintOf(1))).toBeUndefined();
  });

  it("a missed token is never due", () => {
    const store = open();
    store.study.recordTokenEvent(migrate(1, 100));
    expect(store.study.dueTokens(at(10_000), 10)).toEqual([]);
  });
});

describe("Snapshots", () => {
  it("are written once with hash, capture time, age at capture, rule version and selection reason", () => {
    const store = open();
    store.study.recordTokenEvent(create(1, 0, { name: "Moon Cat", symbol: "MCAT" }));
    const s = store.study.recordSnapshot(snap(1), at(62.5));
    expect(s).toMatchObject({
      mint: mintOf(1),
      captureRuleVersion: STUDY_CAPTURE_RULE.version,
      capturedAt: iso(62.5),
      ageSec: 62.5,
      selectionReason: "population: website and X links",
      name: "Moon Cat",
      symbol: "MCAT",
      createEventAt: iso(0),
      creator: "Creator".padEnd(44, "1"),
      uri: "https://ipfs.io/ipfs/meta1",
      description: "A cat",
      websiteUrl: "https://cat.example/",
      xUrl: "https://x.com/cat",
      siteStatus: "ok",
      siteTitle: "Cat",
      siteText: "Cats on the moon",
      siteEmptyShell: false,
    });
    expect(s.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.contentHash).toBe(snapshotHash(s));
    expect(store.study.getSnapshot(mintOf(1))).toEqual(s);
    expect(store.study.getToken(mintOf(1))?.status).toBe("captured");
  });

  it("the hash covers the content: any changed field gives another hash", () => {
    const store = open();
    store.study.recordTokenEvent(create(1, 0));
    const s = store.study.recordSnapshot(snap(1), at(60));
    for (const change of [{ siteText: "edited" }, { description: "x" }, { capturedAt: iso(61) }, { websiteUrl: "https://evil.example/" }, { siteEmptyShell: true }]) {
      expect(snapshotHash({ ...s, ...change }), JSON.stringify(change)).not.toBe(s.contentHash);
    }
  });

  it("cannot be written twice", () => {
    const store = open();
    store.study.recordTokenEvent(create(1, 0));
    store.study.recordSnapshot(snap(1), at(60));
    expect(() => store.study.recordSnapshot(snap(1, { description: "second" }), at(61))).toThrow(SnapshotNotAllowedError);
    expect(store.study.getSnapshot(mintOf(1))?.description).toBe("A cat");
  });

  it("cannot be written before or after the fixed age (60 s, with the grace window)", () => {
    const store = open();
    for (const n of [1, 2, 3]) store.study.recordTokenEvent(create(n, 0));
    expect(() => store.study.recordSnapshot(snap(1), at(59))).toThrow(/age/);
    expect(() => store.study.recordSnapshot(snap(2), at(STUDY_CAPTURE_RULE.snapshotAgeSec + STUDY_CAPTURE_RULE.captureGraceSec + 1))).toThrow(/age/);
    expect(() => store.study.recordSnapshot(snap(3), at(STUDY_CAPTURE_RULE.snapshotAgeSec + STUDY_CAPTURE_RULE.captureGraceSec))).not.toThrow();
  });

  it("cannot be written for an unknown token", () => {
    expect(() => open().study.recordSnapshot(snap(1), at(60))).toThrow(SnapshotNotAllowedError);
  });

  it("are immutable in the database itself: UPDATE and DELETE are refused", () => {
    const path = join(tempDir("study-immutable-"), "argus.db");
    const store = Datastore.open(path);
    store.study.recordTokenEvent(create(1, 0));
    store.study.recordSnapshot(snap(1), at(60));
    const raw = new DatabaseSync(path);
    expect(() => raw.exec("UPDATE study_snapshots SET site_text = 'tampered'")).toThrow(/immutable/);
    expect(() => raw.exec("DELETE FROM study_snapshots")).toThrow(/immutable/);
    raw.close();
    store.close();
  });

  it("a Snapshot with no website URL records a site status of none", () => {
    const store = open();
    store.study.recordTokenEvent(create(1, 0));
    const s = store.study.recordSnapshot(snap(1, { websiteUrl: null, website: null, selectionReason: "population: X link" }), at(60));
    expect(s).toMatchObject({ siteStatus: "none", siteText: "", siteEmptyShell: null });
  });
});

describe("due tokens", () => {
  it("are pending tokens whose age has reached the Snapshot age, oldest first", () => {
    const store = open();
    store.study.recordTokenEvent(create(1, 0));
    store.study.recordTokenEvent(create(2, 30));
    store.study.recordTokenEvent(create(3, 1));
    expect(store.study.dueTokens(at(59), 10)).toEqual([]);
    expect(store.study.dueTokens(at(61), 10).map((t) => t.mint)).toEqual([mintOf(1), mintOf(3)]);
    expect(store.study.dueTokens(at(200), 2).map((t) => t.mint)).toEqual([mintOf(1), mintOf(3)]);
  });
  it("leave once captured or marked", () => {
    const store = open();
    store.study.recordTokenEvent(create(1, 0));
    store.study.recordTokenEvent(create(2, 0));
    store.study.recordSnapshot(snap(1), at(60));
    store.study.markToken(mintOf(2), "late", "too late");
    expect(store.study.dueTokens(at(200), 10)).toEqual([]);
  });
  it("markToken only moves a pending token", () => {
    const store = open();
    store.study.recordTokenEvent(create(1, 0));
    store.study.recordSnapshot(snap(1), at(60));
    expect(() => store.study.markToken(mintOf(1), "late", "x")).toThrow(SnapshotNotAllowedError);
  });
});

describe("the capture run cap", () => {
  it("is counted in the store: no more runs than the cap in any rolling 24 hours", () => {
    const store = open();
    for (const n of [1, 2, 3, 4]) store.study.recordTokenEvent(create(n, 0));
    expect([1, 2, 3].map((n) => store.study.beginCaptureRun(mintOf(n), at(60), 3))).toEqual([true, true, true]);
    expect(store.study.beginCaptureRun(mintOf(4), at(60), 3)).toBe(false);
    expect(store.study.captureRunsSince(at(60 - 86_400 + 1))).toBe(3);
    // a day later the earlier runs have rolled out of the window
    expect(store.study.beginCaptureRun(mintOf(4), at(60 + 86_401), 3)).toBe(true);
  });
  it("cannot be raised by the caller past the code cap", () => {
    const path = join(tempDir("study-cap-"), "argus.db");
    const store = Datastore.open(path);
    const raw = new DatabaseSync(path);
    raw.exec("BEGIN");
    const ins = raw.prepare("INSERT INTO study_capture_runs (mint, at) VALUES ('m', ?)");
    for (let i = 0; i < MAX_CAPTURE_RUNS_PER_DAY - 1; i++) ins.run(iso(60));
    raw.exec("COMMIT");
    raw.close();
    // asking for a cap of a billion still runs into MAX_CAPTURE_RUNS_PER_DAY
    expect(store.study.beginCaptureRun(mintOf(1), at(60), 1_000_000_000)).toBe(true);
    expect(store.study.beginCaptureRun(mintOf(1), at(60), 1_000_000_000)).toBe(false);
    store.close();
  });
});

describe("gap markers", () => {
  const up = (sec: number): PumpConnectionEvent => ({ state: "up", at: iso(sec) });
  const down = (sec: number): PumpConnectionEvent => ({ state: "down", at: iso(sec) });

  it("a drop opens a gap and the next up closes it", () => {
    const store = open();
    store.study.recordConnection(up(0));
    store.study.recordConnection(down(100));
    expect(store.study.gaps()).toEqual([{ startedAt: iso(100), endedAt: null, reason: "disconnect" }]);
    store.study.recordConnection(up(160));
    expect(store.study.gaps()).toEqual([{ startedAt: iso(100), endedAt: iso(160), reason: "disconnect" }]);
  });

  it("a second down while a gap is open does not open another", () => {
    const store = open();
    store.study.recordConnection(down(10));
    store.study.recordConnection(down(20));
    expect(store.study.gaps()).toHaveLength(1);
  });

  it("a worker restart is a gap from the last event it saw until the connection is up again", () => {
    const store = open();
    store.study.recordConnection(up(0));
    store.study.recordTokenEvent(create(1, 50));
    store.study.recordBoot(at(500)); // the worker died after the event at 50 and came back at 500
    expect(store.study.gaps()).toEqual([{ startedAt: iso(50), endedAt: null, reason: "restart" }]);
    store.study.recordConnection(up(503));
    expect(store.study.gaps()).toEqual([{ startedAt: iso(50), endedAt: iso(503), reason: "restart" }]);
  });

  it("the first boot ever has no gap, and a clean stop is not doubled by the next boot", () => {
    const store = open();
    store.study.recordBoot(at(0));
    expect(store.study.gaps()).toEqual([]);
    store.study.recordConnection(up(1));
    store.study.recordConnection(down(100)); // clean close()
    store.study.recordBoot(at(200));
    expect(store.study.gaps()).toEqual([{ startedAt: iso(100), endedAt: null, reason: "disconnect" }]);
  });
});

describe("Study stats", () => {
  it("count seen, in population, captured, missed and the empty app shell share", () => {
    const store = open();
    // 1: captured with a working page; 2: captured empty shell; 3: counted (no links); 4: still pending; 5: missed; 6: out of scope
    for (const n of [1, 2, 3, 4]) store.study.recordTokenEvent(create(n, 0));
    store.study.recordTokenEvent(migrate(5, 30));
    store.study.recordTokenEvent(create(6, 0, { pool: "bonk", uri: "" }));
    store.study.recordSnapshot(snap(1), at(60));
    store.study.recordSnapshot(snap(2, { website: { ...snap(2).website!, emptyShell: true } }), at(61));
    store.study.markToken(mintOf(3), "counted", "no website or X link", { inPopulation: false });
    store.study.recordTokenEvent(migrate(1, 40));
    expect(store.study.stats(at(70))).toMatchObject({
      seen: 4,
      outOfScope: 1,
      inPopulation: 2,
      captured: 2,
      counted: 1,
      pending: 1,
      missed: 1,
      migrations: 2,
      missedShare: 0.5,
      websiteFetched: 2,
      emptyShell: 1,
      emptyShellShare: 0.5,
    });
  });

  it("the shell share is null while no page has been fetched, and pages that were not read do not count", () => {
    const store = open();
    store.study.recordTokenEvent(create(1, 0));
    expect(store.study.stats(at(10)).emptyShellShare).toBeNull();
    store.study.recordSnapshot(snap(1, { website: { ...snap(1).website!, status: "robots-disallowed", emptyShell: null, text: "" } }), at(60));
    const s = store.study.stats(at(70));
    expect(s.emptyShellShare).toBeNull();
    expect(s.websiteFetched).toBe(0);
  });

  it("can be limited to a window by first-seen time", () => {
    const store = open();
    store.study.recordTokenEvent(create(1, 0));
    store.study.recordTokenEvent(create(2, 1000));
    expect(store.study.stats(at(2000), iso(500)).seen).toBe(1);
    expect(store.study.stats(at(2000)).seen).toBe(2);
  });

  it("reports gaps and the capture runs against the cap", () => {
    const store = open();
    store.study.recordConnection({ state: "down", at: iso(100) });
    store.study.recordConnection({ state: "up", at: iso(160) });
    store.study.recordConnection({ state: "down", at: iso(200) });
    store.study.recordTokenEvent(create(1, 0));
    store.study.beginCaptureRun(mintOf(1), at(60), 100);
    const s = store.study.stats(at(300));
    expect(s.gapCount).toBe(2);
    expect(s.gapSeconds).toBe(60 + 100); // the open gap runs to now
    expect(s.captureRuns24h).toBe(1);
    expect(s.captureRunCap).toBeGreaterThan(0);
  });
});

describe("recentMigrated (the propose prompt's examples, ticket 22)", () => {
  it("returns the newest migrated tokens that have a name, with the Snapshot's description and site title when there is one", () => {
    const store = open();
    store.study.recordTokenEvent(create(1, 0, { name: "Moon Cat", symbol: "MCAT", creator: "CreatorA" }));
    store.study.recordSnapshot(snap(1, { description: "A cat on the moon" }), at(60));
    store.study.recordTokenEvent(create(2, 0, { name: "No Snapshot", symbol: "NS", creator: "CreatorB" }));
    store.study.recordTokenEvent(create(3, 0, { name: "Never Migrated" }));
    store.study.recordTokenEvent(create(4, 0, { name: "   " }));
    store.study.recordTokenEvent(migrate(1, 100));
    store.study.recordTokenEvent(migrate(2, 300));
    store.study.recordTokenEvent(migrate(4, 200));
    store.study.recordTokenEvent(migrate(5, 400)); // create never seen: no name
    const rows = store.study.recentMigrated(10);
    expect(rows.map((r) => r.name)).toEqual(["No Snapshot", "Moon Cat"]);
    expect(rows[0]).toEqual({ mint: mintOf(2), name: "No Snapshot", symbol: "NS", migratedAt: iso(300), description: "", siteTitle: "" });
    expect(rows[1]).toMatchObject({ symbol: "MCAT", migratedAt: iso(100), description: "A cat on the moon", siteTitle: "Cat" });
  });

  it("takes the newest N, clamps the limit to 0..20 and returns nothing for an empty Study", () => {
    const store = open();
    expect(store.study.recentMigrated(10)).toEqual([]);
    for (let n = 1; n <= 25; n++) {
      store.study.recordTokenEvent(create(n, 0, { creator: `Creator${n}` }));
      store.study.recordTokenEvent(migrate(n, 100 + n));
    }
    expect(store.study.recentMigrated(3).map((r) => r.name)).toEqual(["Token 25", "Token 24", "Token 23"]);
    expect(store.study.recentMigrated(500)).toHaveLength(20);
    for (const bad of [0, -1, Number.NaN]) expect(store.study.recentMigrated(bad)).toEqual([]);
  });

  it("keeps one row per creator, so one creator's 12 migrations yield 1 example", () => {
    const store = open();
    for (let n = 1; n <= 12; n++) {
      store.study.recordTokenEvent(create(n, 0, { name: `Spam ${n}`, symbol: `S${n}`, creator: "SameCreator" }));
      store.study.recordTokenEvent(migrate(n, 100 + n));
    }
    expect(store.study.recentMigrated(10).map((r) => r.name)).toEqual(["Spam 12"]);
  });

  it("dedupes by normalised name and by symbol, and an empty creator is not deduped", () => {
    const store = open();
    store.study.recordTokenEvent(create(1, 0, { name: "Moon Cat", symbol: "MCAT1", creator: "CreatorA" }));
    store.study.recordTokenEvent(create(2, 0, { name: "moon  CAT!", symbol: "OTHER", creator: "CreatorB" }));
    store.study.recordTokenEvent(create(3, 0, { name: "Dog", symbol: "MCAT1", creator: "CreatorC" }));
    store.study.recordTokenEvent(create(4, 0, { name: "Fish", symbol: "FSH", creator: "" }));
    store.study.recordTokenEvent(create(5, 0, { name: "Bird", symbol: "BRD", creator: "" }));
    for (const n of [1, 2, 3, 4, 5]) store.study.recordTokenEvent(migrate(n, 200 - n)); // newest first: 1, 2, 3, 4, 5
    expect(store.study.recentMigrated(10).map((r) => r.name)).toEqual(["Moon Cat", "Fish", "Bird"]);
  });
});
