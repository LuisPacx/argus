import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import { FakeChain, TEST_KEY, fakeCreateTx, fakeMint, fakeNotCreateTx, fakeSignature, type FakeFailure } from "../testing/fake-chain.ts";
import type { PumpTokenEvent } from "../sources/pumpportal.ts";
import type { ChainCreatesConfig } from "./chain-config.ts";
import { drawSample, dueSampleDays, runChainCreates, seededRandom, type ChainCreatesDeps } from "./chain-creates.ts";
import { SIGNATURES_VERB, TXS_FOR_ADDRESS_VERB, TX_VERB, type ParsedTransaction } from "./helius.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const DAY = "2026-11-18";
const DAY_START = Date.parse(`${DAY}T00:00:00Z`) / 1000;
const NOW = new Date("2026-11-19T00:10:00Z");

const config = (extra: Partial<ChainCreatesConfig> = {}): ChainCreatesConfig => ({
  apiKey: TEST_KEY,
  chainCreatesDailyCreditCap: 25_000,
  chainCreatesSampleSize: 100,
  requestsPerSecond: 8,
  ...extra,
});

function setup(opts: { config?: Partial<ChainCreatesConfig>; now?: Date; seed?: number; listing?: boolean; priorDrawn?: boolean } = {}) {
  const store = Datastore.open(":memory:");
  const chain = new FakeChain();
  if (opts.priorDrawn !== false) {
    // the day before yesterday was drawn long ago, so only yesterday is owed (a day with nothing listed is asked for again at the next run)
    store.chain.saveDraw({ day: "2026-11-17", runId: 0, seed: 1, listed: 1, sampleSize: 1, signatures: ["prior"], now: NOW });
    store.chain.closeSample("2026-11-17", "prior", "skipped", "", "set up by the test");
  }
  let t = 0;
  const logs: string[] = [];
  let now = opts.now ?? NOW;
  const deps = (extra: Partial<ChainCreatesDeps> = {}): ChainCreatesDeps => ({
    chain: store.chain,
    config: config(opts.config),
    now: () => now,
    log: (l) => logs.push(l),
    fetch: chain.fetch,
    limiterClock: { now: () => t, sleep: async (ms) => void (t += ms) },
    seed: () => opts.seed ?? 12345,
    // `listing: false` holds the daily listing off, for tests of the migrated job alone
    state: opts.listing === false ? { listingHoldUntil: Number.MAX_SAFE_INTEGER } : undefined,
    ...extra,
  });
  return { store, chain, logs, deps, at: (d: Date) => void (now = d) };
}

const pp = (kind: "create" | "migrate", n: number, extra: Partial<PumpTokenEvent> = {}): PumpTokenEvent => ({
  kind,
  mint: fakeMint(n),
  receivedAt: "2026-11-17T10:00:00.000Z",
  signature: "",
  name: kind === "create" ? `PP name ${n}` : "",
  symbol: kind === "create" ? `PP${n}` : "",
  creator: kind === "create" ? "Creator".padEnd(44, "1") : "",
  uri: kind === "create" ? `https://ipfs.io/ipfs/pp${n}` : "",
  pool: kind === "create" ? "pump" : "pump-amm",
  ...extra,
});

/**
 * Fills the fake node's address with, newest first: `today` creates from the current UTC day (listed past, not sampled), `count` creates of
 * DAY (ids 1..count), `older` creates of the day before. Extra non-creates and failures can be mixed into DAY.
 */
