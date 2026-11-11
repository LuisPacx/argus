import { Datastore, recomputeMetas, type MetasResponse } from "@argus/core";
import { beforeEach, expect, it, vi } from "vitest";

/** Endpoint-level test: the real route handler, with only Nitro's auto-imported globals stubbed. */
type Ev = { query: Record<string, string> };
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("getQuery", (e: Ev) => e.query);
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);

const metas = (await import("../api/metas.get.ts")).default as unknown as (e: Ev) => MetasResponse;
const get = (query: Record<string, string> = {}) => metas({ query });

const NOW = Date.parse("2026-11-11T20:00:00.000Z");
/** Real-looking mints: base58, 44 characters. */
const LETTERS = "abcdefghijkmnopqrstuvwxyz"; // base58 has no l
const mintOf = (n: number) => `Pm${LETTERS[Math.floor(n / LETTERS.length)]}${LETTERS[n % LETTERS.length]}`.padEnd(40, "A") + "pump";
let seq = 1;

function launch(name: string, creator: string, opts: { createdMin?: number; migratedAfterSec?: number } = {}): string {
  const mint = mintOf(seq++);
  const createdMs = NOW - (opts.createdMin ?? 30) * 60_000;
  store.study.recordTokenEvent({ kind: "create", mint, receivedAt: new Date(createdMs).toISOString(), signature: "", name, symbol: name.toUpperCase().slice(0, 8), creator: `C${creator}`.padEnd(44, "x"), uri: "https://ipfs.io/ipfs/x", pool: "pump" });
  if (opts.migratedAfterSec !== undefined)
    store.study.recordTokenEvent({ kind: "migrate", mint, receivedAt: new Date(createdMs + opts.migratedAfterSec * 1000).toISOString(), signature: "", name: "", symbol: "", creator: "", uri: "", pool: "pump-amm" });
  return mint;
}

beforeEach(() => {
  store = Datastore.open(":memory:");
  seq = 1;
});

it("GET /api/metas is an empty list, not an error, before the first run", () => {
  expect(get()).toEqual({ window: "24h", computedAt: null, note: null, windowTokens: 0, windowMigrations: 0, baseMigrationRate: null, metas: [] });
});

it("GET /api/metas returns the stored latest run: rank, label, first seen, both windows' counts, top tokens, summary", async () => {
  const mints: string[] = [];
  for (let i = 0; i < 12; i++) mints.push(launch("woohao", `a${i}`, { createdMin: i < 4 ? 60 : 600, migratedAfterSec: i < 3 ? 300 : undefined }));
  for (let i = 0; i < 5; i++) launch("DeepSeek", `b${i}`, { migratedAfterSec: 100 });
  await recomputeMetas(store, { now: new Date(NOW), dex: { tokenPairs: async (_c, addresses) => addresses.filter((a) => a === mints[0]).map((tokenAddress) => ({ chainId: "solana", tokenAddress, name: "", symbol: "", url: "", liquidityUsd: 0, volume24hUsd: 0, priceChange24hPct: 0, marketCapUsd: 13_000_000 })) } });
  const r = get();
  expect(r).toMatchObject({ window: "24h", computedAt: "2026-11-11T20:00:00.000Z", windowTokens: 17, windowMigrations: 8 });
  expect(r.baseMigrationRate).toBeCloseTo(8 / 17);
  expect(r.note).toContain("unfiltered");
  expect(r.metas.map((m) => [m.rank, m.label])).toEqual([[1, "woohao"], [2, "DeepSeek"]]);
  const [w, d] = r.metas as [MetasResponse["metas"][number], MetasResponse["metas"][number]];
  expect(w).toMatchObject({
    firstSeenAt: new Date(NOW - 600 * 60_000).toISOString(),
    counts: { "24h": { tokens: 12, creators: 12, migrations: 3, migrationsAfter60s: 3 }, "6h": { tokens: 4, creators: 4, migrations: 3 } },
    createsPerMigration: 4,
    marketCapUsd: 13_000_000,
    summarySource: "template",
  });
  expect(w.summary).toBe("12 tokens from 12 creators in 24 h, 3 migrated (unfiltered); top: woohao $13M, woohao, woohao");
  expect(w.topTokens).toHaveLength(3);
  expect(w.topTokens[0]).toEqual({ mint: mints[0], name: "woohao", symbol: "WOOHAO", marketCapUsd: 13_000_000, url: `https://dexscreener.com/solana/${mints[0]}` });
  expect(w.topTokens[1]).not.toHaveProperty("url"); // no market cap: DexScreener did not know it, so no link
  expect(d.counts["24h"]).toMatchObject({ tokens: 5, migrations: 5 });
});

