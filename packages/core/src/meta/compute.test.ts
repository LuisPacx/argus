import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import type { DexPair } from "../sources/dexscreener.ts";
import { tempDir } from "../testing/temp.ts";
import { recomputeMetas as recomputeWithRule, type MetaDexClient, type RecomputeOptions } from "./compute.ts";
import { metasResponse } from "./api.ts";
import { META_RULE, metaConfigFromEnv } from "./config.ts";
import { metaLines, selectMetas } from "./prompt-block.ts";

/** The pre-ticket-05 floor (2 tokens, no creator minimum): the tests that are not about the floor use tiny groups. */
const LOW_FLOOR = { ...META_RULE, minTokens: 2, minCreators: 1 };
const recomputeMetas = (store: Datastore, opts: RecomputeOptions = {}) => recomputeWithRule(store, { config: LOW_FLOOR, ...opts });

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

  it("a group needs at least two tokens to be a Meta under the old floor", async () => {
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
    const r = await recomputeMetas(store, { now: new Date(NOW), dex: budget.client, config: { ...LOW_FLOOR, dexGroups: 12, dexMaxCalls: 4 } });
    expect(budget.calls.length).toBe(4);
    expect(r.dexCalls).toBe(4);
    for (const addresses of budget.calls) expect(addresses.length).toBeLessThanOrEqual(30);
    const wide = fakeDex(new Map());
    const w = await recomputeMetas(store, { now: new Date(NOW), dex: wide.client, config: { ...LOW_FLOOR, dexGroups: 3, dexMaxCalls: 50 } });
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
    await recomputeMetas(store, { now: new Date(NOW), config: { ...LOW_FLOOR, theme: null } });
    expect(rows(store)[0]).toMatchObject({ label: "ni hao cat", counts: { "24h": { tokens: 31, creators: 31 } } });
    store.close();
  });
});

