import { Datastore, META_RULE, raiseNewMetas, type CurrentMeta, type CurrentMetaResponse, type MetasResponse, type NewMetasResponse } from "@argus/core";
import { beforeEach, expect, it, vi } from "vitest";

/** Endpoint-level test: the real route handlers over a real in-memory store, with only Nitro's auto-imported globals stubbed. */
type Ev = { query: Record<string, string> };
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("getQuery", (e: Ev) => e.query);
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);

const newMetas = (await import("../api/new-metas.get.ts")).default as unknown as () => NewMetasResponse;
const current = (await import("../api/current-meta.get.ts")).default as unknown as () => CurrentMetaResponse;
const metas = (await import("../api/metas.get.ts")).default as unknown as (e: Ev) => MetasResponse;

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

/** A Meta led by a token with a market cap, as the worker stores it. */
function aMeta(key: string, o: { label?: string; cap?: number; leaderName?: string; leaderSymbol?: string; creators?: number } = {}): CurrentMeta {
  const creators = o.creators ?? 14;
  const c = (tokens: number, n: number) => ({ tokens, creators: n, migrations: 2, migrationsAfter60s: 1 });
  return {
    key,
    label: o.label ?? key,
    leader: { mint: `${key}Mint`.padEnd(40, "L") + "pump", name: o.leaderName ?? `${key} leader`, symbol: o.leaderSymbol ?? key.toUpperCase(), marketCapUsd: o.cap ?? 2_400_000, source: "trending", stale: false, freshAt: ago(5).toISOString() },
    holding: false,
    enteredAt: ago(120).toISOString(),
    counts: { "6h": c(10, 5), "24h": c(creators * 2, creators) },
    topTokens: [],
  };
}

/** Stores a run at `at` with these Metas and no launch-theme rows. */
function saveCurrentRun(s: Datastore, at: Date, current: { metas?: CurrentMeta[]; watching?: CurrentMeta[] }): void {
  s.meta.saveRun({
    computedAt: at.toISOString(),
    note: "n",
    rule: META_RULE,
    dexCalls: 0,
    dexFailures: 0,
    base: { "6h": { tokens: 0, migrations: 0 }, "24h": { tokens: 0, migrations: 0 } },
    rows: { "6h": [], "24h": [] },
    current: { metas: current.metas ?? [], watching: current.watching ?? [] },
  });
}

beforeEach(() => {
  store = Datastore.open(":memory:");
});

it("GET /api/new-metas is an empty list, not an error, before the first run and while nothing is new", () => {
  expect(newMetas()).toEqual({ computedAt: null, items: [] });
  saveCurrentRun(store, ago(30), { metas: [aMeta("jensen")] });
  expect(newMetas().items).toEqual([]);
});

it("GET /api/new-metas returns a new Meta with its leader and its matching news; /api/current-meta marks the row; /api/metas has neither a mark nor ideas", () => {
  saveCurrentRun(store, ago(45), { metas: [aMeta("gta6", { label: "GTA VI" })] });
  saveCurrentRun(store, ago(30), { metas: [aMeta("gta6", { label: "GTA VI" }), aMeta("jensen", { label: "jensen", leaderName: "Jensen Huang", leaderSymbol: "JENSEN", cap: 2_400_000, creators: 31 })] });
  expect(raiseNewMetas(store)).toHaveLength(1);
  store.recordSignals([
    { id: "rss:1", sourceId: "rss:wired", sourceLabel: "Wired", title: "Nvidia CEO Jensen Huang on stage", summary: "", url: "https://example.com/j", publishedAt: ago(120).toISOString() },
    { id: "pp:1", sourceId: "pumpportal:events", sourceLabel: "PumpPortal", title: "New token on pump: Jensen ($JENSEN)", summary: "", url: "", publishedAt: ago(10).toISOString() },
  ]);
  const r = newMetas();
  expect(r.items).toHaveLength(1);
  expect(r.items[0]).toMatchObject({
    reason: "became a Meta: $JENSEN at $2.4M, 31 creators in 24 h",
    meta: { key: "jensen", label: "jensen", leader: { name: "Jensen Huang", symbol: "JENSEN", marketCapUsd: 2_400_000 }, summarySource: "template" },
    news: [{ title: "Nvidia CEO Jensen Huang on stage", sourceLabel: "Wired", url: "https://example.com/j" }],
  });
  expect(r.items[0]!.news).toHaveLength(1); // the launchpad Signal is not news
  const c = current();
  expect(c.metas.find((m) => m.key === "jensen")!.newMeta).toMatchObject({ reason: "became a Meta: $JENSEN at $2.4M, 31 creators in 24 h" });
  expect(c.metas.filter((m) => m.newMeta)).toHaveLength(1);
  const rows = metas({ query: {} }).metas;
  for (const row of rows) expect(row).not.toHaveProperty("newMeta");
  for (const row of rows) expect(row).not.toHaveProperty("ideas");
});

it("an event whose subject is no longer a Meta in the newest run is left out, and an event older than its live window is too", () => {
  saveCurrentRun(store, ago(60), {});
  saveCurrentRun(store, ago(45), { metas: [aMeta("jensen")] });
  raiseNewMetas(store);
  expect(newMetas().items).toHaveLength(1);
  saveCurrentRun(store, ago(15), { metas: [] }); // it fell out
  expect(newMetas().items).toEqual([]);
  const old = Datastore.open(":memory:");
  store = old;
  saveCurrentRun(old, ago(60 * 8 + 15), {});
  saveCurrentRun(old, ago(60 * 8), { metas: [aMeta("jensen")] });
  raiseNewMetas(old);
  saveCurrentRun(old, ago(1), { metas: [aMeta("jensen")] });
  expect(newMetas().items).toEqual([]); // raised 8 h ago: past the 6 h
});