it("GET /api/metas carries a stored LLM line as the summary, with summarySource llm", async () => {
  for (let i = 0; i < 4; i++) launch("Rocketfuel", `c${i}`);
  await recomputeMetas(store, { now: new Date(NOW) });
  const key = store.latestMetas("24h", 5)!.rows[0]!.key;
  store.meta.saveSummary(key, "A cat theme with a few launches", "h", "2026-11-11T20:01:00.000Z");
  expect(get().metas[0]).toMatchObject({ summary: "A cat theme with a few launches", summarySource: "llm" });
});

it("GET /api/metas takes window (6h or 24h) and limit, and answers 400 for anything else", async () => {
  for (let g = 0; g < 4; g++) for (let i = 0; i < 3; i++) launch(`Group${g}`, `g${g}-${i}`, { createdMin: g === 3 ? 600 : 30 });
  await recomputeMetas(store, { now: new Date(NOW) });
  expect(get({ limit: "2" }).metas).toHaveLength(2);
  expect(get({ window: "6h" })).toMatchObject({ window: "6h", windowTokens: 9 });
  expect(get({ window: "6h" }).metas).toHaveLength(3);
  const status = (query: Record<string, string>) => {
    try {
      get(query);
    } catch (e) {
      return (e as { statusCode?: number }).statusCode;
    }
    return 200;
  };
  for (const query of [{ window: "7d" }, { window: "24H" }, { limit: "0" }, { limit: "abc" }, { limit: "51" }, { limit: "-1" }, { limit: "2.5" }]) expect(status(query), JSON.stringify(query)).toBe(400);
  expect(status({ window: "24h", limit: "50" })).toBe(200);
});

it("GET /api/metas is JSON text only: hostile names pass through as strings, and no link is built from a hostile mint", async () => {
  const hostile = `<script>alert(1)</script>\u0000 javascript:alert(1) ${"A".repeat(10_000)}`;
  for (let i = 0; i < 3; i++) launch(hostile, `h${i}`);
  await recomputeMetas(store, { now: new Date(NOW) });
  store.meta.saveSummary(store.latestMetas("24h", 5)!.rows[0]!.key, "x", "h", "2026-11-11T20:01:00.000Z");
  const r = JSON.parse(JSON.stringify(get())) as MetasResponse;
  const row = r.metas[0]!;
  expect(typeof row.label).toBe("string");
  expect(row.label.length).toBeLessThanOrEqual(60);
  expect(row.topTokens.every((t) => typeof t.name === "string" && t.name.length <= 60 && t.url === undefined)).toBe(true);

  // A mint that is not base58 gets no link even when a market cap is known.
  const evil = "javascript:alert(1)//".padEnd(44, "x");
  store.study.recordTokenEvent({ kind: "create", mint: evil, receivedAt: new Date(NOW - 60_000).toISOString(), signature: "", name: "Evil", symbol: "EVIL", creator: "E".padEnd(44, "x"), uri: "https://ipfs.io/ipfs/x", pool: "pump" });
  store.study.recordTokenEvent({ kind: "create", mint: `${evil}2`, receivedAt: new Date(NOW - 60_000).toISOString(), signature: "", name: "Evil", symbol: "EVIL", creator: "F".padEnd(44, "x"), uri: "https://ipfs.io/ipfs/x", pool: "pump" });
  await recomputeMetas(store, { now: new Date(NOW), dex: { tokenPairs: async (_c, addresses) => addresses.map((tokenAddress) => ({ chainId: "solana", tokenAddress, name: "", symbol: "", url: "", liquidityUsd: 0, volume24hUsd: 0, priceChange24hPct: 0, marketCapUsd: 5_000 })) } });
  const evilRow = get().metas.find((m) => m.label === "Evil")!;
  expect(evilRow.topTokens[0]!.marketCapUsd).toBe(5_000);
  expect(JSON.stringify(evilRow)).not.toContain("dexscreener.com");
});