describe("recomputeMetas: the size floor (ticket 05)", () => {
  // The default rule: 5 tokens and 3 distinct creators in the window.
  const run = (store: Datastore, opts: RecomputeOptions = {}) => recomputeWithRule(store, { now: new Date(NOW), ...opts });
  const seedFloor = (store: Datastore) => {
    launchMany(store, 5, (i) => ({ name: "Kept", creator: `k${i % 3}` })); // 5 tokens, 3 creators
    launchMany(store, 4, (i) => ({ name: "FewTokens", creator: `f${i % 3}` })); // 4 tokens, 3 creators
    launchMany(store, 5, (i) => ({ name: "FewCreators", creator: `c${i % 2}` })); // 5 tokens, 2 creators
    launchMany(store, 34, () => ({ name: "OneCreator", creator: "spammer" })); // 34 tokens, 1 creator
  };

  it("keeps 5 tokens from 3 creators and drops 4 tokens, 2 creators and 1 creator", async () => {
    const store = Datastore.open(":memory:");
    seedFloor(store);
    await run(store);
    expect(order(store, "24h")).toEqual(["Kept"]);
    expect(order(store, "6h")).toEqual(["Kept"]);
    expect(rows(store)[0]).toMatchObject({ counts: { "24h": { tokens: 5, creators: 3 } } });
  });

  it("is per window: a group that passes in 24 h but not in 6 h appears in 24 h only", async () => {
    const store = Datastore.open(":memory:");
    launchMany(store, 3, (i) => ({ name: "Fading", creator: `a${i}`, createdMin: 600 + i }));
    launchMany(store, 2, (i) => ({ name: "Fading", creator: `a${i}`, createdMin: 30 + i }));
    await run(store);
    expect(order(store, "24h")).toEqual(["Fading"]);
    expect(order(store, "6h")).toEqual([]);
  });

  it("tests a theme-merged cluster after merging: spellings too small alone count toward the big Meta", async () => {
    const store = Datastore.open(":memory:");
    const who = (prefix: string, i: number) => `${prefix}${"abcdefghijklmnopqrstuvwxyz"[i % 26]}${"abcdefghijklmnopqrstuvwxyz"[Math.floor(i / 26)]}`;
    launchMany(store, 31, (i) => ({ name: "ni hao cat", symbol: "nihao", creator: who("n", i) }));
    launchMany(store, 5, (i) => ({ name: `Ni Hao ${["Noon", "Gang", "Pump", "Moon", "Rich"][i]}`, symbol: `NH${i}`, creator: who("t", i) }));
    await run(store);
    expect(rows(store)).toHaveLength(1);
    expect(rows(store)[0]).toMatchObject({ label: "ni hao cat", counts: { "24h": { tokens: 36, creators: 36 } } });
  });

  it("spends no DexScreener call on a dropped group", async () => {
    const store = Datastore.open(":memory:");
    const tiny = launchMany(store, 4, (i) => ({ name: "Tiny", creator: `t${i % 3}` }));
    launchMany(store, 5, (i) => ({ name: "Real", creator: `r${i % 3}` }));
    const { client, calls } = fakeDex(new Map());
    const result = await run(store, { dex: client });
    expect(calls).toHaveLength(1);
    expect(result.dexCalls).toBe(1);
    for (const mint of tiny) expect(calls[0]).not.toContain(mint);
  });

  it("never lets a below-floor group reach latestMetas, the API response or the prompt lines", async () => {
    const store = Datastore.open(":memory:");
    seedFloor(store);
    await run(store);
    const labels = (store.latestMetas("24h", 50)?.rows ?? []).map((r) => r.label);
    expect(labels).toEqual(["Kept"]);
    const response = metasResponse(store.latestMetas("24h", 50), "24h");
    expect(response.metas.map((m) => m.label)).toEqual(["Kept"]);
    const lines = metaLines(selectMetas(store, new Date(NOW), undefined, 0));
    expect(lines).toHaveLength(1);
    expect(lines.join("\n")).not.toMatch(/FewTokens|FewCreators|OneCreator/);
  });

  it("stores both floors in the run's rule", async () => {
    const path = join(tempDir("meta-rule-"), "argus.db");
    const store = Datastore.open(path);
    launchMany(store, 5, (i) => ({ name: "Kept", creator: `k${i % 3}` }));
    await run(store);
    store.close();
    const db = new DatabaseSync(path, { readOnly: true });
    const rule = JSON.parse((db.prepare("SELECT rule FROM meta_runs").get() as { rule: string }).rule) as Record<string, unknown>;
    db.close();
    expect(rule).toMatchObject({ minTokens: 5, minCreators: 3 });
  });

  it("the env overrides the floor (1 to 1000) and junk keeps the default", () => {
    expect(metaConfigFromEnv({})).toMatchObject({ minTokens: 5, minCreators: 3, coverageMinCreates: 10, coverageNoteBelow: 0.8 });
    expect(metaConfigFromEnv({ ARGUS_META_MIN_TOKENS: "8", ARGUS_META_MIN_CREATORS: "4" })).toMatchObject({ minTokens: 8, minCreators: 4 });
    expect(metaConfigFromEnv({ ARGUS_META_MIN_TOKENS: "0", ARGUS_META_MIN_CREATORS: "1001" })).toMatchObject({ minTokens: 5, minCreators: 3 });
    expect(metaConfigFromEnv({ ARGUS_META_MIN_TOKENS: "five", ARGUS_META_MIN_CREATORS: "-2" })).toMatchObject({ minTokens: 5, minCreators: 3 });
    expect(metaConfigFromEnv({ ARGUS_META_COVERAGE_MIN_CREATES: "50", ARGUS_META_COVERAGE_NOTE_BELOW: "0.5" })).toMatchObject({ coverageMinCreates: 50, coverageNoteBelow: 0.5 });
    expect(metaConfigFromEnv({ ARGUS_META_COVERAGE_NOTE_BELOW: "2" }).coverageNoteBelow).toBe(0.8);
    expect(metaConfigFromEnv({ ARGUS_META_COVERAGE_NOTE_BELOW: "x" }).coverageNoteBelow).toBe(0.8);
  });
});

describe("recomputeMetas: window coverage (ticket 05)", () => {
  it("stores the covered hours of both windows with the run and shows them through latestMetas and the API response", async () => {
    const store = Datastore.open(":memory:");
    // 10 creates in each of three trailing hours (0.5 h, 1.5 h and 7.5 h ago); one stray create 3.5 h ago does not make an hour.
    for (const min of [30, 90, 450]) launchMany(store, 10, (i) => ({ name: `Spread ${min} ${i}`, symbol: `S${min}${i}`, createdMin: min }));
    launch(store, { name: "Stray", createdMin: 210 });
    await recomputeWithRule(store, { now: new Date(NOW) });
    const run = store.latestMetas("24h", 10)!;
    expect(run.coverage).toEqual({ "6h": { covered: 2, of: 6 }, "24h": { covered: 3, of: 24 } });
    expect(metasResponse(run, "24h").coverageNote).toBe("Only 3 h of data in the last 24 h");
    expect(metasResponse(run, "6h").coverageNote).toBe("Only 2 h of data in the last 6 h");
  });

  it("an old run (null columns) has no coverage and no note, and the migration is idempotent on an existing file", async () => {
    const path = join(tempDir("meta-old-"), "argus.db");
    const store = Datastore.open(path);
    await recomputeWithRule(store, { now: new Date(NOW) });
    store.close();
    const db = new DatabaseSync(path);
    db.exec("UPDATE meta_runs SET coverage_hours_6h = NULL, coverage_hours_24h = NULL");
    db.close();
    const again = Datastore.open(path);
    const run = again.latestMetas("24h", 10)!;
    expect(run.coverage).toBeNull();
    expect(metasResponse(run, "24h").coverageNote).toBeNull();
    again.close();
  });
});

