import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Datastore } from "@argus/core";
import { tempDir } from "../../../../packages/core/src/testing/temp.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/radar and /api/radar-strip (trend radar ticket 01): the real route handlers over a seeded store. Only Nitro's auto-imported globals are
 * stubbed. They are read only and return exactly the listed fields; the War Room process writes no radar table.
 */
let store: Datastore;
let file: string;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("useStore", () => store);

type Payload = { enabled: boolean; workerTickAt: string | null; trends: Array<Record<string, unknown> & { biggest: Record<string, unknown> | null; lookalikes: Array<Record<string, unknown>> }>; sources: Array<Record<string, unknown>>; alerts: Array<Record<string, unknown>>; lastGoodPollAt: string | null; counts: Record<string, number> };
const get = (await import("../api/radar.get.ts")).default as unknown as () => Payload;
const getStrip = (await import("../api/radar-strip.get.ts")).default as unknown as () => { enabled: boolean; shown: number; untokenized: number; alerts: unknown[] };

const NOW = Date.now();
const at = (minutes: number) => new Date(NOW - minutes * 60_000);

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
  savedEnv = process.env.ARGUS_RADAR;
  delete process.env.ARGUS_RADAR;
  file = path.join(tempDir("warroom-radar-"), "argus.db");
  store = Datastore.open(file);
});
afterEach(() => {
  store.close();
  if (savedEnv === undefined) delete process.env.ARGUS_RADAR;
  else process.env.ARGUS_RADAR = savedEnv;
});

const candidate = (term: string, key: string, over: Record<string, unknown> = {}) => ({ trafficText: "2000+", trafficMin: 2_000, newsTitle: "A headline", newsUrl: "https://news.example/a", sourceId: "radar:google:US", key, term, at: at(0).toISOString(), ...over });
function addTrend(term: string, key: string, over: Record<string, unknown> = {}, minutesAgo = 30): number {
  const c = candidate(term, key, over);
  store.radar.recordReading(c, at(minutesAgo).toISOString());
  store.radar.touchSeen(key, at(minutesAgo));
  return store.radar.createTrend({ key, label: term, firstSeen: at(minutesAgo).toISOString(), score: 20, candidate: c });
}
const token = (name: string, cap: number, liquidity: number) => ({ name, symbol: name.slice(0, 4).toUpperCase(), url: "https://dexscreener.com/solana/x", marketCapUsd: cap, liquidityUsd: liquidity, createdAt: at(300).toISOString() });

