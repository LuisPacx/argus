import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import type { DexPair } from "../sources/dexscreener.ts";
import { tempDir } from "../testing/temp.ts";
import { recomputeMetas, type MetaDexClient } from "./compute.ts";
import { META_RULE } from "./config.ts";

const NOW = Date.parse("2026-11-11T20:00:00.000Z");

let seq = 0;
const mintOf = () => `M${String(seq++).padStart(8, "0")}`.padEnd(40, "x") + "pump";
const creatorOf = (c: number | string) => `C${c}`.padEnd(44, "1");

interface Spec {
  name: string;
  symbol?: string;
  creator?: number | string;
  /** Minutes before NOW. */
  createdMin?: number;
  /** Seconds after the create; omitted means never migrated. */
  migratedAfterSec?: number;
  pool?: string;
}

/** Records one token's create (and migrate) events the way the worker does. Returns its mint. */
function launch(store: Datastore, s: Spec): string {
  const mint = mintOf();
  const createdMs = NOW - (s.createdMin ?? 30) * 60_000;
  store.study.recordTokenEvent({
    kind: "create", mint, receivedAt: new Date(createdMs).toISOString(), signature: "", name: s.name, symbol: s.symbol ?? s.name.toUpperCase().slice(0, 8),
    creator: creatorOf(s.creator ?? seq), uri: "https://ipfs.io/ipfs/x", pool: s.pool ?? "pump",
  });
  if (s.migratedAfterSec !== undefined)
    store.study.recordTokenEvent({ kind: "migrate", mint, receivedAt: new Date(createdMs + s.migratedAfterSec * 1000).toISOString(), signature: "", name: "", symbol: "", creator: "", uri: "", pool: "pump-amm" });
  return mint;
}

const launchMany = (store: Datastore, count: number, f: (i: number) => Spec) => Array.from({ length: count }, (_, i) => launch(store, f(i)));

const pair = (mint: string, marketCapUsd?: number): DexPair => ({
  chainId: "solana", tokenAddress: mint, name: "", symbol: "", url: "", liquidityUsd: 0, volume24hUsd: 0, priceChange24hPct: 0, ...(marketCapUsd !== undefined ? { marketCapUsd } : {}),
});

/** A counting fake: answers each address with the market cap in `caps`, and records every call. */
function fakeDex(caps: Map<string, number>, opts: { failOn?: (n: number) => boolean } = {}) {
  const calls: string[][] = [];
  const client: MetaDexClient = {
    async tokenPairs(chainId, addresses) {
      expect(chainId).toBe("solana");
      calls.push(addresses);
      if (opts.failOn?.(calls.length)) throw new Error("boom");
      return addresses.filter((a) => caps.has(a)).map((a) => pair(a, caps.get(a)));
    },
  };
  return { client, calls };
}

const rows = (store: Datastore, window: "6h" | "24h" = "24h", limit = 100) => store.latestMetas(window, limit)?.rows ?? [];
const order = (store: Datastore, window: "6h" | "24h" = "24h") => rows(store, window).map((r) => r.label);

