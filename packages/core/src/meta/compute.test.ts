import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import { DexScreenerClient, type DexPair } from "../sources/dexscreener.ts";
import { tempDir } from "../testing/temp.ts";
import { recomputeMetas as recomputeWithRule, type MetaDexClient, type RecomputeOptions } from "./compute.ts";
import { metasResponse } from "./api.ts";
import { META_RULE, metaConfigFromEnv } from "./config.ts";
import type { GroupAnswer, GroupInput } from "./grouping.ts";
import { metaLines, selectMetas } from "./prompt-block.ts";
import type { TopDownCandidate, TopDownResult } from "./topdown.ts";

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
  /** Minutes before NOW the token graduated (a migrate receipt); wins over `migratedAfterSec`, and can be long after a much older create. */
  graduatedMin?: number;
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
  const graduatedMs = s.graduatedMin !== undefined ? NOW - s.graduatedMin * 60_000 : s.migratedAfterSec !== undefined ? createdMs + s.migratedAfterSec * 1000 : undefined;
  if (graduatedMs !== undefined)
    store.study.recordTokenEvent({ kind: "migrate", mint, receivedAt: new Date(graduatedMs).toISOString(), signature: "", name: "", symbol: "", creator: "", uri: "", pool: "pump-amm" });
  return mint;
}

const launchMany = (store: Datastore, count: number, f: (i: number) => Spec) => Array.from({ length: count }, (_, i) => launch(store, f(i)));

