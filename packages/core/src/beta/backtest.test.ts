import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import { META_RULE } from "../meta/config.ts";
import { ROOM_LEFT_RULE } from "./room-left.ts";
import { formatBacktest, runBacktest, snapshotAt, summariseBacktest, type BacktestOptions } from "./backtest.ts";

const T0 = Date.parse("2026-11-10T12:00:00.000Z");
const HOUR = 3_600_000;
const MIN = 60_000;

let seq = 0;
const mintOf = () => `M${String(seq++).padStart(8, "0")}`.padEnd(40, "x") + "pump";
const creatorOf = (c: string) => `C${c}`.padEnd(44, "1");

interface Spec {
  name: string;
  creator: string;
  /** Milliseconds relative to T0 (negative: before). */
  at: number;
  /** Seconds after the create; omitted: never migrated. */
  migratedAfterSec?: number;
}

function launch(store: Datastore, s: Spec): void {
  const mint = mintOf();
  store.study.recordTokenEvent({
    kind: "create", mint, receivedAt: new Date(T0 + s.at).toISOString(), signature: "", name: s.name, symbol: s.name.toUpperCase().replace(/\W/g, "").slice(0, 8),
    creator: creatorOf(s.creator), uri: "https://example.invalid/x", pool: "pump",
  });
  if (s.migratedAfterSec !== undefined)
    store.study.recordTokenEvent({ kind: "migrate", mint, receivedAt: new Date(T0 + s.at + s.migratedAfterSec * 1000).toISOString(), signature: "", name: "", symbol: "", creator: "", uri: "", pool: "pump-amm" });
}

/** A market at T0: a converting Meta (HotCoin), a saturated one (DeadCoin) and background singles; then what happened after T0. */
function market(opts: { future?: boolean; flipper?: boolean } = {}): Datastore {
  const store = Datastore.open(":memory:");
  // Before T0. HotCoin: 30 tokens from 10 creators, a third migrated after 2 minutes, 12 of them in the last 5 h.
  for (let i = 0; i < 30; i++) launch(store, { name: "HotCoin", creator: `h${i % 10}`, at: i < 12 ? -(30 + i * 20) * MIN : -(7 + (i % 12)) * HOUR, ...(i % 3 === 0 ? { migratedAfterSec: 120 } : {}) });
  // DeadCoin: 40 tokens from 12 creators, none migrated, 15 in the last 5 h.
  for (let i = 0; i < 40; i++) launch(store, { name: "DeadCoin", creator: `d${i % 12}`, at: i < 15 ? -(30 + i * 15) * MIN : -(7 + (i % 14)) * HOUR });
  // Background singles with unrelated names, 3% migrated.
  for (let i = 0; i < 300; i++) launch(store, { name: `bgtok${i}x${(i * 7919) % 1000}`, creator: `b${i}`, at: -(31 + (i % 20 * 60)) * MIN, ...(i % 33 === 0 ? { migratedAfterSec: 300 } : {}) });
  if (opts.future ?? true) {
    // After T0, inside 6 h: HotCoin joiners by new creators (5 of 10 migrate), one by an old creator (migrates, must not count).
    for (let i = 0; i < 10; i++) launch(store, { name: "HotCoin", creator: `n${i}`, at: (30 + i * 10) * MIN, ...(i % 2 === 0 ? { migratedAfterSec: 120 } : {}) });
    launch(store, { name: "HotCoin", creator: "h0", at: 45 * MIN, migratedAfterSec: 120 });
    // DeadCoin joiners by new creators: none migrate.
    for (let i = 0; i < 10; i++) launch(store, { name: "DeadCoin", creator: `m${i}`, at: (40 + i * 10) * MIN });
    // Background after T0.
    for (let i = 0; i < 100; i++) launch(store, { name: `bgafter${i}x${(i * 104729) % 1000}`, creator: `a${i}`, at: (31 + i * 3) * MIN, ...(i % 50 === 0 ? { migratedAfterSec: 300 } : {}) });
    // After 6 h but inside 24 h: one more HotCoin joiner who migrates.
    launch(store, { name: "HotCoin", creator: "late", at: 10 * HOUR, migratedAfterSec: 120 });
  }
  if (opts.flipper) {
    // Tokens after T0 that would make a huge, fast-converting DeadCoin if they leaked into the ranking at T0.
    for (let i = 0; i < 200; i++) launch(store, { name: "DeadCoin", creator: `f${i}`, at: (10 + i) * MIN, migratedAfterSec: 120 });
  }
  return store;
}