describe("recomputeMetas: ranking", () => {
  it("ranks by distinct creators first: one creator spamming 50 same-name tokens ranks below 10 creators with 10 tokens each", async () => {
    const store = Datastore.open(":memory:");
    launchMany(store, 50, () => ({ name: "SpamCoin", creator: "spammer" }));
    launchMany(store, 100, (i) => ({ name: "Crowd", creator: `c${i % 10}` }));
    await recomputeMetas(store, { now: new Date(NOW) });
    expect(order(store)).toEqual(["Crowd", "SpamCoin"]);
    const [crowd, spam] = rows(store);
    expect(crowd).toMatchObject({ rank: 1, counts: { "24h": { tokens: 100, creators: 10 } } });
    expect(spam).toMatchObject({ rank: 2, counts: { "24h": { tokens: 50, creators: 1 } } });
  });

  it("with equal creators, a group with fewer tokens but more migrations ranks above a larger group with none", async () => {
    const store = Datastore.open(":memory:");
    launchMany(store, 12, (i) => ({ name: "BigNoMigrate", creator: `a${i % 5}` }));
    launchMany(store, 5, (i) => ({ name: "SmallMigrated", creator: `b${i}`, migratedAfterSec: i < 4 ? 120 : undefined }));
    await recomputeMetas(store, { now: new Date(NOW) });
    expect(order(store)).toEqual(["SmallMigrated", "BigNoMigrate"]);
  });

  it("the migrations key is the organic one: migrations within 60 s of the create (bundled with it) do not lift a group", async () => {
    const store = Datastore.open(":memory:");
    launchMany(store, 5, (i) => ({ name: "Bundled", creator: `a${i}`, migratedAfterSec: 5 })); // 5 unfiltered, 0 after 60 s
    launchMany(store, 5, (i) => ({ name: "Organic", creator: `b${i}`, migratedAfterSec: i === 0 ? 300 : undefined })); // 1 unfiltered, 1 after 60 s
    await recomputeMetas(store, { now: new Date(NOW) });
    expect(order(store)).toEqual(["Organic", "Bundled"]);
    const bundled = rows(store).find((r) => r.label === "Bundled")!;
    expect(bundled.counts["24h"]).toMatchObject({ migrations: 5, migrationsAfter60s: 0 }); // the unfiltered figure is still stored and shown
  });

  it("the decided order (user, 2026-11-11) is creators, then migrations after 60 s, then market cap, then tokens", () => {
    expect(META_RULE.rankOrder).toEqual(["creators", "migrationsAfter60s", "marketCapUsd", "tokens"]);
  });

  it("a group needs at least two tokens to be a Meta", async () => {
    const store = Datastore.open(":memory:");
    launch(store, { name: "Lonely" });
    launchMany(store, 2, () => ({ name: "Pair" }));
    await recomputeMetas(store, { now: new Date(NOW) });
    expect(order(store)).toEqual(["Pair"]);
  });

  it("is deterministic when everything ties: label order of the keys, not insertion order", async () => {
    const a = Datastore.open(":memory:");
    const b = Datastore.open(":memory:");
    for (const name of ["Zeta", "Alpha", "Mid"]) launchMany(a, 3, (i) => ({ name, creator: `${name}${i}` }));
    for (const name of ["Mid", "Zeta", "Alpha"]) launchMany(b, 3, (i) => ({ name, creator: `${name}${i}` }));
    await recomputeMetas(a, { now: new Date(NOW) });
    await recomputeMetas(b, { now: new Date(NOW) });
    expect(order(a)).toEqual(["Alpha", "Mid", "Zeta"]);
    expect(order(b)).toEqual(order(a));
  });
});