describe("GET /api/radar", () => {
  it("returns only the listed fields, and a Trend only with the fields of a row", () => {
    const id = addTrend("Alpha Bear", "alphabear");
    store.radar.recordCheck(id, { side: "taken", trace: { at: at(10).toISOString(), phrases: ["alpha bear"], live: [token("Alpha Bear coin", 90_000, 20_000)], lookalikes: [{ ...token("Dead bear", 131_000, 4), reason: "pool $4, cap $131K: drained or fake" }] }, localCreates: 9, localCreators: 6 }, at(10));
    store.radar.recordSource("radar:google:US", "ok", "", at(5));
    const r = get();
    expect(Object.keys(r).sort()).toEqual(["alerts", "counts", "enabled", "lastGoodPollAt", "sources", "trends", "workerTickAt"]);
    expect(Object.keys(r.counts).sort()).toEqual(["shown", "untokenized"]);
    expect(Object.keys(r.sources[0]!).sort()).toEqual(["label", "lastOk", "reason", "since", "source", "status"]);
    expect(r.trends).toHaveLength(1);
    const t = r.trends[0]!;
    expect(Object.keys(t).sort()).toEqual(["biggest", "changedAt", "changedWhy", "firstSeen", "id", "lastChecked", "lastSeen", "liveCount", "localCreates", "localCreators", "lookalikeCount", "lookalikes", "newsTitle", "newsUrl", "score", "side", "sideAt", "term", "traceAt", "trafficMin", "trafficText", "why"]);
    expect(Object.keys(t.biggest!).sort()).toEqual(["liquidityUsd", "marketCapUsd", "name", "symbol", "url"]);
    expect(Object.keys(t.lookalikes[0]!).sort()).toEqual(["liquidityUsd", "marketCapUsd", "name", "reason", "symbol", "url"]);
    expect(t).toMatchObject({ term: "Alpha Bear", side: "taken", trafficMin: 2_000, localCreates: 9, localCreators: 6, liveCount: 1, lookalikeCount: 1, newsUrl: "https://news.example/a" });
    expect(t.biggest).toMatchObject({ name: "Alpha Bear coin", marketCapUsd: 90_000 });
    expect(r).toMatchObject({ counts: { shown: 1, untokenized: 0 }, lastGoodPollAt: at(5).toISOString() });
    expect(JSON.stringify(r)).not.toContain("createdAt");
  });

  it("is empty before the radar has polled; enabled is what the WORKER wrote, never this process's own ARGUS_RADAR", () => {
    expect(get()).toEqual({ enabled: false, workerTickAt: null, trends: [], sources: [], alerts: [], lastGoodPollAt: null, counts: { shown: 0, untokenized: 0 } });
    process.env.ARGUS_RADAR = "1"; // the War Room's own environment says nothing
    expect(get().enabled).toBe(false);
    expect(getStrip().enabled).toBe(false);
    const state = { enabled: true, dryRun: false, startedAt: at(60).toISOString(), lastTickAt: null, geos: 8, feeds: 29 };
    store.radar.recordWorker(state);
    expect(get()).toMatchObject({ enabled: true, workerTickAt: null });
    expect(getStrip().enabled).toBe(true);
    store.radar.recordWorkerTick(at(5));
    expect(get()).toMatchObject({ enabled: true, workerTickAt: at(5).toISOString() });
    delete process.env.ARGUS_RADAR; // and a War Room started without it still shows the worker as on
    expect(get().enabled).toBe(true);
    store.radar.recordWorker({ ...state, enabled: false }); // the worker started with the radar off
    process.env.ARGUS_RADAR = "1";
    expect(get().enabled).toBe(false);
    store.radar.recordWorker({ ...state, dryRun: true }); // a dry run polls nothing: not "on"
    expect(get().enabled).toBe(false);
  });

  it("carries the source banner after an hour and not before", () => {
    store.radar.recordSource("radar:google:US", "ok", "", at(200));
    store.radar.recordSource("radar:google:US", "backing off", "HTTP 429", at(59));
    expect(get().alerts).toEqual([]);
    expect(getStrip().alerts).toEqual([]);
    store.radar.recordSource("radar:google:US", "backing off", "HTTP 429", at(1));
    store.radar.recordSource("radar:google:GB", "format changed", "the answer is not the feed or has no items", at(90));
    expect(get().alerts).toEqual([{ source: "radar:google:GB", label: "", status: "format changed", reason: "the answer is not the feed or has no items", since: at(90).toISOString(), lastOk: null }]);
    expect(getStrip().alerts).toHaveLength(1);
  });

  it("returns at most 30 Trends, and 50 lookalikes on one", () => {
    for (let i = 0; i < 130; i++) addTrend(`Subject ${i}`, `subject${i}`);
    const top = candidate("Top term", "topterm");
    store.radar.touchSeen("topterm", at(1));
    const id = store.radar.createTrend({ key: "topterm", label: "Top term", firstSeen: at(1).toISOString(), score: 99, candidate: top });
    store.radar.recordCheck(id, { side: "untokenized", trace: { at: at(1).toISOString(), phrases: [], live: [], lookalikes: Array.from({ length: 80 }, (_, n) => ({ ...token(`Dead ${n}`, 90_000, 1), reason: "drained" })) }, localCreates: 0, localCreators: 0 }, at(1));
    const r = get();
    expect(r.trends).toHaveLength(30);
    expect(r.counts.shown).toBe(131);
    expect(r.trends[0]).toMatchObject({ term: "Top term", score: 99, lookalikeCount: 80 });
    expect(r.trends[0]!.lookalikes).toHaveLength(50);
  });

  it("hostile text arrives as stored text, and a link is never built from it by the server", () => {
    addTrend("<img src=x onerror=1> hostile", "hostile", { newsUrl: "javascript:alert(1)", newsTitle: "<script>alert(1)</script>" });
    const [t] = get().trends;
    expect(t!.term).toBe("<img src=x onerror=1> hostile"); // the page renders it as text; escaping is the page's job (radar-render.test.ts)
    expect(t!.newsUrl).toBe("javascript:alert(1)");
  });

  it("writes nothing: every table is the same before and after, twice", () => {
    const id = addTrend("Alpha Bear", "alphabear");
    store.radar.recordCheck(id, { side: "untokenized", trace: { at: at(10).toISOString(), phrases: [], live: [], lookalikes: [] }, localCreates: 0, localCreators: 0 }, at(10));
    store.radar.recordSource("radar:google:US", "backing off", "HTTP 429", at(120));
    const before = dump();
    get();
    get();
    getStrip();
    expect(dump()).toBe(before);
  });
});