const opts = (over: Partial<BacktestOptions> = {}): BacktestOptions => ({
  times: [new Date(T0)],
  dataEnd: new Date(T0 + 30 * HOUR),
  top: 3,
  horizonsHours: [6, 24],
  rule: { ...ROOM_LEFT_RULE, minLeadMarketCapUsd: null },
  metaConfig: META_RULE,
  bootstrapResamples: 200,
  ...over,
});

describe("snapshotAt: the look-ahead guard", () => {
  it("passes only the HotCoin through the gates at T0 and removes DeadCoin as saturated", async () => {
    const snap = await snapshotAt(market(), new Date(T0), opts());
    expect(snap.ranking.candidates.map((c) => c.row.label)).toEqual(["HotCoin"]);
    expect(snap.ranking.rejected.map((r) => [r.row.label, r.gate])).toEqual([["DeadCoin", "saturated"]]);
  });

  it("is not changed by 200 fast-converting tokens that exist only after T0", async () => {
    const clean = await snapshotAt(market(), new Date(T0), opts());
    const dirty = await snapshotAt(market({ flipper: true }), new Date(T0), opts());
    // Mints differ between the two stores (a global counter); everything else about the ranking must be identical.
    const plain = (s: typeof clean) => ({
      base: s.ranking.baseMigrationRate,
      candidates: s.ranking.candidates.map((c) => ({ label: c.row.label, counts: c.row.counts, lift: c.lift, reasons: c.reasons })),
      rejected: s.ranking.rejected.map((r) => ({ label: r.row.label, counts: r.row.counts, gate: r.gate, reason: r.reason })),
    });
    expect(plain(dirty)).toEqual(plain(clean));
    expect(dirty.sizeTop.map((r) => r.label)).toEqual(clean.sizeTop.map((r) => r.label));
  });

  it("and the same rows after T0 do change the ranking when the snapshot is taken after them", async () => {
    const later = await snapshotAt(market({ flipper: true }), new Date(T0 + 6 * HOUR), opts());
    expect(later.ranking.candidates[0]?.row.label).toBe("DeadCoin");
  });
});

describe("runBacktest", () => {
  it("counts the tokens that joined each Meta after T0 from creators the Meta had not seen, and whether they migrated by the horizon", async () => {
    const report = await runBacktest(market(), opts());
    const six = report.horizons.find((h) => h.horizonHours === 6)!;
    expect(six.snapshots).toBe(1);
    // Room-left offers HotCoin only: its 10 new-creator joiners, 5 migrated (all after 120 s); the old creator's token does not count.
    expect(six.arms.roomLeft).toMatchObject({ tokens: 10, migrated: 5, migratedAfter60s: 5, metas: 1, snapshots: 1 });
    // Size takes the top 3 Metas by 24 h tokens: DeadCoin (40) and HotCoin (30).
    expect(six.arms.size).toMatchObject({ tokens: 20, migrated: 5, metas: 2 });
    // The rejected Metas: DeadCoin's joiners.
    expect(six.arms.rejected).toMatchObject({ tokens: 10, migrated: 0, metas: 1 });
    // The base: every create in (T0, T0 + 6 h].
    expect(six.arms.base).toMatchObject({ tokens: 10 + 1 + 10 + 100, migrated: 5 + 1 + 2 });
  });

  it("measures the 24 h horizon over the same joiners plus the later one, and skips a T that is too close to the end of the data", async () => {
    const report = await runBacktest(market(), opts());
    const day = report.horizons.find((h) => h.horizonHours === 24)!;
    expect(day.arms.roomLeft).toMatchObject({ tokens: 11, migrated: 6 });
    const shortData = await runBacktest(market(), opts({ dataEnd: new Date(T0 + 12 * HOUR) }));
    expect(shortData.horizons.find((h) => h.horizonHours === 24)!.snapshots).toBe(0);
    expect(shortData.horizons.find((h) => h.horizonHours === 6)!.snapshots).toBe(1);
  });

  it("does not count a migration after the horizon as a migration within it", async () => {
    const store = market({ future: false });
    launch(store, { name: "HotCoin", creator: "slow", at: 60 * MIN, migratedAfterSec: 7 * 3_600 });
    const report = await runBacktest(store, opts());
    expect(report.horizons.find((h) => h.horizonHours === 6)!.arms.roomLeft).toMatchObject({ tokens: 1, migrated: 0 });
    expect(report.horizons.find((h) => h.horizonHours === 24)!.arms.roomLeft).toMatchObject({ tokens: 1, migrated: 1 });
  });

  it("reports the share of the joiners whose names slice 2 would have rejected as copies of the Meta", async () => {
    const report = await runBacktest(market(), opts());
    const six = report.horizons.find((h) => h.horizonHours === 6)!;
    // Every HotCoin joiner is named HotCoin: all copies.
    expect(six.copies).toEqual({ checked: 10, rejected: 10 });
  });

  it("is deterministic", async () => {
    const a = summariseBacktest(await runBacktest(market(), opts()));
    const b = summariseBacktest(await runBacktest(market(), opts()));
    expect(b).toEqual(a);
  });
});