function populate(chain: FakeChain, o: { count: number; today?: number; older?: number; failedEvery?: number; poolEvery?: number }) {
  let id = 1_000_000;
  for (let i = 0; i < (o.today ?? 0); i++) chain.addToAddress(fakeCreateTx({ n: id++, blockTime: DAY_START + 86_400 + 600 - i }));
  for (let i = 0; i < o.count; i++) {
    const n = i + 1;
    const blockTime = DAY_START + 86_399 - Math.floor((i * 86_000) / o.count);
    if (o.poolEvery && n % o.poolEvery === 0) chain.addToAddress(fakeNotCreateTx(n, blockTime));
    else if (o.failedEvery && n % o.failedEvery === 0) chain.addToAddress(fakeCreateTx({ n, blockTime, failed: true }), false);
    else chain.addToAddress(fakeCreateTx({ n, blockTime, wrapper: n % 7 === 0 ? "CreateCoinAndBuyBondingCurveV3" : undefined, mayhem: n % 5 === 0 }));
  }
  for (let i = 0; i < (o.older ?? 0); i++) chain.addToAddress(fakeCreateTx({ n: 2_000_000 + i, blockTime: DAY_START - 600 - i }));
}

describe("the seeded draw", () => {
  it("is repeatable from its seed and takes distinct items", () => {
    const items = Array.from({ length: 1000 }, (_, i) => `s${i}`);
    const a = drawSample(items, 50, 99);
    expect(drawSample(items, 50, 99)).toEqual(a);
    expect(drawSample(items, 50, 100)).not.toEqual(a);
    expect(new Set(a).size).toBe(50);
    expect(drawSample(items, 5000, 1)).toHaveLength(1000);
    expect(drawSample(items, 0, 1)).toEqual([]);
  });

  it("gives every item the same chance: each of 20 items is drawn about 1/4 of the time over many seeds", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const hits = Array.from({ length: 20 }, () => 0);
    const runs = 4000;
    for (let seed = 1; seed <= runs; seed++) for (const i of drawSample(items, 5, seed)) hits[i]!++;
    for (const h of hits) expect(Math.abs(h / runs - 0.25)).toBeLessThan(0.04);
    const r = seededRandom(7);
    expect(Array.from({ length: 3 }, () => r())).toEqual(Array.from({ length: 3 }, ((r2) => () => r2())(seededRandom(7))));
  });
});