describe("GET /api/radar-strip", () => {
  it("returns only the counts and the banners, never a Trend", () => {
    const id = addTrend("Alpha Bear", "alphabear");
    store.radar.recordCheck(id, { side: "untokenized", trace: { at: at(10).toISOString(), phrases: [], live: [], lookalikes: [] }, localCreates: 0, localCreators: 0 }, at(10));
    addTrend("Beta Wolf", "betawolf");
    const r = getStrip();
    expect(Object.keys(r).sort()).toEqual(["alerts", "enabled", "shown", "untokenized"]);
    expect(r).toMatchObject({ shown: 2, untokenized: 1 });
  });
});

describe("the War Room writes no radar table", () => {
  const root = new URL("../../", import.meta.url);
  // The War Room's own sources: app/ and server/ (not its tests, and not node_modules or the build output).
  const files = ["app", "server"].flatMap((dir) => readdirSync(new URL(`${dir}/`, root), { recursive: true, encoding: "utf8" }).map((f) => `${dir}/${f}`)).filter((f) => /\.(ts|vue)$/.test(f) && !f.startsWith("server/test/"));
  it("reads the radar only through radarView and radarStrip, and never names a radar table or the worker's store", () => {
    expect(files).toEqual(expect.arrayContaining(["server/api/radar.get.ts", "server/api/radar-strip.get.ts", "app/pages/radar.vue"]));
    for (const f of files) {
      const src = readFileSync(new URL(f, root), "utf8");
      expect(src, f).not.toMatch(/radar_(readings|seen|trends|source_state)/);
      expect(src, f).not.toMatch(/\.radar\./);
      expect(src, f).not.toMatch(/INSERT INTO|UPDATE radar|DELETE FROM radar/);
    }
    const radarFiles = files.filter((f) => f.includes("radar"));
    expect(radarFiles.length).toBeGreaterThanOrEqual(4);
  });

  it("the radar pages and routes send no request but GET", () => {
    for (const f of ["app/pages/radar.vue", "app/components/RadarPanel.vue", "app/components/RadarStrip.vue", "app/utils/radar.ts"]) {
      const src = readFileSync(new URL(f, root), "utf8");
      expect(src, f).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)/i);
      expect(src, f).not.toContain("$fetch(");
    }
    expect(readFileSync(new URL("app/pages/radar.vue", root), "utf8")).toContain('useFetch("/api/radar"');
    expect(files.filter((f) => f.startsWith("server/api/radar")).sort()).toEqual(["server/api/radar-strip.get.ts", "server/api/radar.get.ts"]);
  });
});
