import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import { FakeChain, TEST_KEY, fakeCreateTx, fakeMint } from "../testing/fake-chain.ts";
import { ChainReader, CreditCapReached, RateLimiter } from "./chain-reader.ts";
import { SIGNATURES_VERB, TXS_FOR_ADDRESS_VERB, TX_VERB } from "./helius.ts";

/** A clock that only moves when something sleeps. */
function fakeClock() {
  let t = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms: number) => (t += ms),
    slept,
  };
}

describe("RateLimiter (fake clock)", () => {
  it("lets `perSecond` requests through in a second and holds the next until the oldest is a second old", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(10, clock.now, clock.sleep);
    const stamps: number[] = [];
    for (let i = 0; i < 25; i++) {
      await limiter.acquire();
      stamps.push(clock.now());
    }
    // the first ten go at once, the next ten a second later, the last five a second after that
    expect(stamps.slice(0, 10).every((s) => s === stamps[0])).toBe(true);
    expect(stamps[10]! - stamps[0]!).toBe(1000);
    expect(stamps[20]! - stamps[10]!).toBe(1000);
    // never more than 10 inside any window of 1000 ms
    for (let i = 0; i + 10 < stamps.length; i++) expect(stamps[i + 10]! - stamps[i]!).toBeGreaterThanOrEqual(1000);
  });

  it("does not wait when the requests are spread out", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(8, clock.now, clock.sleep);
    for (let i = 0; i < 40; i++) {
      await limiter.acquire();
      clock.advance(200);
    }
    expect(clock.slept).toEqual([]);
  });
});

describe("ChainReader credits and cap", () => {
  const setup = (cap: number) => {
    const store = Datastore.open(":memory:");
    const chain = new FakeChain();
    const clock = fakeClock();
    const now = () => new Date(Date.parse("2026-11-19T12:00:00Z"));
    const runId = store.chain.startRun(now(), false);
    const reader = new ChainReader({ client: { apiKey: TEST_KEY, fetch: chain.fetch }, ledger: store.chain, runId, dailyCap: cap, limiter: new RateLimiter(10, clock.now, clock.sleep), now });
    return { store, chain, reader, runId, clock };
  };

  it("counts credits per call from the cost table, by job and verb, and totals the day", async () => {
    const { store, chain, reader, runId } = setup(1000);
    const tx = fakeCreateTx({ n: 1, blockTime: 1_700_000_000 });
    chain.addToAddress(tx);
    chain.earliestByMint.set(fakeMint(1), tx);
    await reader.signaturesPage(undefined);
    await reader.signaturesPage(undefined);
    await reader.transaction(tx.transaction.signatures[0]!);
    await reader.earliestTransaction(fakeMint(1));
    expect(store.chain.creditsOfRun(runId)).toEqual([
      { job: "migrated_creates", verb: TXS_FOR_ADDRESS_VERB, calls: 1, credits: 10 },
      { job: "sample_listing", verb: SIGNATURES_VERB, calls: 2, credits: 2 },
      { job: "sample_reads", verb: TX_VERB, calls: 1, credits: 1 },
    ]);
    expect(store.chain.creditsOnDay("2026-11-19")).toBe(13);
    expect(store.chain.creditsInMonth(new Date("2026-11-19T12:00:00Z"))).toBe(13);
    expect(reader.spent).toEqual({ migrated_creates: 10, sample_listing: 2, sample_reads: 1 });
  });

  it("makes no call that would pass the daily cap", async () => {
    const { store, chain, reader } = setup(12);
    chain.earliestByMint.set(fakeMint(1), fakeCreateTx({ n: 1, blockTime: 1_700_000_000 }));
    await reader.earliestTransaction(fakeMint(1)); // 10 of 12
    await reader.signaturesPage(undefined); // 11
    await reader.signaturesPage(undefined); // 12
    const before = chain.calls.length;
    await expect(reader.signaturesPage(undefined)).rejects.toBeInstanceOf(CreditCapReached);
    await expect(reader.earliestTransaction(fakeMint(1))).rejects.toBeInstanceOf(CreditCapReached);
    expect(chain.calls.length).toBe(before);
    expect(store.chain.creditsOnDay("2026-11-19")).toBe(12);
  });

  it("an earlier run's credits on the same UTC day count against the cap", async () => {
    const { store, reader } = setup(10);
    const earlier = store.chain.startRun(new Date("2026-11-19T01:00:00Z"), false);
    store.chain.recordCredits("2026-11-19", earlier, "sample_reads", TX_VERB, 10);
    await expect(reader.transaction("Sig".padEnd(88, "z"))).rejects.toBeInstanceOf(CreditCapReached);
  });

  it("charges nothing for a call that failed", async () => {
    const { store, chain, reader } = setup(1000);
    chain.failure = () => "rate_limit";
    await expect(reader.signaturesPage(undefined)).rejects.toMatchObject({ kind: "rate_limited" });
    expect(store.chain.creditsOnDay("2026-11-19")).toBe(0);
  });

  it("waits for the rate limiter between calls: never more than 10 requests in a second of the fake clock", async () => {
    const { chain, clock } = setup(1000);
    const stamps: number[] = [];
    const real = chain.fetch;
    const spying: typeof fetch = async (a, b) => {
      stamps.push(clock.now());
      return real(a, b);
    };
    const store = Datastore.open(":memory:");
    const r2 = new ChainReader({
      client: { apiKey: TEST_KEY, fetch: spying },
      ledger: store.chain,
      runId: store.chain.startRun(new Date(), false),
      dailyCap: 1000,
      limiter: new RateLimiter(10, clock.now, clock.sleep),
      now: () => new Date("2026-11-19T12:00:00Z"),
    });
    for (let i = 0; i < 35; i++) await r2.signaturesPage(undefined);
    expect(stamps).toHaveLength(35);
    for (let i = 0; i + 10 < stamps.length; i++) expect(stamps[i + 10]! - stamps[i]!).toBeGreaterThanOrEqual(1000);
  });
});