describe("the daily sample", () => {
  it("lists the previous UTC day with pagination, drops failed transactions, samples at random and stores each row with its day and weight", async () => {
    const { store, chain, deps } = setup({ config: { chainCreatesSampleSize: 200 } });
    populate(chain, { count: 2300, today: 40, older: 30, failedEvery: 10 }); // 230 failed, 2070 successful creates
    const r = await runChainCreates(deps());
    expect(r.stoppedBy).toBe("");
    expect(r.sample.days).toEqual([{ day: DAY, listed: 2070, drawn: 200, weight: 2070 / 200, seed: 12345 }]);
    // pages: 40 of today and the day's 2300 and some of the day before: 1000 each, stops at the page that reaches the day before
    expect(chain.count(SIGNATURES_VERB)).toBe(3);
    expect(chain.count(TX_VERB)).toBe(200);
    expect(r.sample).toMatchObject({ read: 200, stored: 200, skipped: 0 });
    const rows = store.study.chainSampleRows(DAY);
    expect(rows).toHaveLength(200);
    for (const row of rows) {
      expect(row).toMatchObject({ source: "chain_sample", status: "chain", sampleDay: DAY, sampleWeight: 10.35, pool: "pump" });
      expect(row.createdAt! >= `${DAY}T00:00:00.000Z` && row.createdAt! < "2026-11-19T00:00:00.000Z").toBe(true);
    }
    // the weights stand for the whole day
    expect(rows.reduce((sum, row) => sum + row.sampleWeight!, 0)).toBeCloseTo(2070, 6);
    // a failed transaction was never read, the seed and counts are recorded with the day
    expect(store.chain.getDay(DAY)).toMatchObject({ seed: 12345, listed: 2070, sampleSize: 200, drawn: 200, weight: 10.35, stored: 200, skipped: 0 });
  });

  it("takes everything at weight 1 when the day has fewer creates than the sample size", async () => {
    const { store, chain, deps } = setup({ config: { chainCreatesSampleSize: 500 } });
    populate(chain, { count: 120, today: 5, older: 5 });
    const r = await runChainCreates(deps());
    expect(r.sample.days[0]).toMatchObject({ listed: 120, drawn: 120, weight: 1 });
    const rows = store.study.chainSampleRows(DAY);
    expect(rows).toHaveLength(120);
    expect(rows.every((x) => x.sampleWeight === 1)).toBe(true);
  });

  it("draws from all creates, not only unmigrated ones: the sampled share of migrated mints matches the population share", async () => {
    const { store, chain, deps } = setup({ config: { chainCreatesSampleSize: 600 }, seed: 424242 });
    populate(chain, { count: 6000 });
    // 8% of the day's mints migrated, and they are the NEWEST ones in the list: an order-biased draw would show it
    const migratedCount = 480;
    for (let n = 1; n <= migratedCount; n++) store.study.recordTokenEvent(pp("migrate", n));
    await runChainCreates(deps());
    const rows = store.study.chainSampleRows(DAY);
    expect(rows).toHaveLength(600);
    const migratedInSample = rows.filter((x) => x.migratedAt !== null).length;
    const population = migratedCount / 6000;
    const sampled = migratedInSample / 600;
    // three standard deviations of a 600-draw share at 8% is about 3.3 points; fixed seed, so this is repeatable
    expect(Math.abs(sampled - population)).toBeLessThan(0.034);
    // the weights sum back to the listed total, and the weighted migrated count estimates the population's
    expect(rows.reduce((s, x) => s + x.sampleWeight!, 0)).toBeCloseTo(6000, 6);
    const weighted = rows.filter((x) => x.migratedAt !== null).reduce((s, x) => s + x.sampleWeight!, 0);
    expect(Math.abs(weighted - migratedCount)).toBeLessThan(0.034 * 6000);
    // the job never asked the Study which mints migrated: the listing and the draw see signatures only
    expect(chain.count(SIGNATURES_VERB)).toBeGreaterThan(0);
  });

  it("a transaction that is not a create is skipped and not stored; weights and the listed total still count it", async () => {
    const { store, chain, deps } = setup({ config: { chainCreatesSampleSize: 1000 } });
    populate(chain, { count: 100, poolEvery: 4 }); // 25 pool creations, 75 creates, all listed and all drawn
    const r = await runChainCreates(deps());
    expect(r.sample.days[0]).toMatchObject({ listed: 100, drawn: 100, weight: 1 });
    expect(r.sample).toMatchObject({ read: 100, stored: 75, skipped: 25 });
    expect(store.study.chainSampleRows(DAY)).toHaveLength(75);
    expect(store.chain.getDay(DAY)).toMatchObject({ stored: 75, skipped: 25 });
  });

  it("stores a mint reached by both paths once, keeping PumpPortal's data and recording both sources; coverage is stored per day", async () => {
    const { store, chain, deps } = setup({ config: { chainCreatesSampleSize: 1000 } });
    populate(chain, { count: 40 });
    for (let n = 1; n <= 10; n++) store.study.recordTokenEvent(pp("create", n)); // PumpPortal delivered 10 of the 40
    const r = await runChainCreates(deps());
    expect(r.sample.coverage[DAY]).toBe(10 / 40);
    expect(store.chain.getDay(DAY)).toMatchObject({ stored: 40, pumpportalSeen: 10, coverage: 0.25 });
    const both = store.study.getToken(fakeMint(3))!;
    expect(both).toMatchObject({ source: "pumpportal", alsoSources: "chain_sample", name: "PP name 3", creator: "Creator".padEnd(44, "1"), uri: "https://ipfs.io/ipfs/pp3", status: "pending", sampleDay: DAY, sampleWeight: 1, mayhem: false });
    expect(store.study.getToken(fakeMint(5))).toMatchObject({ mayhem: true }); // flag filled from chain where PumpPortal had none
    expect(store.study.getToken(fakeMint(30))).toMatchObject({ source: "chain_sample", alsoSources: "", status: "chain" });
    expect(store.study.chainSampleRows(DAY)).toHaveLength(40); // one row per mint
  });

  it("a row from a path other than PumpPortal is never due for a Snapshot and is outside the base rate and the Meta ranking", async () => {
    const { store, chain, deps } = setup({ config: { chainCreatesSampleSize: 1000 } });
    populate(chain, { count: 20 });
    await runChainCreates(deps());
    expect(store.study.dueTokens(new Date("2026-11-30T00:00:00Z"), 100)).toEqual([]);
    expect(store.study.stats(new Date("2026-11-30T00:00:00Z")).seen).toBe(0);
    expect(store.study.createdBetween("2026-11-01T00:00:00Z", "2026-11-30T00:00:00Z")).toEqual([]);
    expect(() => store.study.recordSnapshot({ mint: fakeMint(3), description: "", imageUrl: null, websiteUrl: null, xUrl: null, telegramUrl: null, selectionReason: "x", website: null }, new Date("2026-11-18T12:01:00Z"))).toThrow();
  });

  it("draws a day once: a second run the same day lists nothing and reads nothing", async () => {
    const { chain, deps } = setup({ config: { chainCreatesSampleSize: 50 } });
    populate(chain, { count: 300 });
    await runChainCreates(deps());
    const calls = chain.calls.length;
    const r = await runChainCreates(deps());
    expect(chain.calls.length).toBe(calls);
    expect(r.sample.days).toEqual([]);
  });

  it("lists nothing it can sample when the day is empty and stores no draw", async () => {
    const { store, chain, deps } = setup();
    populate(chain, { count: 0, today: 10, older: 10 });
    const r = await runChainCreates(deps());
    expect(r.sample.days).toEqual([]);
    expect(store.chain.getDay(DAY)).toBeUndefined();
  });

  it("owes yesterday and the day before, newest first, minus the days already drawn", () => {
    const { store } = setup({ priorDrawn: false });
    expect(dueSampleDays(store.chain, NOW)).toEqual(["2026-11-18", "2026-11-17"]);
    store.chain.saveDraw({ day: "2026-11-18", runId: 1, seed: 1, listed: 5, sampleSize: 5, signatures: [fakeSignature(1)], now: NOW });
    expect(dueSampleDays(store.chain, NOW)).toEqual(["2026-11-17"]);
  });
});