describe("recomputeMetas: market-led Metas (ADR 0014, meta-redesign ticket 01)", () => {
  const cfg = { ...META_RULE, minTokens: 2, minCreators: 1 };
  const T = (min: number) => new Date(NOW + min * 60_000);

  /** One `dexscreener:trending` Signal, first seen `ago` minutes before NOW, as the Source writes it (the figure is the one at first sight). */
  function trend(store: Datastore, mint: string, title: string, storedCap?: number, agoMin = 120) {
    store.recordSignals(
      [{ id: `dexscreener:trending:solana:${mint}`, sourceId: "dexscreener:trending", sourceLabel: "DexScreener trending", title, summary: `Boosted on DexScreener.${storedCap !== undefined ? ` market cap $${storedCap.toLocaleString("en-US")}.` : ""}`, url: "", publishedAt: "2026-11-10T10:00:00.000Z" }],
      new Date(NOW - agoMin * 60_000),
    );
  }
  const recompute = (store: Datastore, dex: MetaDexClient | undefined, at: number, over: Partial<typeof cfg> = {}) => recomputeWithRule(store, { now: T(at), dex, config: { ...cfg, ...over } });
  const jensenWave = (store: Datastore, creators = 12) => launchMany(store, creators, (i) => ({ name: "Jensen", creator: `jc${String(i).padStart(3, "0")}` }));

  it("replay of run 143's shape: the Jensen leader at $96k gives no Meta and Watching; at $2M it gives one Meta (a fixture, not the live database)", async () => {
    const lowStore = Datastore.open(":memory:");
    jensenWave(lowStore);
    launchMany(lowStore, 4, (i) => ({ name: "ASTRALIS", creator: `a${i}` }));
    const J = mintOf();
    trend(lowStore, J, "Jensen Huang ($JENSEN)", 96_000);
    trend(lowStore, mintOf(), "Stand with Jensen ($STAND)", 95_000);
    const low = await recompute(lowStore, fakeDex(new Map([[J, 96_000]])).client, 0);
    expect(low).toMatchObject({ metas: 0, watching: 1 });
    expect(lowStore.currentMetas()).toMatchObject({ metas: [], watching: [{ key: "jensen", leader: { mint: J, symbol: "JENSEN", marketCapUsd: 96_000, source: "trending", stale: false }, holding: false, counts: { "24h": { creators: 12 } } }] });

    const highStore = Datastore.open(":memory:");
    jensenWave(highStore);
    const H = mintOf();
    trend(highStore, H, "Jensen Huang ($JENSEN)", 96_000);
    expect(await recompute(highStore, fakeDex(new Map([[H, 2_000_000]])).client, 0)).toMatchObject({ metas: 1, watching: 0 });
    expect(highStore.currentMetas()!.metas[0]).toMatchObject({ key: "jensen", leader: { mint: H, marketCapUsd: 2_000_000 } });
  });

  it("the biggest token of a top launch theme leads it with no trending Signal (the theme lookup the ranking already makes)", async () => {
    const store = Datastore.open(":memory:");
    const mints = jensenWave(store);
    const dex = fakeDex(new Map([[mints[3] as string, 1_500_000]]));
    const r = await recompute(store, dex.client, 0);
    expect(r).toMatchObject({ metas: 1, dexCalls: 1, leaderCalls: 0 });
    expect(store.currentMetas()!.metas[0]).toMatchObject({ key: "jensen", leader: { mint: mints[3], source: "theme", marketCapUsd: 1_500_000 } });
  });

  it("lookups never exceed leaderCalls (30 tokens each), highest stored figure first", async () => {
    const store = Datastore.open(":memory:");
    const all = Array.from({ length: 100 }, (_, i) => {
      const mint = mintOf();
      trend(store, mint, `Token ${i} ($T${i})`, (i + 1) * 1_000);
      return mint;
    });
    const dex = fakeDex(new Map(all.map((m) => [m, 50_000])));
    const r = await recompute(store, dex.client, 0, { leaderCalls: 2 });
    expect(dex.calls).toHaveLength(2);
    expect(r).toMatchObject({ dexCalls: 2, leaderCalls: 2 });
    expect(dex.calls.map((c) => c.length)).toEqual([30, 30]);
    expect(dex.calls[0]![0]).toBe(all[99]);
    expect(new Set(dex.calls.flat())).toEqual(new Set(all.slice(40)));
    expect((await recompute(store, dex.client, 1, { leaderCalls: 0 })).leaderCalls).toBe(0);
    expect(dex.calls).toHaveLength(2);
  });

  it("the previous Metas' and Watching leaders are looked up first, a failed lookup keeps the Meta as it was (stale) and creates none, and a pause drops the state", async () => {
    const store = Datastore.open(":memory:");
    jensenWave(store);
    const J = mintOf();
    trend(store, J, "Jensen Huang ($JENSEN)", 96_000);
    expect(await recompute(store, fakeDex(new Map([[J, 2_000_000]])).client, 0)).toMatchObject({ metas: 1 });

    // 100 louder candidates appear; the budget is one call, and the previous leader still goes first.
    const loud = Array.from({ length: 100 }, (_, i) => {
      const mint = mintOf();
      trend(store, mint, `Loud ${i} ($L${i})`, 10_000_000 + i, 60);
      return mint;
    });
    const dex = fakeDex(new Map([[J, 1_800_000], ...loud.map((m): [string, number] => [m, 5_000_000])]));
    const second = await recompute(store, dex.client, 15, { leaderCalls: 1 });
    expect(dex.calls).toHaveLength(2); // the launch-theme lookup of the Jensen group, then the one leader call
    expect(dex.calls[1]![0]).toBe(J);
    expect(second).toMatchObject({ metas: 1, leaderCalls: 1 });
    expect(store.currentMetas()!.metas[0]).toMatchObject({ key: "jensen", leader: { mint: J, marketCapUsd: 1_800_000, stale: false } });

    // The lookup fails: the Meta stays at its last figure, marked stale; nothing else becomes a Meta.
    const failing = fakeDex(new Map(), { failOn: () => true });
    const third = await recompute(store, failing.client, 30);
    expect(third.metas).toBe(1);
    expect(third.dexFailures).toBeGreaterThan(0);
    expect(failing.calls.length).toBeLessThanOrEqual(1 + cfg.leaderCalls); // the theme lookup plus at most leaderCalls
    expect(store.currentMetas()!.metas.map((m) => [m.key, m.leader.mint, m.leader.marketCapUsd, m.leader.stale])).toEqual([["jensen", J, 1_800_000, true]]);

    // A pause longer than stateMaxMinutes: the stale state is not carried, and a failed lookup alone makes no Meta.
    const fourth = await recompute(store, fakeDex(new Map(), { failOn: () => true }).client, 30 + cfg.stateMaxMinutes + 1);
    expect(fourth).toMatchObject({ metas: 0, watching: 0 });
  });

  it("with no client no Meta is created and none is lost", async () => {
    const store = Datastore.open(":memory:");
    jensenWave(store);
    const J = mintOf();
    trend(store, J, "Jensen Huang ($JENSEN)", 3_000_000);
    expect(await recompute(store, undefined, 0)).toMatchObject({ metas: 0, watching: 0, dexCalls: 0 });
    expect(await recompute(store, fakeDex(new Map([[J, 3_000_000]])).client, 5)).toMatchObject({ metas: 1 });
    expect(await recompute(store, undefined, 10)).toMatchObject({ metas: 1 });
    expect(store.currentMetas()!.metas[0]!.leader).toMatchObject({ mint: J, stale: true });
  });

  it("leaves the launch-theme rows exactly as before, and creates no Narrative, Proposal or Score", async () => {
    const plain = Datastore.open(":memory:");
    const led = Datastore.open(":memory:");
    for (const s of [plain, led]) {
      seq = 100;
      jensenWave(s);
    }
    const J = "J".padEnd(40, "x") + "pump";
    trend(led, J, "Jensen Huang ($JENSEN)", 2_000_000);
    const snapshot = (s: Datastore) => JSON.stringify([s.listNarratives(), s.listProposals(), s.queryNarratives({})]);
    const before = snapshot(led);
    await recompute(plain, undefined, 0);
    await recompute(led, undefined, 0);
    await recompute(led, fakeDex(new Map([[J, 2_000_000]])).client, 1);
    const rowsOf = (s: Datastore, w: "6h" | "24h") => JSON.stringify(s.latestMetas(w, 100)!.rows);
    expect(rowsOf(led, "24h")).toBe(rowsOf(plain, "24h"));
    expect(rowsOf(led, "6h")).toBe(rowsOf(plain, "6h"));
    expect(led.currentMetas()!.metas).toHaveLength(1);
    expect(snapshot(led)).toBe(before);
  });
});