describe("summariseBacktest and formatBacktest", () => {
  it("gives rates with Wilson intervals, lift over the base and over size, and says plainly when the interval includes no lift", async () => {
    const s = summariseBacktest(await runBacktest(market(), opts()));
    const six = s.horizons.find((h) => h.horizonHours === 6)!;
    expect(six.unfiltered.roomLeft.rate).toBeCloseTo(0.5, 5);
    expect(six.unfiltered.roomLeft.wilson.low).toBeLessThan(0.5);
    expect(six.unfiltered.base.rate).toBeCloseTo(8 / 121, 5);
    expect(six.unfiltered.liftOverBase).toBeCloseTo(0.5 / (8 / 121), 4);
    expect(six.unfiltered.liftOverSize).toBeCloseTo(0.5 / 0.25, 4);
    // Ten tokens from one Meta in one snapshot: the interval is wide.
    expect(six.unfiltered.verdict).toMatch(/lift|no lift|inconclusive/);
    const text = formatBacktest(s);
    expect(text).toContain("Wilson");
    expect(text).toContain("independent");
    expect(text).toContain("roomLeft");
  });

  it("calls a lift real only when the cluster interval excludes zero", () => {
    const base = { tokens: 1000, migrated: 50, migratedAfter60s: 40, metas: 0, snapshots: 0 };
    const report = {
      from: "", to: "", dataEnd: "", stepMinutes: 60, top: 3, snapshots: 4,
      horizons: [{
        horizonHours: 6, snapshots: 4, copies: { checked: 0, rejected: 0 },
        arms: { roomLeft: { tokens: 40, migrated: 20, migratedAfter60s: 15, metas: 2, snapshots: 4 }, size: { tokens: 40, migrated: 2, migratedAfter60s: 1, metas: 2, snapshots: 4 }, rejected: { tokens: 0, migrated: 0, migratedAfter60s: 0, metas: 0, snapshots: 0 }, base },
        clusters: {
          roomLeft: { unfiltered: [{ k: 10, n: 20 }, { k: 10, n: 20 }], after60: [{ k: 8, n: 20 }, { k: 7, n: 20 }] },
          size: { unfiltered: [{ k: 1, n: 20 }, { k: 1, n: 20 }], after60: [{ k: 1, n: 20 }, { k: 0, n: 20 }] },
          rejected: { unfiltered: [], after60: [] },
        },
      }],
      rule: opts().rule,
    } as unknown as Parameters<typeof summariseBacktest>[0];
    const six = summariseBacktest(report, { resamples: 300 }).horizons[0]!;
    // Two clusters, identical rates: the bootstrap interval collapses on 50%, far above the 5% base.
    expect(six.unfiltered.verdict).toMatch(/^lift over base/);
    // ... but two Metas are two draws, and the verdict says so rather than let the interval look solid.
    expect(six.unfiltered.verdict).toContain("only 2 distinct Metas");
    const none = { ...report, horizons: [{ ...report.horizons[0]!, arms: { ...report.horizons[0]!.arms, roomLeft: { tokens: 40, migrated: 2, migratedAfter60s: 2, metas: 2, snapshots: 4 } }, clusters: { ...report.horizons[0]!.clusters, roomLeft: { unfiltered: [{ k: 2, n: 20 }, { k: 0, n: 20 }], after60: [{ k: 1, n: 20 }, { k: 1, n: 20 }] } } }] } as typeof report;
    expect(summariseBacktest(none, { resamples: 300 }).horizons[0]!.unfiltered.verdict).toMatch(/^no lift/);
  });
});
