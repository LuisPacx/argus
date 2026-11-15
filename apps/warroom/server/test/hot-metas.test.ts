import { Datastore, META_RULE, raiseHotMetas, type HotNowResponse, type MetasResponse, type NewMetaRun } from "@argus/core";
import { beforeEach, expect, it, vi } from "vitest";

/** Endpoint-level test: the real route handlers over a real in-memory store, with only Nitro's auto-imported globals stubbed. */
type Ev = { query: Record<string, string> };
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("getQuery", (e: Ev) => e.query);
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);

const hot = (await import("../api/hot-metas.get.ts")).default as unknown as () => HotNowResponse;
const metas = (await import("../api/metas.get.ts")).default as unknown as (e: Ev) => MetasResponse;

const ago = (minutes: number) => Date.now() - minutes * 60_000;
const counts = (creators: number) => ({ tokens: creators * 2, creators, migrations: 3, migrationsAfter60s: 1 });
const run = (atMs: number, ranking: Array<[string, number]>): NewMetaRun => ({
  computedAt: new Date(atMs).toISOString(),
  note: "n",
  rule: META_RULE,
  dexCalls: 0,
  dexFailures: 0,
  base: { "6h": { tokens: 100, migrations: 5 }, "24h": { tokens: 400, migrations: 20 } },
  rows: {
    "6h": [],
    "24h": ranking.map(([key, creators]) => ({ key, label: key, firstSeenAt: new Date(ago(600)).toISOString(), counts: { "6h": counts(creators), "24h": counts(creators) }, topTokens: [{ mint: `${key}Mint`, name: key, symbol: key.toUpperCase() }] })),
  },
});
const fillers = (n: number): Array<[string, number]> => Array.from({ length: n }, (_, i) => [`filler${i}`, 500 - i]);

beforeEach(() => {
  store = Datastore.open(":memory:");
});

it("GET /api/hot-metas is an empty list, not an error, before the first run and while nothing is hot", () => {
  expect(hot()).toEqual({ computedAt: null, items: [] });
  store.meta.saveRun(run(ago(30), fillers(3)));
  expect(hot().items).toEqual([]);
});

it("GET /api/hot-metas returns a hot Meta with its row and its matching news, and /api/metas marks the row hot", () => {
  store.meta.saveRun(run(ago(90), [...fillers(8), ["jensen", 28]]));
  store.meta.saveRun(run(ago(30), [...fillers(2), ["jensen", 31]]));
  expect(raiseHotMetas(store)).toHaveLength(1);
  store.recordSignals([
    { id: "rss:1", sourceId: "rss:wired", sourceLabel: "Wired", title: "Nvidia CEO Jensen Huang on stage", summary: "", url: "https://example.com/j", publishedAt: new Date(ago(120)).toISOString() },
    { id: "pp:1", sourceId: "pumpportal:events", sourceLabel: "PumpPortal", title: "New token on pump: Jensen ($JENSEN)", summary: "", url: "", publishedAt: new Date(ago(10)).toISOString() },
  ]);
  const r = hot();
  expect(r.items).toHaveLength(1);
  expect(r.items[0]).toMatchObject({ reason: "entered top 5", meta: { rank: 3, label: "jensen" }, news: [{ title: "Nvidia CEO Jensen Huang on stage", sourceLabel: "Wired", url: "https://example.com/j" }] });
  expect(r.items[0]!.news).toHaveLength(1); // the launchpad Signal is not news
  const m = metas({ query: {} }).metas;
  expect(m.find((x) => x.label === "jensen")!.hot).toMatchObject({ reason: "entered top 5" });
  expect(m.filter((x) => x.hot)).toHaveLength(1);
});