describe("recomputeMetas: windows and counts", () => {
  it("ranks the 6 h and 24 h windows separately and keeps both windows' counts on every row", async () => {
    const store = Datastore.open(":memory:");
    // Old burst: 8 creators 10 hours ago. Fresh: 3 creators in the last hour.
    launchMany(store, 8, (i) => ({ name: "OldBurst", creator: `o${i}`, createdMin: 600 + i }));
    launchMany(store, 3, (i) => ({ name: "Fresh", creator: `f${i}`, createdMin: 10 + i }));
    launchMany(store, 3, (i) => ({ name: "OldBurst", creator: `o${i}`, createdMin: 20 + i, symbol: "OLDBURST" }));
    await recomputeMetas(store, { now: new Date(NOW) });
    expect(order(store, "24h")).toEqual(["OldBurst", "Fresh"]);
    // OldBurst has 3 tokens in the last 6 h and Fresh 3 with 3 creators each: creators tie, and "Fresh" sorts first by key.
    expect(rows(store, "6h").map((r) => r.label).sort()).toEqual(["Fresh", "OldBurst"]);
    const oldBurst = rows(store, "24h").find((r) => r.label === "OldBurst")!;
    expect(oldBurst.counts).toEqual({
      "6h": { tokens: 3, creators: 3, migrations: 0, migrationsAfter60s: 0 },
      "24h": { tokens: 11, creators: 8, migrations: 0, migrationsAfter60s: 0 },
    });
  });

  it("ignores tokens created after the as-of time and migrations after it, and tokens older than 24 h", async () => {
    const store = Datastore.open(":memory:");
    launchMany(store, 3, (i) => ({ name: "Edge", creator: `e${i}`, createdMin: 60, migratedAfterSec: i === 0 ? 30 : i === 1 ? 7200 : undefined }));
    launchMany(store, 2, () => ({ name: "Edge", createdMin: -5 })); // created after NOW
    launchMany(store, 4, () => ({ name: "Stale", createdMin: 25 * 60 }));
    await recomputeMetas(store, { now: new Date(NOW) });
    expect(order(store)).toEqual(["Edge"]);
    expect(rows(store)[0]!.counts["24h"]).toMatchObject({ tokens: 3, migrations: 1 });
  });

  it("counts a migration as organic-ish only when it came more than 60 s after the create; both figures are kept", async () => {
    const store = Datastore.open(":memory:");
    launch(store, { name: "Bundled", creator: 1, migratedAfterSec: 0 });
    launch(store, { name: "Bundled", creator: 2, migratedAfterSec: 60 });
    launch(store, { name: "Bundled", creator: 3, migratedAfterSec: 61 });
    launch(store, { name: "Bundled", creator: 4, migratedAfterSec: 1200 });
    launch(store, { name: "Bundled", creator: 5 });
    await recomputeMetas(store, { now: new Date(NOW) });
    const row = rows(store)[0]!;
    expect(row.counts["24h"]).toMatchObject({ tokens: 5, migrations: 4, migrationsAfter60s: 2 });
    expect(row.migrationRate).toBeCloseTo(0.8);
    expect(row.createsPerMigration).toBeCloseTo(1.25);
  });

  it("createsPerMigration is null when nothing migrated, and migrationRate is 0", async () => {
    const store = Datastore.open(":memory:");
    launchMany(store, 3, (i) => ({ name: "Dud", creator: i }));
    await recomputeMetas(store, { now: new Date(NOW) });
    expect(rows(store)[0]).toMatchObject({ createsPerMigration: null, migrationRate: 0 });
  });

  it("stores the run's base migration rate over every token created in the window, all groups together, with a note about the cohort", async () => {
    const store = Datastore.open(":memory:");
    launchMany(store, 4, (i) => ({ name: "Cluster", creator: i, migratedAfterSec: i < 2 ? 5 : undefined })); // 2 of 4
    launchMany(store, 6, (i) => ({ name: `Single ${i}`, symbol: `S${i}`, migratedAfterSec: i === 0 ? 5 : undefined })); // 1 of 6
    launchMany(store, 10, (i) => ({ name: `Other chain ${i}`, pool: "bonk", migratedAfterSec: undefined })); // out of scope: not in the base
    launch(store, { name: "Old", createdMin: 8 * 60, migratedAfterSec: 5 }); // outside 6 h, inside 24 h
    await recomputeMetas(store, { now: new Date(NOW) });
    const run24 = store.latestMetas("24h", 10)!;
    const run6 = store.latestMetas("6h", 10)!;
    expect(run24.baseMigrationRate).toBeCloseTo(4 / 11);
    expect(run6.baseMigrationRate).toBeCloseTo(3 / 10);
    expect(run24).toMatchObject({ windowTokens: 11, windowMigrations: 4 });
    expect(run24.note).toMatch(/created in the window/i);
    expect(run24.note).toMatch(/unfiltered/i);
  });

  it("the base rate is null when no token was created in the window", async () => {
    const store = Datastore.open(":memory:");
    await recomputeMetas(store, { now: new Date(NOW) });
    const run = store.latestMetas("24h", 10)!;
    expect(run.baseMigrationRate).toBeNull();
    expect(run.rows).toEqual([]);
  });
});

