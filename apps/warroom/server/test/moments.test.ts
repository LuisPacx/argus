import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Datastore } from "@argus/core";
import { tempDir } from "../../../../packages/core/src/testing/temp.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/moments (moment scanner ticket 01): the real route handler over a seeded store. Only Nitro's auto-imported globals are stubbed. It is
 * read only and returns exactly the listed fields.
 */
let store: Datastore;
let file: string;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("useStore", () => store);

type Payload = {
  enabled: boolean;
  topic: string | null;
  scanner: Record<string, unknown>;
  session: Record<string, unknown>;
  posts: Array<Record<string, unknown>>;
};
const get = (await import("../api/moments.get.ts")).default as unknown as () => Payload;

// Pinned mid-day UTC: the X session's probeDue turns true once the clock passes the next 00:00 UTC after the stop, so a real clock within 9 minutes after midnight flipped it.
const NOW = Date.parse("2026-06-15T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const idAt = (minutes: number, seq: number) => ((BigInt(NOW - minutes * 60_000 - 1_288_834_974_657) << 22n) | BigInt(seq)).toString();
const post = (seq: number, views: number | null, over: Record<string, unknown> = {}) => ({ statusId: idAt(180, seq), handle: "alice", text: `clip ${seq}`, hasVideo: true, counts: { replies: 1, reposts: 2, likes: 300, bookmarks: 4, views }, ...over });

/** Every row of every table, as one string: what "unchanged" means. */
function dump(): string {
  const raw = new DatabaseSync(file);
  try {
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    return JSON.stringify(tables.map((t) => [t, raw.prepare(`SELECT * FROM "${t}"`).all()]));
  } finally {
    raw.close();
  }
}

let savedEnv: string | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  savedEnv = process.env.ARGUS_MOMENTS;
  delete process.env.ARGUS_MOMENTS;
  file = path.join(tempDir("warroom-moments-"), "argus.db");
  store = Datastore.open(file);
});
afterEach(() => {
  vi.useRealTimers();
  store.close();
  if (savedEnv === undefined) delete process.env.ARGUS_MOMENTS;
  else process.env.ARGUS_MOMENTS = savedEnv;
});

const scan = (minutes: number, status: "ok" | "skipped" | "stopped" = "ok", reason = "") => store.moments.recordScan({ at: at(minutes), topic: "GTA VI", status, loads: 2, signals: [], reason });

describe("GET /api/moments", () => {
  it("returns only the listed fields, and a post only with the fields of a row", () => {
    const s = scan(5);
    store.moments.recordPosts(s, at(4), [post(1, 600_000, { text: "the iguana" })]);
    const r = get();
    expect(Object.keys(r).sort()).toEqual(["enabled", "posts", "scanner", "session", "topic"]);
    expect(Object.keys(r.scanner).sort()).toEqual(["lastGoodScanAt", "lastLoads", "lastReason", "lastScanAt", "lastStatus"]);
    expect(Object.keys(r.session).sort()).toEqual(["probeDue", "reason", "resumeAt", "status", "stoppedAt"]);
    expect(r.posts).toHaveLength(1);
    expect(Object.keys(r.posts[0]!).sort()).toEqual(["handle", "lastSeenAt", "likes", "postedAt", "readings", "recentRate", "statusId", "text", "url", "views", "viewsPerHour"]);
    expect(r).toMatchObject({ topic: "GTA VI", scanner: { lastScanAt: at(5), lastStatus: "ok", lastGoodScanAt: at(5) }, session: { status: "ok" }, posts: [{ handle: "alice", text: "the iguana", views: 600_000, readings: 1 }] });
    expect(r.posts[0]!.url).toBe(`https://x.com/alice/status/${idAt(180, 1)}`);
  });

  it("is empty and says nothing is on before any scan; enabled follows ARGUS_MOMENTS", () => {
    expect(get()).toEqual({ enabled: false, topic: null, scanner: { lastScanAt: null, lastStatus: null, lastReason: "", lastLoads: 0, lastGoodScanAt: null }, session: { status: "ok", reason: "", stoppedAt: null, resumeAt: null, probeDue: false }, posts: [] });
    process.env.ARGUS_MOMENTS = "1";
    expect(get().enabled).toBe(true);
    process.env.ARGUS_MOMENTS = "true";
    expect(get().enabled).toBe(false);
  });

  it("carries the scanner's last scan and the X session's stop, with the signal and the time", () => {
    scan(40);
    scan(10, "stopped", "stopped on login_wall: no retry");
    store.xSession.recordStop("login_wall", new Date(NOW - 9 * 60_000));
    const r = get();
    expect(r.scanner).toMatchObject({ lastStatus: "stopped", lastReason: "stopped on login_wall: no retry", lastGoodScanAt: at(40) });
    expect(r.session).toMatchObject({ status: "stopped", reason: "login_wall", stoppedAt: at(9), probeDue: false });
  });

  it("hostile post text arrives flattened, cut and without angle brackets, and its link is built from the handle and the ID, never from the text", () => {
    const s = scan(5);
    store.moments.recordPosts(s, at(4), [post(2, 900_000, { text: `<img src=x onerror=1>\nhttps://evil.example/ javascript:alert(1) ${"A".repeat(100_000)}` })]);
    const [p] = get().posts;
    expect(String(p!.text)).not.toMatch(/[<>\n]/);
    expect(String(p!.text).length).toBeLessThanOrEqual(601);
    expect(String(p!.url)).toMatch(/^https:\/\/x\.com\/alice\/status\/\d{15,19}$/);
    expect(JSON.stringify(get())).not.toContain("<img");
  });

  it("writes nothing: every table is the same before and after, twice", () => {
    const s = scan(5);
    store.moments.recordPosts(s, at(4), [post(1, 600_000)]);
    store.xSession.recordStop("challenge", new Date(NOW - 3 * 60_000));
    const before = dump();
    get();
    get();
    expect(dump()).toBe(before);
  });
});
