import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import { DexTruncatedError, type DexPair } from "../sources/dexscreener.ts";
import { bondingStats, OUTCOME_GIVE_UP_MS, SAMPLE_GRACE_MS, trackPickOutcomes } from "./pick-outcomes.ts";
import type { PickLookup, PickSnapshot, PickSource } from "./picks.ts";

const T0 = new Date("2026-11-20T12:00:00.000Z");
const at = (minutes: number) => () => new Date(T0.getTime() + minutes * 60_000);
const H = 60;
const CA_A = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const CA_B = `${"1".repeat(36)}pump`;
/** The source of the Picks the scenarios record and read back; set by `describe.each` below. */
let SOURCE: PickSource = "operator";

const curve = (ca: string, mc: number | undefined): DexPair => ({ chainId: "solana", tokenAddress: ca, name: "Coin", symbol: "CN", url: "", dexId: "pumpfun", liquidityUsd: 12_000, volume24hUsd: 1, priceChange24hPct: 0, marketCapUsd: mc });
const graduated = (ca: string, mc: number): DexPair => ({ ...curve(ca, mc), dexId: "pumpswap", liquidityUsd: 60_000 });

/** A fake DexScreener whose answer per address can be changed between ticks; an Error value makes the lookup fail. */
function fakeDex() {
  const answers = new Map<string, DexPair[] | Error>();
  const calls: string[][] = [];
  const dex: PickLookup = {
    async tokenPairs(_c, addresses) {
      calls.push(addresses);
      const out: DexPair[] = [];
      for (const a of addresses) {
        const r = answers.get(a) ?? [];
        if (r instanceof Error) throw r;
        out.push(...r);
      }
      return out;
    },
  };
  return { dex, answers, calls };
}

const snap = (ca: string, over: Partial<PickSnapshot> = {}): PickSnapshot => ({ ca, name: "Coin", symbol: "CN", marketCapUsd: 50_000, liquidityUsd: 12_000, pairCreatedAt: null, ageMinutes: 10, bondedAtPick: false, bondedBasis: "", venue: "pumpfun", ...over });
function setup(over: Partial<PickSnapshot> = {}, ca = CA_B) {
  const store = Datastore.open(":memory:");
  const pick = store.recordPick({ snapshot: snap(ca, over), reason: "", topic: "", source: SOURCE }, { now: T0 });
  return { store, pick, ...fakeDex() };
}
const run = (s: ReturnType<typeof setup>, minutes: number) => trackPickOutcomes(s.store, s.dex, { now: at(minutes) });
const outcome = (s: ReturnType<typeof setup>, minutes = 25 * H) => s.store.pickOutcomes(at(minutes)(), SOURCE).outcomes[0]!;