describe("migrated creates", () => {
  const recorded = (file: string) => (JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as { result: { data: ParsedTransaction[] } }).result.data[0]!;

  it("finds a migrated mint's create with one history call and fills the create fields and the uri PumpPortal never delivered", async () => {
    const { store, chain, deps } = setup({ listing: false });
    const tx = recorded("helius-history-earliest.json");
    const mint = "AcPBreW4cbKxxNHv5vhkMarWYinTbir4Ud2rw19Mpump";
    chain.earliestByMint.set(mint, tx);
    store.study.recordTokenEvent({ ...pp("migrate", 1), mint });
    expect(store.study.getToken(mint)).toMatchObject({ status: "missed", name: "", uri: "", createdAt: null, source: "pumpportal" });
    const r = await runChainCreates(deps({ chain: store.chain }));
    expect(r.migrated).toMatchObject({ candidates: 1, filled: 1, notCreate: 0, retry: 0 });
    expect(chain.calls.map((c) => c.verb)).toEqual([TXS_FOR_ADDRESS_VERB]);
    expect(chain.calls[0]!.params).toMatchObject({ sortOrder: "asc", limit: 1, filters: { status: "succeeded" } });
    const row = store.study.getToken(mint)!;
    expect(row).toMatchObject({ status: "missed", source: "chain_migrated", alsoSources: "pumpportal", pool: "pump", sampleDay: null });
    expect(row.name).not.toBe("");
    expect(row.uri).toMatch(/^https?:\/\//);
    expect(row.creator).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(row.createdAt).toBe(new Date(tx.blockTime! * 1000).toISOString());
    expect(row.migratedAt).not.toBeNull();
    // it is looked up once: the next run has nothing to do
    await runChainCreates(deps());
    expect(chain.count(TXS_FOR_ADDRESS_VERB)).toBe(1);
  });

  it("does not touch a mint PumpPortal delivered whole, and fills only the empty field of one it delivered partly", async () => {
    const { store, chain, deps } = setup({ listing: false });
    // whole: create and migration both seen
    store.study.recordTokenEvent(pp("create", 1));
    store.study.recordTokenEvent(pp("migrate", 1));
    // partial: the create came without a uri
    store.study.recordTokenEvent(pp("create", 2, { uri: "" }));
    store.study.recordTokenEvent(pp("migrate", 2));
    chain.earliestByMint.set(fakeMint(1), fakeCreateTx({ n: 1, blockTime: 1_700_000_000, name: "Chain name" }));
    chain.earliestByMint.set(fakeMint(2), fakeCreateTx({ n: 2, blockTime: 1_700_000_000, name: "Chain name 2", uri: "https://ipfs.io/ipfs/from-chain" }));
    const whole = JSON.stringify(store.study.getToken(fakeMint(1)));
    const r = await runChainCreates(deps());
    expect(r.migrated.candidates).toBe(1); // only the partial one is a candidate
    expect(chain.calls.map((c) => c.address)).toEqual([fakeMint(2)]);
    expect(JSON.stringify(store.study.getToken(fakeMint(1)))).toBe(whole);
    expect(store.study.getToken(fakeMint(2))).toMatchObject({
      name: "PP name 2", // PumpPortal's value is kept
      uri: "https://ipfs.io/ipfs/from-chain", // the empty one is filled
      creator: "Creator".padEnd(44, "1"),
      createdAt: "2026-11-17T10:00:00.000Z", // PumpPortal's event time, not the chain's
      source: "pumpportal",
      alsoSources: "chain_migrated",
    });
  });

  it("skips a mint whose earliest transaction is not a create, stores nothing for it and does not look it up again", async () => {
    const { store, chain, deps } = setup({ listing: false });
    store.study.recordTokenEvent(pp("migrate", 1));
    chain.earliestByMint.set(fakeMint(1), fakeNotCreateTx(1, 1_700_000_000));
    const r = await runChainCreates(deps());
    expect(r.migrated).toMatchObject({ filled: 0, notCreate: 1 });
    expect(store.study.getToken(fakeMint(1))).toMatchObject({ name: "", createdAt: null, source: "pumpportal", status: "missed" });
    await runChainCreates(deps());
    expect(chain.count(TXS_FOR_ADDRESS_VERB)).toBe(1);
  });

  it("a create of another mint at the front of the history is not stored under this one", async () => {
    const { store, chain, deps } = setup({ listing: false });
    store.study.recordTokenEvent(pp("migrate", 1));
    chain.earliestByMint.set(fakeMint(1), fakeCreateTx({ n: 2, blockTime: 1_700_000_000 }));
    const r = await runChainCreates(deps());
    expect(r.migrated.notCreate).toBe(1);
    expect(store.study.getToken(fakeMint(1))).toMatchObject({ name: "", createdAt: null });
    expect(store.study.getToken(fakeMint(2))).toBeUndefined();
  });

  it("handles every create shape: legacy, v2 direct and both wrapper-paired creates, with the mayhem and cashback flags", async () => {
    const { store, chain, deps } = setup({ listing: false });
    const shapes = [
      { n: 1, spec: { version: "legacy" as const } },
      { n: 2, spec: {} },
      { n: 3, spec: { wrapper: "CreateCoinAndBuyBondingCurveV3" as const } },
      { n: 4, spec: { wrapper: "CreateCoinAndBuyJupiterBondingCurve" as const } },
      { n: 5, spec: { mayhem: true } },
      { n: 6, spec: { cashback: true } },
    ];
    for (const s of shapes) {
      store.study.recordTokenEvent(pp("migrate", s.n));
      chain.earliestByMint.set(fakeMint(s.n), fakeCreateTx({ n: s.n, blockTime: 1_700_000_000 + s.n, ...s.spec }));
    }
    const r = await runChainCreates(deps());
    expect(r.migrated.filled).toBe(6);
    for (const s of shapes) expect(store.study.getToken(fakeMint(s.n)), `shape ${s.n}`).toMatchObject({ source: "chain_migrated", name: `Token ${s.n}`, uri: `https://ipfs.io/ipfs/meta${s.n}`, pool: "pump" });
    expect(store.study.getToken(fakeMint(5))).toMatchObject({ mayhem: true, cashback: false });
    expect(store.study.getToken(fakeMint(6))).toMatchObject({ mayhem: false, cashback: true });
  });

  it("cleans the chain's text the way PumpPortal's is cleaned", async () => {
    const { store, chain, deps } = setup({ listing: false });
    store.study.recordTokenEvent(pp("migrate", 1));
    chain.earliestByMint.set(fakeMint(1), fakeCreateTx({ n: 1, blockTime: 1_700_000_000, name: "<b>Bold</b> ".padEnd(300, "x"), symbol: "<i>S</i>", uri: "javascript:alert(1)" }));
    await runChainCreates(deps());
    const row = store.study.getToken(fakeMint(1))!;
    expect(row.name.length).toBeLessThanOrEqual(100);
    expect(row.name.startsWith("Bold")).toBe(true);
    expect(row.symbol).toBe("S");
    expect(row.uri).toBe("");
  });
});

describe("the daily credit cap", () => {
  it("stops cleanly when reached, leaves nothing half-written, and the unfetched work is done the next day", async () => {
    const { store, chain, deps, at } = setup({ config: { chainCreatesDailyCreditCap: 40, chainCreatesSampleSize: 100 } });
    populate(chain, { count: 300 }); // one listing page (1 credit) and a draw of 100
    for (let n = 1; n <= 5; n++) {
      store.study.recordTokenEvent({ ...pp("migrate", 2000 + n) });
      chain.earliestByMint.set(fakeMint(2000 + n), fakeCreateTx({ n: 2000 + n, blockTime: 1_700_000_000 }));
    }
    const first = await runChainCreates(deps());
    // 1 listing + 39 reads reach the cap of 40; the migrated mints (10 each) do not get in
    expect(first.stoppedBy).toBe("credit cap");
    expect(first.credits.spentToday).toBe(40);
    expect(store.chain.creditsOnDay("2026-11-19")).toBeLessThanOrEqual(40);
    expect(first.sample).toMatchObject({ read: 39, stored: 39 });
    expect(store.chain.pendingSampleCount()).toBe(61);
    expect(store.study.chainSampleRows(DAY)).toHaveLength(39);
    expect(store.study.getToken(fakeMint(2001))).toMatchObject({ name: "", createdAt: null }); // untouched
    // the same day again: the cap still holds
    const again = await runChainCreates(deps());
    expect(again.credits.spentToday).toBe(40);
    expect(again.sample.read).toBe(0);
    // the next UTC day: the rest of the draw is read (the draw is kept, not replaced), then the migrated mints
    at(new Date("2026-11-20T00:10:00Z"));
    chain.signatures = []; // nothing new to list for the day that is now yesterday
    const next = await runChainCreates(deps({ config: config({ chainCreatesDailyCreditCap: 25_000 }) }));
    expect(next.stoppedBy).toBe("");
    expect(next.sample.read).toBe(61);
    expect(store.study.chainSampleRows(DAY)).toHaveLength(100);
    expect(next.migrated.filled).toBe(5);
    expect(store.chain.getDay(DAY)).toMatchObject({ drawn: 100, stored: 100 });
  });

  it("a listing the cap cuts short stores no draw at all, and the day is tried again", async () => {
    const { store, chain, deps, at } = setup({ config: { chainCreatesDailyCreditCap: 2 } });
    populate(chain, { count: 3000 }); // three pages
    const r = await runChainCreates(deps());
    expect(r.stoppedBy).toBe("credit cap");
    expect(store.chain.dayDrawn(DAY)).toBe(false);
    expect(store.chain.pendingSampleCount()).toBe(0);
    expect(store.study.chainSampleRows(DAY)).toEqual([]);
    at(new Date("2026-11-19T01:00:00Z"));
    const later = await runChainCreates(deps({ config: config({ chainCreatesDailyCreditCap: 5000 }) }));
    expect(later.sample.days[0]).toMatchObject({ day: DAY, listed: 3000 });
  });
});

describe("chain errors", () => {
  const failing = (kind: FakeFailure, from: number, to = Infinity) => (n: number) => (n >= from && n <= to ? kind : undefined);

  it("a rate limit stops the run; what was not read stays pending and nothing wrong is written", async () => {
    const { store, chain, deps } = setup({ config: { chainCreatesSampleSize: 50 } });
    populate(chain, { count: 200 });
    chain.failure = failing("rate_limit", 6); // 1 listing + 4 reads, then limited
    const r = await runChainCreates(deps());
    expect(r.stoppedBy).toBe("rate limited");
    expect(r.sample).toMatchObject({ read: 4, stored: 4 });
    expect(store.chain.pendingSampleCount()).toBe(46);
    expect(store.study.chainSampleRows(DAY)).toHaveLength(4);
    // credits count what was answered, not what was refused
    expect(store.chain.creditsOnDay("2026-11-19")).toBe(5);
    // the next run reads the same draw to the end
    chain.failure = undefined;
    const next = await runChainCreates(deps());
    expect(next.sample.read).toBe(46);
    expect(store.study.chainSampleRows(DAY)).toHaveLength(50);
    expect(store.chain.getDay(DAY)).toMatchObject({ drawn: 50, stored: 50 });
  });

  it("three transient failures in a row stop the run; a mint that could not be read stays unfilled and is tried again", async () => {
    const { store, chain, deps } = setup({ listing: false });
    for (let n = 1; n <= 5; n++) {
      store.study.recordTokenEvent(pp("migrate", n));
      chain.earliestByMint.set(fakeMint(n), fakeCreateTx({ n, blockTime: 1_700_000_000 }));
    }
    chain.failure = () => "server_error";
    const r = await runChainCreates(deps());
    expect(r.stoppedBy).toBe("chain errors");
    expect(r.migrated.filled).toBe(0);
    for (let n = 1; n <= 5; n++) expect(store.study.getToken(fakeMint(n))).toMatchObject({ name: "", createdAt: null, source: "pumpportal" });
    chain.failure = undefined;
    const next = await runChainCreates(deps());
    expect(next.migrated.filled).toBe(5);
  });

  it("a rejected key stops the run at once", async () => {
    const { chain, deps } = setup();
    populate(chain, { count: 10 });
    chain.failure = () => "auth";
    const r = await runChainCreates(deps());
    expect(r.stoppedBy).toBe("auth");
    expect(chain.calls).toHaveLength(1);
  });

  it("a listing that failed is not tried again for 30 minutes (state kept by the caller)", async () => {
    const { chain, deps, at } = setup();
    populate(chain, { count: 10 });
    const state = {};
    chain.failure = () => "server_error";
    await runChainCreates(deps({ state }));
    const calls = chain.calls.length;
    chain.failure = undefined;
    at(new Date(NOW.getTime() + 10 * 60_000));
    await runChainCreates(deps({ state }));
    expect(chain.calls.length).toBe(calls);
    at(new Date(NOW.getTime() + 31 * 60_000));
    const r = await runChainCreates(deps({ state }));
    expect(r.sample.days).toHaveLength(1);
  });

  it("a signature the node answers null for is retried a few times and then dropped from the draw's pending work", async () => {
    const { store, chain, deps } = setup({ config: { chainCreatesSampleSize: 5 } });
    populate(chain, { count: 5 });
    const gone = fakeSignature(1);
    chain.txBySignature.delete(gone);
    for (let i = 0; i < 4; i++) await runChainCreates(deps());
    expect(store.chain.pendingSampleCount()).toBe(0);
    expect(store.study.chainSampleRows(DAY)).toHaveLength(4);
    expect(chain.calls.filter((c) => c.address === gone)).toHaveLength(3);
  });
});

describe("dry run and switches", () => {
  it("makes no chain call and writes nothing; reports how many mints and credits it would use", async () => {
    const { store, chain, deps, logs } = setup({ config: { chainCreatesSampleSize: 2000 }, priorDrawn: false });
    // the day before yesterday was drawn from 47,000 listed creates, which is what the estimate goes by; only yesterday is owed
    store.chain.saveDraw({ day: "2026-11-17", runId: 0, seed: 1, listed: 47_000, sampleSize: 1, signatures: ["prior"], now: NOW });
    store.chain.closeSample("2026-11-17", "prior", "skipped", "", "set up by the test");
    for (let n = 1; n <= 7; n++) store.study.recordTokenEvent(pp("migrate", n));
    const r = await runChainCreates(deps({ dryRun: true }));
    expect(chain.calls).toEqual([]);
    expect(r.dryRun).toBe(true);
    // 7 mints at 10, a listing guessed at 47 pages (+1), 2000 reads
    expect(r.would).toEqual({ mints: 7, sampleReads: 2000, listingPages: 48, credits: 70 + 48 + 2000 });
    expect(logs.join("\n")).toContain("would look up 7 migrated mint(s)");
    expect(store.chain.creditsOnDay("2026-11-19")).toBe(0);
    expect(store.chain.getDay(DAY)).toBeUndefined();
  });

  it("does nothing without a key, and says why", async () => {
    const { chain, deps } = setup();
    const r = await runChainCreates(deps({ config: config({ apiKey: undefined }) }));
    expect(r.off).toMatch(/HELIUS_API_KEY/);
    expect(chain.calls).toEqual([]);
  });
});

describe("credit logging", () => {
  it("logs credits per run, split by job and verb, with the day's and the month's totals; the key is never logged", async () => {
    const { store, chain, deps, logs } = setup({ config: { chainCreatesSampleSize: 20 } });
    populate(chain, { count: 100 });
    store.study.recordTokenEvent(pp("migrate", 3000));
    chain.earliestByMint.set(fakeMint(3000), fakeCreateTx({ n: 3000, blockTime: 1_700_000_000 }));
    const r = await runChainCreates(deps());
    expect(r.credits.run).toEqual([
      { job: "migrated_creates", verb: TXS_FOR_ADDRESS_VERB, calls: 1, credits: 10 },
      { job: "sample_listing", verb: SIGNATURES_VERB, calls: 1, credits: 1 },
      { job: "sample_reads", verb: TX_VERB, calls: 20, credits: 20 },
    ]);
    expect(r.credits).toMatchObject({ spentToday: 31, month: 31, cap: 25_000 });
    const text = logs.join("\n");
    expect(text).toContain("credits migrated_creates");
    expect(text).toContain("credits sample_listing");
    expect(text).toContain("credits sample_reads");
    expect(text).toContain("credits today 31 of 25000, month to date 31");
    expect(text).not.toContain(TEST_KEY);
    expect(store.chain.creditsByJob("2026-11-19")).toHaveLength(3);
  });

  it("the month-to-date total adds the days of the month so far and not the next month", () => {
    const { store } = setup();
    store.chain.recordCredits("2026-10-31", 1, "sample_reads", TX_VERB, 500);
    store.chain.recordCredits("2026-11-02", 1, "sample_reads", TX_VERB, 100);
    store.chain.recordCredits("2026-11-19", 2, "sample_reads", TX_VERB, 7);
    store.chain.recordCredits("2026-11-20", 3, "sample_reads", TX_VERB, 9);
    expect(store.chain.creditsInMonth(new Date("2026-11-19T12:00:00Z"))).toBe(107);
  });
});