describe("recomputeMetas: market cap", () => {
  it("looks up the top groups' candidates with one call each, shows the top three by market cap and sums them", async () => {
    const store = Datastore.open(":memory:");
    const mints = launchMany(store, 6, (i) => ({ name: "Woohao", symbol: "WOOHAO", creator: i, migratedAfterSec: 10 }));
    const caps = new Map([[mints[0]!, 13_000_000], [mints[1]!, 2_000_000], [mints[2]!, 500_000], [mints[3]!, 100_000]]);
    const { client, calls } = fakeDex(caps);
    await recomputeMetas(store, { now: new Date(NOW), dex: client });
    expect(calls).toHaveLength(1);
    const row = rows(store)[0]!;
    expect(row.topTokens.map((t) => t.marketCapUsd)).toEqual([13_000_000, 2_000_000, 500_000]);
    expect(row.topTokens[0]!.mint).toBe(mints[0]);
    expect(row.topMarketCapUsd).toBe(13_000_000);
    expect(row.marketCapUsd).toBe(15_500_000);
  });

  it("ranks by market cap after creators and migrations; a group without one is neither dropped nor given a figure", async () => {
    const store = Datastore.open(":memory:");
    const a = launchMany(store, 3, (i) => ({ name: "Known", creator: `k${i}` }));
    launchMany(store, 4, (i) => ({ name: "Unknown", creator: `u${i % 3}` })); // same 3 creators, more tokens, no market cap
    await recomputeMetas(store, { now: new Date(NOW), dex: fakeDex(new Map([[a[0]!, 90_000]])).client });
    expect(order(store)).toEqual(["Known", "Unknown"]);
    const unknown = rows(store).find((r) => r.label === "Unknown")!;
    expect(unknown.marketCapUsd).toBeUndefined();
    expect(unknown.topMarketCapUsd).toBeUndefined();
    expect(unknown.topTokens.every((t) => t.marketCapUsd === undefined)).toBe(true);
  });

  it("without any market cap the ranking still works and says nothing about it", async () => {
    const store = Datastore.open(":memory:");
    launchMany(store, 3, (i) => ({ name: "Alpha", creator: `a${i}` }));
    launchMany(store, 4, (i) => ({ name: "Beta", creator: `b${i}` }));
    await recomputeMetas(store, { now: new Date(NOW) });
    expect(order(store)).toEqual(["Beta", "Alpha"]);
    expect(rows(store).every((r) => r.marketCapUsd === undefined)).toBe(true);
  });

  it("a failed or empty lookup leaves the figure absent and is counted, not thrown", async () => {
    const store = Datastore.open(":memory:");
    launchMany(store, 3, (i) => ({ name: "Alpha", creator: `a${i}` }));
    launchMany(store, 3, (i) => ({ name: "Beta", creator: `b${i}` }));
    const { client } = fakeDex(new Map(), { failOn: (n) => n === 1 });
    const result = await recomputeMetas(store, { now: new Date(NOW), dex: client });
    expect(result.dexFailures).toBe(1);
    expect(rows(store)).toHaveLength(2);
    expect(rows(store).every((r) => r.marketCapUsd === undefined)).toBe(true);
  });

  it("stops looking up after 3 consecutive failures, and a success resets the streak", async () => {
    const store = Datastore.open(":memory:");
    for (let g = 0; g < 8; g++) launchMany(store, 3, (i) => ({ name: `Group${g}`, creator: `g${g}-${i}` }));
    const down = fakeDex(new Map(), { failOn: () => true });
    const r = await recomputeMetas(store, { now: new Date(NOW), dex: down.client });
    expect(down.calls.length).toBe(3);
    expect(r.dexCalls).toBe(3);
    expect(r.dexFailures).toBe(3);
    expect(rows(store)).toHaveLength(8); // the groups still rank, without market cap

    const flaky = fakeDex(new Map(), { failOn: (n) => n !== 3 && n !== 6 });
    await recomputeMetas(store, { now: new Date(NOW), dex: flaky.client });
    expect(flaky.calls.length).toBe(8); // fail, fail, ok, fail, fail, ok, fail, fail: never 3 in a row
  });

  it("never makes more DexScreener calls than the budget, and never more than one per group", async () => {
    const store = Datastore.open(":memory:");
    for (let g = 0; g < 15; g++) launchMany(store, 3, (i) => ({ name: `Group${g}`, creator: `g${g}-${i}` }));
    const budget = fakeDex(new Map());
    const r = await recomputeMetas(store, { now: new Date(NOW), dex: budget.client, config: { ...META_RULE, dexGroups: 12, dexMaxCalls: 4 } });
    expect(budget.calls.length).toBe(4);
    expect(r.dexCalls).toBe(4);
    for (const addresses of budget.calls) expect(addresses.length).toBeLessThanOrEqual(30);
    const wide = fakeDex(new Map());
    const w = await recomputeMetas(store, { now: new Date(NOW), dex: wide.client, config: { ...META_RULE, dexGroups: 3, dexMaxCalls: 50 } });
    expect(wide.calls.length).toBeLessThanOrEqual(6); // at most dexGroups per window, shared between the windows
    expect(w.dexCalls).toBe(wide.calls.length);
  });

  it("prefers migrated tokens as lookup candidates and sends at most 30 addresses per call", async () => {
    const store = Datastore.open(":memory:");
    const plain = launchMany(store, 40, (i) => ({ name: "Big", symbol: "BIG", creator: i }));
    const migrated = launchMany(store, 5, (i) => ({ name: "Big", symbol: "BIG", creator: 100 + i, migratedAfterSec: 20 }));
    const { client, calls } = fakeDex(new Map());
    await recomputeMetas(store, { now: new Date(NOW), dex: client });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(30);
    for (const m of migrated) expect(calls[0]).toContain(m);
    expect(plain.some((m) => calls[0]!.includes(m))).toBe(true);
  });
});