// Human researcher ticket 08: a Shadow pick gets the same outcome job as an Operator Pick, so every scenario below runs once per source.
describe.each(["operator", "shadow"] as const)("pick outcomes (%s Picks)", (source) => {
  beforeEach(() => {
    SOURCE = source;
  });

  it("reads pending before 24 hours, then bonded yes with the peaks at +1h, +6h and +24h", async () => {
    const s = setup();
    s.answers.set(CA_B, [curve(CA_B, 60_000)]);
    await run(s, 5);
    s.answers.set(CA_B, [curve(CA_B, 90_000)]);
    await run(s, 1 * H + 5);
    s.answers.set(CA_B, [graduated(CA_B, 70_000)]);
    await run(s, 3 * H);
    expect(outcome(s, 12 * H)).toMatchObject({ result: "bonded", over: false });
    s.answers.set(CA_B, [graduated(CA_B, 40_000)]);
    await run(s, 6 * H);
    await run(s, 24 * H + 2);
    const o = outcome(s);
    expect(o).toMatchObject({ result: "bonded", over: true });
    expect(o.marks).toEqual([
      { mark: "1h", state: "sampled", peakUsd: 90_000 },
      { mark: "6h", state: "sampled", peakUsd: 90_000 },
      { mark: "24h", state: "sampled", peakUsd: 90_000 },
    ]);
    expect(s.store.pickOutcomes(at(25 * H)(), SOURCE).all).toMatchObject({ bonded: 1, finished: 1, rate: 1 });
  });

  it("a coin still on the curve at the deadline is not bonded; one that is pending before then stays pending", async () => {
    const s = setup();
    s.answers.set(CA_B, [curve(CA_B, 60_000)]);
    await run(s, 10 * H);
    expect(outcome(s, 10 * H)).toMatchObject({ result: "pending", over: false });
    await run(s, 24 * H + 1);
    expect(outcome(s)).toMatchObject({ result: "pending", over: true }); // not decided inside the settle time after the deadline
    await run(s, 24 * H + 11);
    expect(outcome(s)).toMatchObject({ result: "not-bonded", over: true });
    expect(s.store.pickOutcomes(at(25 * H)(), SOURCE).all).toMatchObject({ bonded: 0, finished: 1, rate: 0 });
  });

  it("a coin already bonded at the Pick is left out of the rate and counted on its own", async () => {
    const s = setup({ bondedAtPick: true, bondedBasis: "dexscreener", venue: "pumpswap" });
    s.answers.set(CA_B, [graduated(CA_B, 900_000)]);
    await run(s, 5);
    await run(s, 24 * H + 1);
    expect(outcome(s)).toMatchObject({ result: "already-bonded" });
    expect(s.store.pickOutcomes(at(25 * H)(), SOURCE).all).toEqual({ bonded: 0, finished: 0, rate: null, alreadyBonded: 1, unknown: 0, pending: 0 });
  });

  it("a coin the Study saw migrate inside the window is bonded at that time, even when found late", async () => {
    const s = setup();
    const migrated = new Date(T0.getTime() + 3 * H * 60_000).toISOString();
    const withStudy = { openPickOutcomes: () => s.store.openPickOutcomes(), applyPickProgress: s.store.applyPickProgress.bind(s.store), migrationOf: () => migrated };
    s.answers.set(CA_B, [graduated(CA_B, 70_000)]);
    await trackPickOutcomes(withStudy, s.dex, { now: at(24 * H + 1) });
    expect(outcome(s)).toMatchObject({ result: "bonded", bondedAt: migrated });
  });

  it("a coin the Study saw migrate after the deadline is not bonded within 24h", async () => {
    const s = setup();
    const migrated = new Date(T0.getTime() + 30 * H * 60_000).toISOString();
    const withStudy = { openPickOutcomes: () => s.store.openPickOutcomes(), applyPickProgress: s.store.applyPickProgress.bind(s.store), migrationOf: () => migrated };
    s.answers.set(CA_B, [graduated(CA_B, 70_000)]);
    await trackPickOutcomes(withStudy, s.dex, { now: at(31 * H) });
    expect(outcome(s, 32 * H)).toMatchObject({ result: "not-bonded" });
  });

  it("a failed lookup is retried next tick and never marks the Pick not bonded", async () => {
    const s = setup();
    s.answers.set(CA_B, new Error("HTTP 503"));
    const first = await run(s, 24 * H + 1);
    expect(first.failed).toBe(1);
    expect(outcome(s)).toMatchObject({ result: "pending", over: true });
    s.answers.set(CA_B, [curve(CA_B, 50_000)]);
    await run(s, 24 * H + 16);
    expect(outcome(s)).toMatchObject({ result: "not-bonded" });
  });

  it("an in-window migration record decides bonded with DexScreener failing the whole 48 hours", async () => {
    const s = setup();
    const migrated = new Date(T0.getTime() + 5 * H * 60_000).toISOString();
    const withStudy = { openPickOutcomes: () => s.store.openPickOutcomes(), applyPickProgress: s.store.applyPickProgress.bind(s.store), migrationOf: () => migrated };
    s.answers.set(CA_B, new Error("down"));
    await trackPickOutcomes(withStudy, s.dex, { now: at(48 * H + 1) });
    expect(outcome(s, 49 * H)).toMatchObject({ result: "bonded", bondedAt: migrated });
  });

  it("an empty answer is not a sighting", async () => {
    const s = setup();
    s.answers.set(CA_B, []);
    await run(s, 5);
    expect(s.store.openPickOutcomes()[0]!.outcome!.lastOkAt).toBeNull();
    s.answers.set(CA_B, [curve(CA_B, 5)]);
    await run(s, 10);
    expect(s.store.openPickOutcomes()[0]!.outcome!.lastOkAt).toBe(at(10)().toISOString());
  });

  it("a coin seen bonded after the deadline with no record is unknown, not guessed either way", async () => {
    const s = setup();
    s.answers.set(CA_B, [curve(CA_B, 60_000)]);
    await run(s, 24 * H - 5); // last seen on the curve 5 minutes before the deadline
    s.answers.set(CA_B, [graduated(CA_B, 70_000)]);
    await run(s, 24 * H + 15);
    expect(outcome(s)).toMatchObject({ result: "unknown" });
  });

  it("a pump coin with no curve pair shown is not clearly on the curve: it waits instead of becoming not bonded", async () => {
    const s = setup();
    s.answers.set(CA_B, [{ ...curve(CA_B, 60_000), dexId: "pumpswap", liquidityUsd: 100 }]);
    await run(s, 24 * H + 15);
    expect(outcome(s)).toMatchObject({ result: "pending" });
  });

  it("a failing lookup that is not a cut (an outage, a 429) makes exactly one call per chunk per tick", async () => {
    const s = setup({}, CA_B);
    s.store.recordPick({ snapshot: snap(CA_A), reason: "", topic: "", source: SOURCE }, { now: T0 });
    s.answers.set(CA_A, new Error("HTTP 429"));
    s.answers.set(CA_B, new Error("HTTP 429"));
    const r = await run(s, 5);
    expect(s.calls).toHaveLength(1);
    expect(r.failed).toBe(2);
    await run(s, 10);
    expect(s.calls).toHaveLength(2);
  });

  it("a cut batch never decides a coin: it is split, and only a coin whose own answer fails waits", async () => {
    const s = setup({}, CA_B);
    s.store.recordPick({ snapshot: snap(CA_A), reason: "", topic: "", source: SOURCE }, { now: T0 });
    s.answers.set(CA_A, [curve(CA_A, 1)]);
    s.answers.set(CA_B, [graduated(CA_B, 1)]);
    const asked: string[][] = [];
    const cutting: PickLookup = {
      async tokenPairs(_c, addresses, o) {
        asked.push(addresses);
        if (o?.failIfTruncated !== true) throw new Error("the job must ask for truncation errors");
        if (addresses.length > 1) throw new DexTruncatedError("answer may be cut"); // what the real client does at 100 entries
        return s.dex.tokenPairs("solana", addresses);
      },
    };
    const r = await trackPickOutcomes(s.store, cutting, { now: at(24 * H - 30) });
    expect(asked.map((a) => a.length)).toEqual([2, 1, 1]);
    expect(r.failed).toBe(0);
    s.answers.set(CA_A, new Error("always cut"));
    const r2 = await trackPickOutcomes(s.store, cutting, { now: at(24 * H - 25) });
    expect(r2.failed).toBe(1);
  });

  it("a coin that vanished ends unknown and is left out of the rate, with its count", async () => {
    const s = setup();
    s.answers.set(CA_B, []);
    await run(s, 24 * H + 11);
    expect(outcome(s)).toMatchObject({ result: "unknown" });
    expect(s.store.pickOutcomes(at(25 * H)(), SOURCE).all).toEqual({ bonded: 0, finished: 0, rate: null, alreadyBonded: 0, unknown: 1, pending: 0 });
  });

  it("lookups that keep failing for a further 24 hours end unknown", async () => {
    const s = setup();
    s.answers.set(CA_B, new Error("down"));
    await run(s, OUTCOME_GIVE_UP_MS / 60_000);
    expect(outcome(s, 49 * H)).toMatchObject({ result: "unknown" });
  });

  it("a restart that lost a window stores that mark as missed, never a made-up peak", async () => {
    const s = setup();
    s.answers.set(CA_B, [curve(CA_B, 80_000)]);
    await run(s, 5);
    // The worker was down from +10 min to +7 h: the +1h and +6h windows (and their grace) passed unseen; the +24h one is sampled.
    await run(s, 7 * H);
    expect(outcome(s, 7 * H).marks).toEqual([
      { mark: "1h", state: "missed", peakUsd: null },
      { mark: "6h", state: "missed", peakUsd: null },
      { mark: "24h", state: "waiting", peakUsd: null },
    ]);
    await run(s, 24 * H + SAMPLE_GRACE_MS / 60_000 / 2);
    expect(outcome(s).marks[2]).toMatchObject({ state: "sampled", peakUsd: 80_000 });
    await run(s, 24 * H + 3 * 60);
  });

  it("a mark looked at only after its grace window is missed even though the lookup works", async () => {
    const s = setup();
    s.answers.set(CA_B, [curve(CA_B, 80_000)]);
    await run(s, 1 * H + 30);
    expect(outcome(s, 2 * H).marks[0]).toEqual({ mark: "1h", state: "missed", peakUsd: null });
  });

  it("a second run over finished Picks looks nothing up and writes nothing", async () => {
    const s = setup();
    s.answers.set(CA_B, [curve(CA_B, 50_000)]);
    await run(s, 1 * H + 1);
    await run(s, 6 * H + 1);
    await run(s, 24 * H + 1);
    await run(s, 25 * H);
    const before = JSON.stringify(s.store.pickOutcomes(at(26 * H)(), SOURCE));
    s.calls.length = 0;
    const r = await run(s, 30 * H);
    expect(r).toEqual({ open: 0, failed: 0, sampled: 0, missed: 0, decided: 0, finished: 0 });
    expect(s.calls).toEqual([]);
    expect(JSON.stringify(s.store.pickOutcomes(at(26 * H)(), SOURCE))).toBe(before);
  });

  it("the picks table is never written (its update trigger would refuse it) and lookups are batched", async () => {
    const s = setup({}, CA_B);
    s.store.recordPick({ snapshot: snap(CA_A), reason: "", topic: "", source: SOURCE }, { now: T0 });
    s.answers.set(CA_A, [curve(CA_A, 1)]);
    s.answers.set(CA_B, [curve(CA_B, 1)]);
    await run(s, 5);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toHaveLength(2);
  });

  // The job takes only a store and a DexScreener lookup, so it has no seam for a Brain. That no Claude call happens when it runs in the worker
  // is tested with a fake claude binary in apps/worker/src/default-schedules.test.ts; this guards the module itself.
  it("the module never mentions a Brain, claude or a spawn", async () => {
    const src = readFileSync(new URL("./pick-outcomes.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/brain|claude|spawn/i);
  });
});

describe("bondingStats", () => {
  it("an empty set has no rate (never 0)", () => {
    expect(bondingStats([])).toMatchObject({ finished: 0, rate: null });
  });
});