/** A pair that passes the fake-token filter's liquidity and volume tests (a top-down candidate is verified on them), unless `over` says otherwise. */
const pair = (mint: string, marketCapUsd?: number, over: Partial<DexPair> = {}): DexPair => ({
  chainId: "solana", tokenAddress: mint, name: "", symbol: "", url: "", liquidityUsd: 1_000_000, volume24hUsd: 1_000_000, priceChange24hPct: 0, ...(marketCapUsd !== undefined ? { marketCapUsd } : {}), ...over,
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
    launchMany(store, 10, (i) => ({ name: `Other chain ${i}`, pool: "bonk", migratedAfterSec: undefined })); // bonk creates count as copiers of a Meta (ADR 0015), but the base rate stays pump launches only
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

  it("a lookup that succeeds on its retry resets the failure streak (counting fake: each call fails once, then answers)", async () => {
    const store = Datastore.open(":memory:");
    for (let g = 0; g < 8; g++) launchMany(store, 3, (i) => ({ name: `Group${g}`, creator: `g${g}-${i}` }));
    // The client retries inside tokenPairs, so the tick sees only the final outcome: 2 failures, 1 success, repeated, never 3 in a row.
    const flaky = fakeDex(new Map(), { failOn: (n) => n % 3 !== 0 });
    const r = await recomputeMetas(store, { now: new Date(NOW), dex: flaky.client });
    expect(flaky.calls.length).toBe(8);
    expect(r.dexFailures).toBe(6);
  });

  it("replay of the 111 failures: every request fails its first attempt; with retries the run has 0 failures, without them the streak ends the lookups", async () => {
    const store = Datastore.open(":memory:");
    // No token graduates here: three graduations in 6 h would make each theme Watching, and a Watching leader is looked up on the next run (that is not what this test counts).
    for (let g = 0; g < 6; g++) launchMany(store, 3, (i) => ({ name: `Theme${g}`, creator: `t${g}-${i}` }));
    const run = async (retries: number) => {
      const seen = new Set<string>();
      let fetches = 0;
      const fetchText = async (url: string) => {
        fetches++;
        if (!seen.has(url)) {
          seen.add(url);
          throw new TypeError("fetch failed");
        }
        const addresses = url.split("/").pop()!.split(",");
        return JSON.stringify(addresses.map((a) => ({ chainId: "solana", baseToken: { address: a, name: "", symbol: "" }, marketCap: 250_000, liquidity: { usd: 100_000 }, volume: { h24: 100_000 } })));
      };
      const dex = new DexScreenerClient({ fetchText, retries, sleep: async () => {}, log: () => {} });
      const result = await recomputeMetas(store, { now: new Date(NOW), dex });
      return { result, fetches };
    };
    const withRetries = await run(2);
    expect(withRetries.result.dexFailures).toBe(0); // dexFailures with retries: 0
    expect(rows(store).length).toBe(6);
    expect(rows(store).every((r) => r.marketCapUsd !== undefined)).toBe(true);
    const without = await run(0);
    expect(without.result.dexFailures).toBe(3); // the old behaviour: 3 failed calls in a row end the theme lookups
    expect(without.fetches).toBe(3); // one attempt per call, no retry
    expect(rows(store).every((r) => r.marketCapUsd === undefined)).toBe(true);
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

  it("never lets a below-floor group reach latestMetas or the API response, and no group without a leader token worth $1M reaches the prompt lines", async () => {
    const store = Datastore.open(":memory:");
    seedFloor(store);
    await run(store);
    const labels = (store.latestMetas("24h", 50)?.rows ?? []).map((r) => r.label);
    expect(labels).toEqual(["Kept"]);
    const response = metasResponse(store.latestMetas("24h", 50), "24h");
    expect(response.metas.map((m) => m.label)).toEqual(["Kept"]);
    // The prompt block lists Metas and Watching subjects (market-led, ADR 0014), not the launch-theme rows: none of these has a leader.
    expect(metaLines(selectMetas(store, new Date(NOW), undefined, 0))).toEqual([]);
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

// A Meta is several tokens graduating on one narrative (graduation Meta ticket 01): the fixtures below graduate their tokens, and a market cap only
// leads the subject it names (the "leader"), it never makes or ends a Meta. The earlier market-led fixtures (ADR 0014) are kept where they still
// test something (leader lookups, verification, carried state) and changed where the rule moved.
describe("recomputeMetas: the Meta ticks (graduation Meta ticket 01; leaders from ADR 0014 and 0015)", () => {
  const cfg = { ...META_RULE, minTokens: 2, minCreators: 1 };
  const T = (min: number) => new Date(NOW + min * 60_000);

  /**
   * One top-down candidate (the trending lists' answer, after the filter), titled `Name ($SYMBOL)`; `listedCap` is the figure the list gave
   * and only orders the lookups. The leaders of ticket 01 came from stored `dexscreener:trending` Signals; since ADR 0015 they come from here.
   */
  const candidatesOf = new WeakMap<Datastore, TopDownCandidate[]>();
  function trend(store: Datastore, mint: string, title: string, listedCap?: number, _agoMin = 120) {
    const list = candidatesOf.get(store) ?? [];
    candidatesOf.set(store, list);
    const m = /^(.*) \(\$(.*)\)$/.exec(title);
    list.push({ mint, name: m?.[1] ?? title, symbol: m?.[2] ?? "", marketCapUsd: listedCap ?? 1_000, liquidityUsd: 500_000, volume24hUsd: 500_000, sources: ["jupiter"], ranks: { jupiter: list.length + 1 } });
  }
  const topDownOf = (store: Datastore) => async (): Promise<TopDownResult> => ({ candidates: candidatesOf.get(store) ?? [], dropped: [], requests: 0, errors: [] });
  const recompute = (store: Datastore, dex: MetaDexClient | undefined, at: number, over: Partial<typeof cfg> = {}) => recomputeWithRule(store, { now: T(at), dex, topDown: topDownOf(store), config: { ...cfg, ...over } });
  /** 12 creators launch "Jensen" 30 minutes before NOW and each token graduates five minutes later: 12 graduations from 12 creators, all in the last 6 h. */
  const jensenWave = (store: Datastore, creators = 12) => launchMany(store, creators, (i) => ({ name: "Jensen", creator: `jc${String(i).padStart(3, "0")}`, migratedAfterSec: 300 }));

  it("a recording gap that ended inside the window gives each subject its graduations since the gap ended (ticket 04); no gap, an open gap or a blip gives none", async () => {
    const run = async (gap?: { downMin: number; upMin?: number }) => {
      const store = Datastore.open(":memory:");
      jensenWave(store); // 12 graduations, 25 minutes before NOW
      const J = mintOf();
      trend(store, J, "Jensen Huang ($JENSEN)", 96_000);
      if (gap) {
        store.study.recordConnection({ state: "down", at: T(-gap.downMin).toISOString() });
        if (gap.upMin !== undefined) store.study.recordConnection({ state: "up", at: T(-gap.upMin).toISOString() });
      }
      await recompute(store, fakeDex(new Map([[J, 96_000]])).client, 0);
      return store.currentMetas()!.metas[0]!.grads;
    };
    expect((await run({ downMin: 120, upMin: 27 }))?.sinceGap).toBe(12); // ended before the graduations
    expect((await run({ downMin: 120, upMin: 20 }))?.sinceGap).toBe(0); // ended after them
    expect((await run())?.sinceGap).toBeUndefined();
    expect((await run({ downMin: 120 }))?.sinceGap).toBeUndefined(); // still open: nothing has ended
    expect((await run({ downMin: 32, upMin: 30 }))?.sinceGap).toBeUndefined(); // a 2-minute blip
  });

  it("replay of run 143's shape: the Jensen wave is a Meta at a $96k leader and at a $2M one, and with only 6 graduations it is Watching (a fixture, not the live database)", async () => {
    const lowStore = Datastore.open(":memory:");
    jensenWave(lowStore);
    launchMany(lowStore, 4, (i) => ({ name: "ASTRALIS", creator: `a${i}` }));
    const J = mintOf();
    trend(lowStore, J, "Jensen Huang ($JENSEN)", 96_000);
    trend(lowStore, mintOf(), "Stand with Jensen ($STAND)", 95_000);
    const low = await recompute(lowStore, fakeDex(new Map([[J, 96_000]])).client, 0);
    expect(low).toMatchObject({ metas: 1, watching: 0 }); // $96k was Watching under the market-led rule: market cap no longer decides
    expect(lowStore.currentMetas()).toMatchObject({ metas: [{ key: "jensen", leader: { mint: J, symbol: "JENSEN", marketCapUsd: 96_000, source: "trending", stale: false }, holding: false, counts: { "24h": { creators: 12 } }, grads: { "24h": 12, "6h": 12, creators24h: 12 } }], watching: [] });

    const highStore = Datastore.open(":memory:");
    jensenWave(highStore);
    const H = mintOf();
    trend(highStore, H, "Jensen Huang ($JENSEN)", 96_000);
    expect(await recompute(highStore, fakeDex(new Map([[H, 2_000_000]])).client, 0)).toMatchObject({ metas: 1, watching: 0 });
    expect(highStore.currentMetas()!.metas[0]).toMatchObject({ key: "jensen", leader: { mint: H, marketCapUsd: 2_000_000 } });

    // the same wave with 6 graduations (the rest never graduated) is Watching, at any cap
    const sixStore = Datastore.open(":memory:");
    launchMany(sixStore, 12, (i) => ({ name: "Jensen", creator: `jc${String(i).padStart(3, "0")}`, migratedAfterSec: i < 6 ? 300 : undefined }));
    expect(await recompute(sixStore, fakeDex(new Map()).client, 0)).toMatchObject({ metas: 0, watching: 1 });
  });

  it("the biggest token of a top launch theme leads it with no trending Signal (the theme lookup the ranking already makes)", async () => {
    const store = Datastore.open(":memory:");
    const mints = jensenWave(store);
    const dex = fakeDex(new Map([[mints[3] as string, 1_500_000]]));
    const r = await recompute(store, dex.client, 0);
    expect(r).toMatchObject({ metas: 1, dexCalls: 1, leaderCalls: 0 });
    expect(store.currentMetas()!.metas[0]).toMatchObject({ key: "jensen", leader: { mint: mints[3], source: "theme", marketCapUsd: 1_500_000 } });
  });

  it("a theme-lookup token keeps the fake-cap test: one at 124x its liquidity is no leader, one within 100x is (the $50k floors do not apply to it)", async () => {
    const answer = (fake: string, real: string): MetaDexClient => ({
      async tokenPairs(_chain, addresses) {
        return addresses.flatMap((a) => (a === fake ? [pair(a, 76_900_000, { liquidityUsd: 618_000 })] : a === real ? [pair(a, 1_500_000, { liquidityUsd: 400_000 })] : []));
      },
    });
    const store = Datastore.open(":memory:");
    const mints = jensenWave(store);
    const [fake, real] = [mints[3] as string, mints[5] as string];
    await recompute(store, answer(fake, real), 0);
    expect(store.currentMetas()!.metas[0]).toMatchObject({ key: "jensen", leader: { mint: real, source: "theme", marketCapUsd: 1_500_000 } });
    // with only the fake answered, the subject is still a Meta (its graduations make it one) but has no priced leader: its latest graduate leads, the cap a dash
    const only = Datastore.open(":memory:");
    const fakeOnly = jensenWave(only)[3] as string;
    expect(await recompute(only, answer(fakeOnly, "none"), 0)).toMatchObject({ metas: 1 });
    expect(only.currentMetas()!.metas[0]!.leader).toMatchObject({ marketCapUsd: 0, source: "theme", stale: false });
    expect(only.currentMetas()!.metas[0]!.leader.mint).not.toBe(fakeOnly);
  });

  it("theme-token pricing needs no $50k floors: a pair with $2k of liquidity and $300 of volume prices a graduate, and a pair with no liquidity figure at all still does", async () => {
    const store = Datastore.open(":memory:");
    const [a, b] = jensenWave(store) as [string, string];
    const thin: MetaDexClient = { async tokenPairs(_c, addresses) { return addresses.flatMap((x) => (x === a ? [pair(x, 120_000, { liquidityUsd: 2_000, volume24hUsd: 300 })] : x === b ? [pair(x, 90_000, { liquidityUsd: 0, volume24hUsd: 0 })] : [])); } };
    await recompute(store, thin, 0);
    expect(store.currentMetas()!.metas[0]!.leader).toMatchObject({ mint: a, marketCapUsd: 120_000, source: "theme" }); // 60x its liquidity: under the 100x line
    expect(store.currentMetas()!.metas[0]!.topTokens.filter((t) => t.marketCapUsd !== undefined).map((t) => [t.mint, t.marketCapUsd])).toEqual([[a, 120_000], [b, 90_000]]);
    // the same pair at 124x is still refused: the fake-cap test stays
    const fake = Datastore.open(":memory:");
    const [f] = jensenWave(fake) as [string];
    await recompute(fake, { async tokenPairs(_c, addresses) { return addresses.includes(f) ? [pair(f, 248_000, { liquidityUsd: 2_000, volume24hUsd: 300 })] : []; } }, 0);
    expect(fake.currentMetas()!.metas[0]!.leader).toMatchObject({ marketCapUsd: 0 });
  });

  it("the theme lookup asks for a group's newest graduates, not its oldest 30", async () => {
    const store = Datastore.open(":memory:");
    // 40 graduates of one theme: token i graduated (40 - i) minutes before NOW, created 3 hours before it, so the earliest creates are the oldest graduates
    const mints = launchMany(store, 40, (i) => ({ name: "Santa", creator: `s${String(i).padStart(3, "0")}`, createdMin: 180 - i, graduatedMin: 40 - i }));
    const { client, calls } = fakeDex(new Map());
    await recompute(store, client, 0);
    expect(calls).toHaveLength(1);
    expect(new Set(calls[0])).toEqual(new Set(mints.slice(10))); // the newest 30 graduated: tokens 10 to 39
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

    // A pause longer than stateMaxMinutes: the stale state is not carried. The graduations still make it a Meta, but a new one (new entry time), and with no
    // figure to carry its latest graduate leads and the cap is a dash.
    const fourth = await recompute(store, fakeDex(new Map(), { failOn: () => true }).client, 30 + cfg.stateMaxMinutes + 1);
    expect(fourth).toMatchObject({ metas: 1, watching: 0 });
    expect(store.currentMetas()!.metas[0]).toMatchObject({ key: "jensen", enteredAt: T(30 + cfg.stateMaxMinutes + 1).toISOString(), leader: { marketCapUsd: 0, stale: false } });
  });

  it("a stale figure ends stateMaxMinutes after it was last read, though every run re-saves it (persistent failure, and leaderCalls 0): the Meta stays, on its latest graduate", async () => {
    for (const mode of ["failing", "off"] as const) {
      const store = Datastore.open(":memory:");
      jensenWave(store);
      const J = mintOf();
      trend(store, J, "Jensen Huang ($JENSEN)", 3_000_000);
      expect(await recompute(store, fakeDex(new Map([[J, 3_000_000]])).client, 0)).toMatchObject({ metas: 1 });
      const seen: number[] = [];
      for (let at = 15; at <= 150; at += 15) {
        const dex = mode === "failing" ? fakeDex(new Map(), { failOn: () => true }).client : fakeDex(new Map()).client;
        seen.push((await recompute(store, dex, at, mode === "off" ? { leaderCalls: 0 } : {})).metas);
        if (at === 120) expect(store.currentMetas()!.metas[0]!.leader).toMatchObject({ marketCapUsd: 3_000_000, stale: true, freshAt: T(0).toISOString() });
        if (at === 135) expect(store.currentMetas()!.metas[0]!.leader).toMatchObject({ marketCapUsd: 0, stale: false }); // the figure is 135 minutes old: dropped, a dash
        expect(store.currentMetas()!.metas[0]!.enteredAt).toBe(T(0).toISOString()); // the Meta itself never ended: its graduations hold it
      }
      expect(seen, mode).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    }
  });

  it("with no client the Meta still stands on its graduations with a dash; a price later leads it, and losing the lookup keeps the figure (stale)", async () => {
    const store = Datastore.open(":memory:");
    jensenWave(store);
    const J = mintOf();
    trend(store, J, "Jensen Huang ($JENSEN)", 3_000_000);
    expect(await recompute(store, undefined, 0)).toMatchObject({ metas: 1, watching: 0, dexCalls: 0 });
    expect(store.currentMetas()!.metas[0]!.leader).toMatchObject({ marketCapUsd: 0 });
    expect(await recompute(store, fakeDex(new Map([[J, 3_000_000]])).client, 5)).toMatchObject({ metas: 1 });
    expect(store.currentMetas()!.metas[0]!.leader).toMatchObject({ mint: J, marketCapUsd: 3_000_000, stale: false });
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

  describe("top-down leaders (ADR 0015, meta-redesign ticket 05)", () => {
    const logged = () => {
      const lines: string[] = [];
      return { lines, log: (m: string) => void lines.push(m) };
    };
    const run = (store: Datastore, dex: MetaDexClient | undefined, at: number, extra: Partial<RecomputeOptions> = {}) => recomputeWithRule(store, { now: T(at), dex, topDown: topDownOf(store), config: cfg, ...extra });

    it("no leader from an unverified token: one DexScreener cannot answer, or answers with $20 of volume, is not a leader (the Meta shows a dash); one within the filter at $7.05M is", async () => {
      const store = Datastore.open(":memory:");
      jensenWave(store);
      const [silent, thin, real] = [mintOf(), mintOf(), mintOf()];
      trend(store, silent, "Jensen Huang ($JENSEN)", 9_000_000);
      trend(store, thin, "Jensen Thin ($JTHIN)", 8_000_000);
      const dex: MetaDexClient = {
        async tokenPairs(_chain, addresses) {
          return addresses.flatMap((a) => (a === thin ? [pair(a, 8_000_000, { volume24hUsd: 20 })] : a === real ? [pair(a, 7_050_000)] : []));
        },
      };
      const first = logged();
      expect(await run(store, dex, 0, { log: first.log })).toMatchObject({ metas: 1, watching: 0 });
      expect(first.lines).toContain("[meta] leader JTHIN failed verification: 24 h volume $20 under $50,000");
      expect(store.currentMetas()!.metas[0]!.leader).toMatchObject({ marketCapUsd: 0, source: "theme" }); // neither trending token leads: the wave's latest graduate does, no price
      const stored = store.meta.candidates(store.meta.current()!.runId);
      expect(stored.find((c) => c.mint === silent)).toMatchObject({ verified: false, reason: "failed verification: no DexScreener pair" });
      expect(stored.find((c) => c.mint === thin)).toMatchObject({ verified: false });

      trend(store, real, "Jensen Real ($JENSEN)", 7_050_000);
      expect(await run(store, dex, 1)).toMatchObject({ metas: 1 });
      expect(store.currentMetas()!.metas[0]).toMatchObject({ key: "jensen", leader: { mint: real, symbol: "JENSEN", marketCapUsd: 7_050_000, source: "trending", stale: false } });
      expect(store.meta.candidates(store.meta.current()!.runId).find((c) => c.mint === real)).toMatchObject({ verified: true });
    });

    it("the leader's cap is the deepest pair's, not the largest pair's: a thin $12M pair beside a $7M deep one gives $7M", async () => {
      const store = Datastore.open(":memory:");
      jensenWave(store);
      const J = mintOf();
      trend(store, J, "Jensen Huang ($JENSEN)", 7_000_000);
      const dex: MetaDexClient = { async tokenPairs(_chain, addresses) { return addresses.includes(J) ? [pair(J, 12_000_000, { liquidityUsd: 1_000, volume24hUsd: 500 }), pair(J, 7_000_000, { liquidityUsd: 300_000, volume24hUsd: 400_000 })] : []; } };
      await run(store, dex, 0);
      expect(store.currentMetas()!.metas[0]!.leader).toMatchObject({ mint: J, marketCapUsd: 7_000_000 });
      // and a thin deepest pair cannot make a leader on its own, whatever its cap
      const thin = Datastore.open(":memory:");
      jensenWave(thin);
      const F = mintOf();
      trend(thin, F, "Jensen Huang ($JENSEN)", 7_000_000);
      const thinDex: MetaDexClient = { async tokenPairs() { return [pair(F, 5_000_000, { liquidityUsd: 20_000, volume24hUsd: 900_000 })]; } };
      expect(await run(thin, thinDex, 0)).toMatchObject({ metas: 1 });
      expect(thin.currentMetas()!.metas[0]!.leader.marketCapUsd).toBe(0);
    });

    it("the list's liquidity counts in the cap-to-liquidity test only for a Jupiter organic score of 50 or more: GTA VI (73) passes; a low score, or no score, is judged on DexScreener alone", async () => {
      const GTA_MINT = "4kjruqGHDsSqkMdFfCjV7Vb62HPFhtXyWc2t6JpQzDnz";
      const lists = (liquidityUsd: number, organicScore?: number, name = "GTA VI") => async (): Promise<TopDownResult> => ({ candidates: [{ mint: GTA_MINT, name, symbol: "GTA6", marketCapUsd: 7_300_000, liquidityUsd, volume24hUsd: 1_085_000, sources: ["jupiter", "geckoterminal"], ranks: { jupiter: 15, geckoterminal: 9 }, ...(organicScore !== undefined ? { organicScore } : {}) }], dropped: [], requests: 4, errors: [] });
      const dex: MetaDexClient = { async tokenPairs() { return [pair(GTA_MINT, 7_670_054, { liquidityUsd: 62_331, volume24hUsd: 746_088 })]; } };
      const fresh = () => {
        const s = Datastore.open(":memory:");
        launchMany(s, 12, (i) => ({ name: "GTA VI", symbol: "GTA6", creator: `g${String(i).padStart(3, "0")}`, migratedAfterSec: 300 }));
        return s;
      };
      const real = fresh();
      expect(await run(real, dex, 0, { topDown: lists(271_000, 73) })).toMatchObject({ metas: 1 });
      expect(real.currentMetas()!.metas[0]!.leader).toMatchObject({ mint: GTA_MINT, marketCapUsd: 7_670_054, source: "trending" });
      // the fake: inflated list liquidity, low score
      // (the wave's 12 graduations make a Meta in every case; what changes is whether the GTA VI token leads it)
      const leaderOf = (s: Datastore) => s.currentMetas()!.metas[0]!.leader;
      const low = logged();
      const lowStore = fresh();
      expect(await run(lowStore, dex, 0, { topDown: lists(48_300_000, 12), log: low.log })).toMatchObject({ metas: 1 });
      expect(leaderOf(lowStore)).toMatchObject({ marketCapUsd: 0, source: "theme" });
      expect(low.lines).toEqual(["[meta] leader GTA6 failed verification: cap 123x liquidity (over 100x)"]);
      // no score (GeckoTerminal only): DexScreener's liquidity alone
      const none = logged();
      const noneStore = fresh();
      expect(await run(noneStore, dex, 0, { topDown: lists(48_300_000), log: none.log })).toMatchObject({ metas: 1 });
      expect(leaderOf(noneStore).mint).not.toBe(GTA_MINT);
      expect(none.lines).toEqual(low.lines);
      // the knob moves the line
      const strict = fresh();
      expect(await run(strict, dex, 0, { topDown: lists(271_000, 73), config: { ...cfg, topDownMinOrganicScore: 80 } })).toMatchObject({ metas: 1 });
      expect(leaderOf(strict).mint).not.toBe(GTA_MINT);
    });

    it("GTAVI (2026-11-17): its only DexScreener pair is unpriced, so the list's GeckoTerminal figures verify it, and a failure is logged once across ticks", async () => {
      const mint = "ERiM8NiCanarGEnWMnURAoxTuTvUXZbtJsPTirnHpump";
      const unpricedPair = (): DexPair[] => [{ chainId: "solana", tokenAddress: mint, name: "GTA VI", symbol: "GTAVI", url: "", liquidityUsd: 0, volume24hUsd: 0, priceChange24hPct: 0, unpriced: true }];
      const dex: MetaDexClient = { async tokenPairs() { return unpricedPair(); } };
      const lists = (withFigures: boolean) => async (): Promise<TopDownResult> => ({
        candidates: [{ mint, name: "GTA VI", symbol: "GTAVI", marketCapUsd: 260_000, liquidityUsd: withFigures ? 56_600 : 0, volume24hUsd: 1_100_000, sources: ["geckoterminal"], ranks: { geckoterminal: 3 } }],
        dropped: [], requests: 1, errors: [],
      });
      const fresh = () => {
        const s = Datastore.open(":memory:");
        launchMany(s, 12, (i) => ({ name: "GTA VI", symbol: "GTAVI", creator: `g${String(i).padStart(3, "0")}`, migratedAfterSec: 300 }));
        return s;
      };
      const ok = fresh();
      await run(ok, dex, 0, { topDown: lists(true) });
      expect(ok.currentMetas()!.metas[0]!.leader).toMatchObject({ mint, marketCapUsd: 260_000, stale: false }); // $260K: priced, and leads its Meta
      // no usable list liquidity: one reason, logged on the first tick only
      const log = logged();
      const store = fresh();
      for (const at of [0, 5, 10]) await run(store, dex, at, { topDown: lists(false), log: log.log });
      expect(log.lines).toEqual(["[meta] leader GTAVI failed verification: no priced DexScreener pair"]);
    });

    it("a creator's newline or control character in a token name never reaches a log line", async () => {
      const store = Datastore.open(":memory:");
      jensenWave(store);
      const candidate: TopDownCandidate = { mint: mintOf(), name: "Jensen\nHuang", symbol: "JEN\r\nSEN\u0007\u001b[2J", marketCapUsd: 3_000_000, liquidityUsd: 500_000, volume24hUsd: 500_000, sources: ["jupiter"], ranks: { jupiter: 1 } };
      const log = logged();
      await run(store, { async tokenPairs() { return []; } }, 0, { topDown: async () => ({ candidates: [candidate], dropped: [], requests: 0, errors: [] }), log: log.log });
      expect(log.lines).toEqual(["[meta] leader JEN SEN[2J failed verification: no DexScreener pair"]);
      expect(log.lines[0]).not.toMatch(/[\u0000-\u001f]/);
    });

    it("a previous Meta's leader is looked up first and passes the same filter (Q16): with no volume it is no longer fresh, only carried at its last figure", async () => {
      const store = Datastore.open(":memory:");
      jensenWave(store);
      const J = mintOf();
      trend(store, J, "Jensen Huang ($JENSEN)", 7_000_000);
      expect(await run(store, fakeDex(new Map([[J, 7_000_000]])).client, 0)).toMatchObject({ metas: 1 });
      // The next tick DexScreener shows J with no volume at all: its new figure is refused, the held Meta keeps the last one (stale).
      const log = logged();
      const dex: MetaDexClient = { async tokenPairs(_c, a) { return a.includes(J) ? [pair(J, 6_000_000, { liquidityUsd: 100, volume24hUsd: 0 })] : []; } };
      const second = await run(store, dex, 15, { log: log.log });
      expect(second).toMatchObject({ metas: 1 });
      expect(store.currentMetas()!.metas[0]!.leader).toMatchObject({ mint: J, marketCapUsd: 7_000_000, stale: true });
      expect(log.lines.some((l) => l.includes("failed verification"))).toBe(true);
    });

    it("a previous leader that is trending again keeps the list's liquidity credit: a credited one (score 73) stays fresh on tick two, an uncredited one over 100x is carried stale", async () => {
      const GTA_MINT = "4kjruqGHDsSqkMdFfCjV7Vb62HPFhtXyWc2t6JpQzDnz";
      const lists = (organicScore: number) => async (): Promise<TopDownResult> => ({ candidates: [{ mint: GTA_MINT, name: "GTA VI", symbol: "GTA6", marketCapUsd: 7_300_000, liquidityUsd: 271_000, volume24hUsd: 1_085_000, sources: ["jupiter"], ranks: { jupiter: 15 }, organicScore }], dropped: [], requests: 1, errors: [] });
      const deep: MetaDexClient = { async tokenPairs() { return [pair(GTA_MINT, 7_670_054)]; } };
      const thin: MetaDexClient = { async tokenPairs() { return [pair(GTA_MINT, 7_670_054, { liquidityUsd: 62_331, volume24hUsd: 746_088 })]; } };
      const twoTicks = async (organicScore: number) => {
        const s = Datastore.open(":memory:");
        launchMany(s, 12, (i) => ({ name: "GTA VI", symbol: "GTA6", creator: `g${String(i).padStart(3, "0")}`, migratedAfterSec: 300 }));
        await run(s, deep, 0, { topDown: lists(organicScore) });
        await run(s, thin, 15, { topDown: lists(organicScore) });
        return s.currentMetas()!.metas[0]!.leader;
      };
      expect(await twoTicks(73)).toMatchObject({ mint: GTA_MINT, marketCapUsd: 7_670_054, stale: false });
      expect(await twoTicks(12)).toMatchObject({ mint: GTA_MINT, stale: true });
    });

    it("looks up previous leaders first, then candidates by the lists' market cap, highest first, within leaderCalls (100 candidates, 2 calls: exactly 2 calls of 30)", async () => {
      const store = Datastore.open(":memory:");
      const all = Array.from({ length: 100 }, (_, i) => {
        const mint = mintOf();
        trend(store, mint, `Token ${i} ($T${i})`, (i + 1) * 1_000);
        return mint;
      });
      const dex = fakeDex(new Map(all.map((m) => [m, 50_000])));
      const r = await run(store, dex.client, 0, { config: { ...cfg, leaderCalls: 2 } });
      expect(dex.calls.map((c) => c.length)).toEqual([30, 30]);
      expect(r).toMatchObject({ dexCalls: 2, leaderCalls: 2 });
      expect(dex.calls[0]).toEqual([...all].reverse().slice(0, 30)); // highest listed cap first
      expect(dex.calls[1]).toEqual([...all].reverse().slice(30, 60));
      const stored = store.meta.candidates(r.runId);
      expect(stored.filter((c) => c.verified === null).map((c) => c.reason)).toEqual(Array(40).fill("not looked up: leader call budget used"));
    });

    it("the top-down read is optional and never fatal: a failure, a timeout or partial errors are logged once and the previous Meta stays", async () => {
      const store = Datastore.open(":memory:");
      jensenWave(store);
      const J = mintOf();
      trend(store, J, "Jensen Huang ($JENSEN)", 3_000_000);
      expect(await run(store, fakeDex(new Map([[J, 3_000_000]])).client, 0)).toMatchObject({ metas: 1 });

      const down = logged();
      const failed = await run(store, fakeDex(new Map([[J, 2_900_000]])).client, 15, { topDown: async () => { throw new Error("both lists down"); }, log: down.log });
      expect(down.lines.filter((l) => l.startsWith("[meta] top-down sources failed"))).toEqual(["[meta] top-down sources failed: both lists down"]);
      expect(failed).toMatchObject({ metas: 1, topDown: { requests: 0, kept: 0, dropped: 0, errors: [] } });
      expect(store.currentMetas()!.metas[0]!.leader).toMatchObject({ mint: J, marketCapUsd: 2_900_000, stale: false }); // the previous leader's lookup still ran

      const slow = logged();
      const timedOut = await run(store, fakeDex(new Map([[J, 2_800_000]])).client, 30, { topDown: () => new Promise<TopDownResult>(() => {}), topDownTimeoutMs: 25, log: slow.log });
      expect(slow.lines).toEqual(["[meta] top-down sources failed: timed out after 25 ms"]);
      expect(timedOut).toMatchObject({ metas: 1 });

      const partial = logged();
      const some = await run(store, fakeDex(new Map([[J, 2_700_000]])).client, 45, { topDown: async () => ({ candidates: [], dropped: [], requests: 3, errors: ["jupiter: Jupiter: response is not JSON", "geckoterminal page 2: boom"] }), log: partial.log });
      expect(partial.lines).toEqual(["[meta] top-down sources failed: jupiter: Jupiter: response is not JSON; geckoterminal page 2: boom"]);
      expect(some.topDown).toMatchObject({ requests: 3, errors: ["jupiter: Jupiter: response is not JSON", "geckoterminal page 2: boom"] });
      expect(some.metas).toBe(1);
    });

    it("with neither dex nor topDown the tick still works, and the launch themes and the themes' lookups are as before", async () => {
      const store = Datastore.open(":memory:");
      const mints = jensenWave(store);
      expect(await recomputeWithRule(store, { now: T(0), config: cfg })).toMatchObject({ metas: 1, dexCalls: 0, topDown: { requests: 0, kept: 0, dropped: 0, errors: [] } }); // the graduations alone make the Meta
      // The theme lookup alone prices its leader (no top-down read involved).
      expect(await recomputeWithRule(store, { now: T(1), dex: fakeDex(new Map([[mints[2] as string, 2_000_000]])).client, config: cfg })).toMatchObject({ metas: 1 });
      expect(store.currentMetas()!.metas[0]!.leader).toMatchObject({ mint: mints[2], marketCapUsd: 2_000_000, source: "theme" });
    });

    it("stores every candidate it read, kept and dropped, with the reason, and prunes them with the run", async () => {
      const store = Datastore.open(":memory:");
      jensenWave(store);
      const [a, b, c, d] = [mintOf(), mintOf(), mintOf(), mintOf()];
      const kept = (mint: string, name: string, cap: number): TopDownCandidate => ({ mint, name, symbol: name.toUpperCase(), marketCapUsd: cap, liquidityUsd: 500_000, volume24hUsd: 600_000, sources: ["jupiter", "geckoterminal"], ranks: { jupiter: 3, geckoterminal: 7 } });
      const topDown = async (): Promise<TopDownResult> => ({
        candidates: [kept(a, "Jensen", 7_000_000), kept(b, "Jensen Fail", 6_000_000), kept(c, "Unanswered", 5_000_000)],
        dropped: [{ mint: d, name: "GTA VI", symbol: "GTA6", marketCapUsd: 12_070_000_000, liquidityUsd: 48_300_000, volume24hUsd: 2.28, sources: ["jupiter"], ranks: { jupiter: 4 }, reason: "fake: cap 250x liquidity (over 100x)" }],
        requests: 4,
        errors: [],
      });
      const dex: MetaDexClient = { async tokenPairs(_c, addresses) { return addresses.flatMap((x) => (x === a ? [pair(a, 7_000_000)] : x === b ? [pair(b, 6_000_000, { volume24hUsd: 1 })] : [])); } };
      const r = await run(store, dex, 0, { topDown });
      expect(r.topDown).toEqual({ requests: 4, kept: 3, dropped: 1, errors: [] });
      expect(store.meta.candidates(r.runId)).toEqual([
        { mint: a, name: "Jensen", symbol: "JENSEN", marketCapUsd: 7_000_000, liquidityUsd: 500_000, volume24hUsd: 600_000, sources: ["jupiter", "geckoterminal"], ranks: { jupiter: 3, geckoterminal: 7 }, verified: true },
        { mint: b, name: "Jensen Fail", symbol: "JENSEN FAIL", marketCapUsd: 6_000_000, liquidityUsd: 500_000, volume24hUsd: 600_000, sources: ["jupiter", "geckoterminal"], ranks: { jupiter: 3, geckoterminal: 7 }, verified: false, reason: "failed verification: 24 h volume $1 under $50,000" },
        { mint: c, name: "Unanswered", symbol: "UNANSWERED", marketCapUsd: 5_000_000, liquidityUsd: 500_000, volume24hUsd: 600_000, sources: ["jupiter", "geckoterminal"], ranks: { jupiter: 3, geckoterminal: 7 }, verified: false, reason: "failed verification: no DexScreener pair" },
        { mint: d, name: "GTA VI", symbol: "GTA6", marketCapUsd: 12_070_000_000, liquidityUsd: 48_300_000, volume24hUsd: 2.28, sources: ["jupiter"], ranks: { jupiter: 4 }, verified: null, reason: "fake: cap 250x liquidity (over 100x)" },
      ]);
      // retention: a run 15 days later deletes the first run and its candidates
      const later = await recomputeWithRule(store, { now: new Date(NOW + 15 * 24 * 3_600_000), config: cfg, topDown: async () => ({ candidates: [], dropped: [], requests: 0, errors: [] }) });
      expect(store.meta.candidates(r.runId)).toEqual([]);
      expect(store.meta.candidates(later.runId)).toEqual([]);
    });

    it("the Meta tick leaves no Narrative, Proposal or Score behind (a top-down read changes none)", async () => {
      const store = Datastore.open(":memory:");
      jensenWave(store);
      const J = mintOf();
      trend(store, J, "Jensen Huang ($JENSEN)", 3_000_000);
      const snapshot = () => JSON.stringify([store.listNarratives(), store.listProposals(), store.queryNarratives({})]);
      const before = snapshot();
      await run(store, fakeDex(new Map([[J, 3_000_000]])).client, 0);
      expect(snapshot()).toBe(before);
    });
  });

  describe("bonk launches are copiers in the stored counts only, never graduations (ADR 0015 decision 3; graduation Meta ticket 01)", () => {
    const wave = (store: Datastore, pump: number, bonk: number, name = "Jensen", graduate = true) => {
      launchMany(store, pump, (i) => ({ name, creator: `p${String(i).padStart(3, "0")}`, ...(graduate ? { migratedAfterSec: 300 } : {}) }));
      launchMany(store, bonk, (i) => ({ name, creator: `b${String(i).padStart(3, "0")}`, pool: "bonk", ...(graduate ? { migratedAfterSec: 300 } : {}) }));
    };
    const withLeader = async (store: Datastore) => {
      const J = mintOf();
      trend(store, J, "Jensen Huang ($JENSEN)", 3_000_000);
      return recompute(store, fakeDex(new Map([[J, 3_000_000]])).client, 0);
    };

    it("bonk creates add copiers to a Meta's stored counts but never a graduation: 12 pump graduations are a Meta whose counts show 17 creators; 6 pump and 5 bonk graduates are not", async () => {
      const yes = Datastore.open(":memory:");
      wave(yes, 12, 5);
      expect(await withLeader(yes)).toMatchObject({ metas: 1 });
      expect(yes.currentMetas()!.metas[0]).toMatchObject({ key: "jensen", counts: { "24h": { creators: 17, tokens: 17 } }, grads: { "24h": 12, creators24h: 12 } }); // the stored counts include the bonk creators, the graduations do not

      const no = Datastore.open(":memory:");
      wave(no, 6, 5);
      expect(await withLeader(no)).toMatchObject({ metas: 0, watching: 1 }); // 6 pump graduations, whatever bonk migrate rows say
      expect(no.currentMetas()!.watching[0]).toMatchObject({ grads: { "24h": 6 } });
    });

    it("the launch-theme rows, base rate, size floor and coverage are identical with and without bonk creates in the store", async () => {
      const plain = Datastore.open(":memory:");
      const mixed = Datastore.open(":memory:");
      for (const s of [plain, mixed]) {
        seq = 500;
        wave(s, 6, 0);
        launchMany(s, 4, (i) => ({ name: "Other", creator: `o${i}` }));
      }
      // bonk creates that name the Jensen group, one that names no group, and a pile that would pass the size floor alone
      launchMany(mixed, 5, (i) => ({ name: "Jensen", creator: `bb${i}`, pool: "bonk" }));
      launchMany(mixed, 12, (i) => ({ name: "Bonk Only", creator: `bo${i}`, pool: "bonk" }));
      for (const s of [plain, mixed]) await recompute(s, undefined, 0);
      const whole = (s: Datastore, w: "6h" | "24h") => JSON.stringify(s.latestMetas(w, 100));
      expect(whole(mixed, "24h")).toBe(whole(plain, "24h"));
      expect(whole(mixed, "6h")).toBe(whole(plain, "6h"));
      expect(mixed.latestMetas("24h", 100)!.rows.map((r) => r.label)).not.toContain("Bonk Only");
    });

    it("a bonk token joins the group that holds one of its name or ticker keys; one whose keys point at two groups, or at none, joins neither", async () => {
      const store = Datastore.open(":memory:");
      launchMany(store, 10, (i) => ({ name: "Alphaone", symbol: "ALPHAONE", creator: `a${i}`, migratedAfterSec: 300 }));
      launchMany(store, 3, (i) => ({ name: "Betatwo", symbol: "BETATWO", creator: `c${i}` }));
      launchMany(store, 2, (i) => ({ name: "Something else", symbol: "ALPHAONE", creator: `e${i}`, pool: "bonk" })); // its ticker key is Alphaone's: joins
      launchMany(store, 2, (i) => ({ name: "Alphaone", symbol: "BETATWO", creator: `f${i}`, pool: "bonk" })); // two keys, two groups: joins neither
      launchMany(store, 2, (i) => ({ name: "Gammathree", symbol: "GAMMA", creator: `g${i}`, pool: "bonk" })); // no group at all
      const A = mintOf();
      trend(store, A, "Alphaone ($ALPHAONE)", 3_000_000);
      await recompute(store, fakeDex(new Map([[A, 3_000_000]])).client, 0);
      const m = store.currentMetas()!.metas.find((x) => x.key === "alphaone")!;
      expect(m.counts["24h"]).toMatchObject({ creators: 12, tokens: 12 }); // 10 pump creators and the 2 bonk creators of the first kind
    });
  });
});

describe("recomputeMetas: graduation Metas (graduation Meta ticket 01)", () => {
  const cfg = { ...META_RULE, minTokens: 2, minCreators: 1 };
  const T = (min: number) => new Date(NOW + min * 60_000);
  const recompute = (store: Datastore, at = 0, extra: Partial<RecomputeOptions> = {}) => recomputeWithRule(store, { now: T(at), config: cfg, ...extra });
  const metas = (store: Datastore) => store.currentMetas()!.metas;
  const watching = (store: Datastore) => store.currentMetas()!.watching;
  /** `count` graduates of one name, one creator each (or `creators` distinct ones), created 3 hours before NOW; graduation times come from `at(i)` in minutes before NOW. */
  const wave = (store: Datastore, name: string, count: number, at: (i: number) => number, creators = count) =>
    launchMany(store, count, (i) => ({ name, creator: `${name}-c${i % creators}`, createdMin: 180, graduatedMin: at(i) }));

  it("10 graduations from 10 creators with 3 in the last 6 h and no priced token is a Meta, the latest graduate leading with the cap a dash", async () => {
    const store = Datastore.open(":memory:");
    const mints = wave(store, "Santa", 10, (i) => (i < 3 ? 30 : 400 + i * 60)); // 3 in the last hour, 7 spread over the rest of the day
    await recompute(store, 0);
    expect(metas(store)).toHaveLength(1);
    expect(metas(store)[0]).toMatchObject({ key: "santa", holding: false, grads: { "24h": 10, "6h": 3, creators24h: 10 }, leader: { mint: mints[0], marketCapUsd: 0, source: "theme", stale: false } });
    expect(watching(store)).toEqual([]);
  });

  it("9 graduations make it Watching, not a Meta; 10 by one creator are not a Meta either; 10 with only 2 in the last 6 h are not", async () => {
    const nine = Datastore.open(":memory:");
    wave(nine, "Santa", 9, (i) => 30 + i);
    await recompute(nine);
    expect([metas(nine).length, watching(nine).map((w) => w.key)]).toEqual([0, ["santa"]]);

    const oneCreator = Datastore.open(":memory:");
    wave(oneCreator, "Santa", 10, (i) => 30 + i, 1);
    await recompute(oneCreator);
    expect([metas(oneCreator).length, watching(oneCreator).length]).toEqual([0, 1]);

    const fewCreators = Datastore.open(":memory:");
    wave(fewCreators, "Santa", 10, (i) => 30 + i, 5);
    await recompute(fewCreators);
    expect(metas(fewCreators)).toHaveLength(0);

    const stale = Datastore.open(":memory:");
    wave(stale, "Santa", 10, (i) => (i < 2 ? 30 : 600 + i)); // 2 in 6 h
    await recompute(stale);
    expect([metas(stale).length, watching(stale).length]).toEqual([0, 1]);
  });

  it("a Meta stays at 5 graduations and drops at 4, and its state is carried for stateMaxMinutes", async () => {
    const store = Datastore.open(":memory:");
    // 3 recent graduations and 7 older ones (24 h, 23 h, ... before NOW): as the ticks move on the old ones leave the 24 h window one by one
    wave(store, "Santa", 10, (i) => (i < 3 ? 30 + i : 1440 - 60 * (i - 3)));
    const seen: Array<[number, number, boolean]> = [];
    let watchingAt315: Array<[string, number]> = [];
    for (let at = 0; at <= 315; at += 15) {
      await recompute(store, at);
      if (at === 315) watchingAt315 = watching(store).map((w) => [w.key, w.grads!["24h"]]);
      const m = metas(store)[0];
      if (m) expect(m.enteredAt).toBe(T(0).toISOString()); // one Meta from the first run to the last
      seen.push([at, m?.grads?.["24h"] ?? -1, m?.holding ?? false]);
    }
    const countsAt = (at: number) => seen.find((s) => s[0] === at)!;
    expect(countsAt(0)).toEqual([0, 10, false]); // enters at 10
    expect(countsAt(255)).toEqual([255, 5, true]); // stays at 5, holding, with its entry time
    expect(seen.filter(([, , h]) => h).every(([at]) => at > 0)).toBe(true);
    expect(countsAt(315)[1]).toBe(-1); // drops at 4: no Meta (3 in the last 6 h keep it Watching)
    expect(watchingAt315).toEqual([["santa", 4]]);

    // state is carried for stateMaxMinutes: the Meta at 10 graduations that no longer meets a stricter enter rule stays within 120 minutes and is not carried after 121
    const strict = { ...cfg, metaMinGrads: 11, metaStayGrads: 5 };
    const carried = Datastore.open(":memory:");
    wave(carried, "Santa", 10, (i) => 30 + i);
    await recompute(carried, 0);
    await recompute(carried, cfg.stateMaxMinutes, { config: strict });
    expect(metas(carried)[0]).toMatchObject({ key: "santa", holding: true, enteredAt: T(0).toISOString() });
    const paused = Datastore.open(":memory:");
    wave(paused, "Santa", 10, (i) => 30 + i);
    await recompute(paused, 0);
    await recompute(paused, cfg.stateMaxMinutes + 1, { config: strict });
    expect(metas(paused)).toEqual([]);
    expect(watching(paused)).toHaveLength(1);
  });

  it("the Christmas fixture: eleven themes, ten graduates from ten creators (three in the last 6 h) give one Meta 'Christmas' with 10 in 24 h, 3 in 6 h and 10 creators", async () => {
    const store = Datastore.open(":memory:");
    const themes = ["santa", "snowball", "xmas", "grinch", "goonmas", "christmas", "bullmas", "holdmas", "pepemas", "catemas", "fomomas"];
    // Each theme has creates in the window (so it is a launch theme): three creators each, the graduates among them or created long ago
    const make = (name: string, symbol: string, creator: string, createdMin: number, graduatedMin: number) => launch(store, { name, symbol, creator, createdMin, graduatedMin });
    for (const t of themes) for (let i = 0; i < 3; i++) launch(store, { name: t, symbol: t.toUpperCase(), creator: `${t}-fan-${i}`, createdMin: 400 + i });
    // six graduates whose create is in the window (they join their theme by mint), 3 of them in the last 6 h
    make("Bullmas", "BULLMAS", "c01", 500, 100);
    make("snowball", "SNOWBALL", "c02", 500, 200);
    make("ChristmASS", "XMAS", "c03", 600, 300);
    make("CATEMAS", "CATEMAS", "c04", 700, 700);
    make("pepesanta", "PEPEMAS", "c05", 700, 800);
    make("Snowball", "SNOWB", "c06", 800, 900);
    // four late graduates of old creates (created two days ago): matched by the forms of their names
    make("Santa Inu", "SINU", "c07", 3000, 1000);
    make("snowball-v2", "SNOWBALL", "c08", 3000, 1100); // the hyphen drops out of the key (`snowballv2`), so its ticker is what names the subject
    make("Saint Nicholas SANTA", "SANTA", "c09", 3000, 1200);
    make("Christmas Inu", "CHRINU", "c10", 3000, 1300);
    // a group token that is not a graduate and a bonk graduation do not count
    launch(store, { name: "Santa Hat", symbol: "HAT", creator: "c11", createdMin: 100 });
    launch(store, { name: "Santa Bonk", symbol: "BONKSANTA", creator: "c12", createdMin: 100, graduatedMin: 50, pool: "bonk" });
    const group = async (input: GroupInput): Promise<GroupAnswer> => ({
      subjects: [{ name: "Christmas", items: input.items.filter((i) => i.kind === "theme" && themes.includes(i.key)).map((i) => i.id) }],
      inputHash: input.inputHash, computedAt: input.now.toISOString(), reused: false, costUsd: 0, brainRunId: null,
    });
    const r = await recompute(store, 0, { group });
    expect(r.group).toMatchObject({ source: "ai", subjects: 1 });
    expect(metas(store)).toHaveLength(1);
    expect(metas(store)[0]).toMatchObject({ label: "Christmas", namedBy: "ai", grads: { "24h": 10, "6h": 3, creators24h: 10 } });
    expect(metas(store)[0]!.themes!.map((t) => t.key).sort()).toEqual([...themes].sort());
    expect(watching(store)).toEqual([]);
  });

  it("a late graduate of an old create is counted, a bonk graduation is not", async () => {
    const store = Datastore.open(":memory:");
    launchMany(store, 9, (i) => ({ name: "Santa", creator: `s${i}`, createdMin: 120, graduatedMin: 30 + i }));
    expect(await recompute(store, 0)).toMatchObject({ metas: 0 });
    launch(store, { name: "Santa", creator: "late", createdMin: 5 * 24 * 60, graduatedMin: 20 }); // created five days ago, graduated now
    launch(store, { name: "Santa", creator: "bonker", createdMin: 120, graduatedMin: 10, pool: "bonk" });
    await recompute(store, 1);
    expect(metas(store)[0]).toMatchObject({ key: "santa", grads: { "24h": 10, creators24h: 10 } });
  });

  it("at most 3 Metas, ranked by graduations in 24 h", async () => {
    const store = Datastore.open(":memory:");
    wave(store, "Alpha", 14, (i) => 30 + i);
    wave(store, "Bravo", 12, (i) => 30 + i);
    wave(store, "Charlie", 11, (i) => 30 + i);
    wave(store, "Delta", 10, (i) => 30 + i);
    await recompute(store, 0);
    expect(metas(store).map((m) => m.key)).toEqual(["alpha", "bravo", "charlie"]);
    expect(watching(store).map((m) => m.key)).toEqual(["delta"]);
  });

  it("a trending-list token no longer creates a Meta: it appears only as the leader inside its subject", async () => {
    const store = Datastore.open(":memory:");
    wave(store, "Santa", 12, (i) => 30 + i);
    launchMany(store, 12, (i) => ({ name: "Quiet", creator: `q${i}` })); // a crowd of creates, no graduations
    const big = mintOf();
    const hot = mintOf();
    const topDown = async (): Promise<TopDownResult> => ({
      candidates: [
        { mint: big, name: "Santa Claus", symbol: "SANTA", marketCapUsd: 30_000_000, liquidityUsd: 900_000, volume24hUsd: 900_000, sources: ["jupiter"], ranks: { jupiter: 1 } },
        { mint: hot, name: "Quiet Hot", symbol: "QUIET", marketCapUsd: 40_000_000, liquidityUsd: 900_000, volume24hUsd: 900_000, sources: ["jupiter"], ranks: { jupiter: 2 } },
      ],
      dropped: [], requests: 1, errors: [],
    });
    const dex: MetaDexClient = { async tokenPairs(_c, addresses) { return addresses.flatMap((a) => (a === big ? [pair(a, 30_000_000)] : a === hot ? [pair(a, 40_000_000)] : [])); } };
    await recompute(store, 0, { dex, topDown });
    expect(metas(store).map((m) => m.key)).toEqual(["santa"]); // Quiet has the trending token at $40M and the creates, but no graduations
    expect(metas(store)[0]!.leader).toMatchObject({ mint: big, marketCapUsd: 30_000_000, source: "trending" });
    expect(watching(store)).toEqual([]);
  });

  it("a thin window still qualifies and carries the coverage flag; a well-covered one carries none", async () => {
    const thin = Datastore.open(":memory:");
    wave(thin, "Santa", 10, (i) => 30 + i);
    await recompute(thin);
    expect(metas(thin)).toHaveLength(1);
    expect(metas(thin)[0]!.grads!.coverage).toEqual({ covered: 1, of: 24 }); // one hour of the day had enough creates to count

    const covered = Datastore.open(":memory:");
    wave(covered, "Santa", 10, (i) => 30 + i);
    for (let h = 0; h < 24; h++) launchMany(covered, 10, (i) => ({ name: `Filler ${h} ${i}`, symbol: `F${h}X${i}`, createdMin: h * 60 + 5 }));
    await recompute(covered);
    expect(metas(covered)[0]!.grads).not.toHaveProperty("coverage");
  });

  it("the graduation counts are stored in the counts JSON and read back through currentMetas, and the run's rule carries the six knobs", async () => {
    const path = join(tempDir("meta-grads-"), "argus.db");
    const store = Datastore.open(path);
    wave(store, "Santa", 10, (i) => 30 + i);
    await recompute(store);
    store.close();
    const db = new DatabaseSync(path, { readOnly: true });
    const counts = JSON.parse((db.prepare("SELECT counts FROM meta_current WHERE kind = 'meta'").get() as { counts: string }).counts) as Record<string, unknown>;
    const rule = JSON.parse((db.prepare("SELECT rule FROM meta_runs").get() as { rule: string }).rule) as Record<string, unknown>;
    db.close();
    expect(counts).toMatchObject({ grads: { "24h": 10, "6h": 10, creators24h: 10 }, "24h": { tokens: 10 } });
    expect(rule).toMatchObject({ metaMinGrads: 10, metaStayGrads: 5, metaMinCreators: 6, metaLiveGrads6h: 3, watchMinGrads: 5, watchGrads6h: 3 });
  });
});