describe("recomputeMetas: cost and the write lock", () => {
  it("recomputes a 24 h window of 12,000 creates in under 5 s of CPU", async () => {
    const store = Datastore.open(":memory:");
    for (let i = 0; i < 12_000; i++) {
      const hot = i % 6 === 0;
      launch(store, { name: hot ? `Hot ${i % 40}` : `Name ${i}`, symbol: hot ? `H${i % 40}` : `N${i}`, creator: i % 900, createdMin: (i * 1440) / 12_000, migratedAfterSec: i % 25 === 0 ? 10 : undefined });
    }
    const cpu0 = process.cpuUsage();
    await recomputeMetas(store, { now: new Date(NOW) });
    const cpu = process.cpuUsage(cpu0);
    expect((cpu.user + cpu.system) / 1000).toBeLessThan(5_000);
    expect(rows(store)).toHaveLength(20);
  });

  it("holds no write lock while it waits on DexScreener: a second connection can write during the lookup", async () => {
    const path = join(tempDir("meta-lock-"), "argus.db");
    const store = Datastore.open(path);
    const other = Datastore.open(path);
    launchMany(store, 3, (i) => ({ name: "Alpha", creator: `a${i}` }));
    let wrote = 0;
    const client: MetaDexClient = {
      async tokenPairs() {
        const t0 = Date.now();
        launch(other, { name: "Written during lookup", createdMin: 1 });
        wrote = Date.now() - t0;
        return [];
      },
    };
    await recomputeMetas(store, { now: new Date(NOW), dex: client });
    expect(wrote).toBeLessThan(500);
    store.close();
    other.close();
  });
});

describe("recomputeMetas: theme Metas", () => {
  // 31 creators behind the ni hao cluster make it an anchor; the spellings are one creator each.
  // Creator ids end in letters: the helper pads ids with "1", so `n1` and `n11` would be the same creator.
  const who = (prefix: string, i: number) => `${prefix}${"abcdefghijklmnopqrstuvwxyz"[i % 26]}${"abcdefghijklmnopqrstuvwxyz"[Math.floor(i / 26)]}`;
  const seed = (store: Datastore) => {
    launchMany(store, 31, (i) => ({ name: "ni hao cat", symbol: "nihao", creator: who("n", i) }));
    launchMany(store, 5, (i) => ({ name: `Ni Hao ${["Noon", "Gang", "Pump", "Moon", "Rich"][i]}`, symbol: `NH${i}`, creator: who("t", i) }));
    launchMany(store, 12, (i) => ({ name: "Unrelated", creator: who("u", i) }));
  };

  it("counts the spellings of a theme as one Meta, with the creators behind all of them", async () => {
    const store = Datastore.open(":memory:");
    seed(store);
    await recomputeMetas(store, { now: new Date(NOW) });
    expect(order(store)).toEqual(["ni hao cat", "Unrelated"]);
    expect(rows(store)[0]).toMatchObject({ counts: { "24h": { tokens: 36, creators: 36 } } });
    store.close();
  });

  it("keeps clone clusters apart when theme merging is off in the rule", async () => {
    const store = Datastore.open(":memory:");
    seed(store);
    await recomputeMetas(store, { now: new Date(NOW), config: { ...META_RULE, theme: null } });
    expect(rows(store)[0]).toMatchObject({ label: "ni hao cat", counts: { "24h": { tokens: 31, creators: 31 } } });
    store.close();
  });
});
