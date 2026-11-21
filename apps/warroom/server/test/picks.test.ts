import { Datastore, type DexPair } from "@argus/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST and GET /api/picks (human researcher ticket 03), the real route handlers over an in-memory store and a fake DexScreener, called with the
 * exact body the form on /research sends ({ text, reason, topic }). Only Nitro's auto-imported globals are stubbed.
 */
type Ev = { body: unknown };
let store: Datastore;
let answers: Record<string, DexPair[] | Error> = {};
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("readBody", async (e: Ev) => e.body);
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);
vi.stubGlobal("useDexClient", () => ({
  async tokenPairs(_c: string, a: string[]) {
    const r = answers[a[0] as string] ?? [];
    if (r instanceof Error) throw r;
    return r;
  },
}));

type Line = { text: string; ok: boolean; message?: string; pickId?: number };
const post = (await import("../api/picks.post.ts")).default as unknown as (e: Ev) => Promise<{ lines: Line[]; skipped: number }>;
const list = (await import("../api/picks.get.ts")).default as unknown as () => Array<Record<string, unknown>>;

const CA_A = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const CA_B = `${"1".repeat(36)}pump`;
const CA_C = "4".repeat(40);
const pair = (ca: string, over: Partial<DexPair> = {}): DexPair => ({ chainId: "solana", tokenAddress: ca, name: `Coin ${ca.slice(0, 4)}`, symbol: "CN", url: "", dexId: "pumpfun", liquidityUsd: 12_000, volume24hUsd: 1, priceChange24hPct: 0, marketCapUsd: 50_000, pairCreatedAt: Date.now() - 600_000, ...over });
const status = async (p: Promise<unknown>) => ((await p.then(() => ({ statusCode: 200 }), (e: { statusCode: number }) => e)) as { statusCode: number }).statusCode;

beforeEach(() => {
  store = Datastore.open(":memory:");
  answers = { [CA_A]: [pair(CA_A)], [CA_B]: [pair(CA_B, { dexId: "raydium" })], [CA_C]: new Error("boom") };
});

describe("POST /api/picks", () => {
  it("two valid addresses record two Picks and the list shows them newest first", async () => {
    const r = await post({ body: { text: `${CA_A}, ${CA_B}`, reason: "r", topic: "GTA" } });
    expect(r.lines).toEqual([
      { text: CA_A, ok: true, pickId: 1 },
      { text: CA_B, ok: true, pickId: 2 },
    ]);
    expect(list().map((p) => [p.id, p.bondedAtPick, p.topic])).toEqual([[2, true, "GTA"], [1, false, "GTA"]]);
  });

  it("a failing line does not lose the others, and a repeat is refused with the reason", async () => {
    const r = await post({ body: { text: `${CA_C} ${CA_A}` } });
    expect(r.lines[0]).toMatchObject({ ok: false });
    expect(r.lines[0]?.message).toContain("could not be reached");
    expect(r.lines[1]).toMatchObject({ ok: true });
    const again = await post({ body: { text: CA_A } });
    expect(again.lines[0]?.message).toContain("Already picked");
    expect(list()).toHaveLength(1);
  });

  it("refuses a body that is not exactly text, reason and topic", async () => {
    expect(await status(post({ body: null }))).toBe(400);
    expect(await status(post({ body: [] }))).toBe(400);
    expect(await status(post({ body: { text: "  " } }))).toBe(400);
    expect(await status(post({ body: { text: CA_A, extra: 1 } }))).toBe(400);
    expect(await status(post({ body: { text: CA_A, reason: 5 } }))).toBe(400);
    expect(await status(post({ body: { text: "x".repeat(5000) } }))).toBe(400);
    expect(list()).toEqual([]);
  });

  it("writes Picks and nothing else: no Proposal, no command", async () => {
    await post({ body: { text: CA_A } });
    expect(store.listProposals()).toEqual([]);
    expect(store.pendingCommands()).toEqual([]);
  });
});

/** POST /api/picks/:id/withdraw (ticket 10), the real handler; the server's own clock decides the 10 minutes. */
vi.stubGlobal("getRouterParam", (e: { id?: string }) => e.id);
const withdraw = (await import("../api/picks/[id]/withdraw.post.ts")).default as unknown as (e: { id: string }) => unknown;
const snapOf = (ca: string) => ({ ca, name: "Coin", symbol: "CN", marketCapUsd: 50_000, liquidityUsd: 12_000, pairCreatedAt: null, ageMinutes: 10, bondedAtPick: false, bondedBasis: "" as const, venue: "pumpfun" });

describe("POST /api/picks/:id/withdraw", () => {
  it("withdraws a fresh Operator Pick; after 10 minutes, twice, a Shadow pick and an unknown id are refused", async () => {
    const fresh = store.recordPick({ snapshot: snapOf(CA_A), reason: "", topic: "" });
    const old = store.recordPick({ snapshot: snapOf(CA_B), reason: "", topic: "" }, { now: new Date(Date.now() - 11 * 60_000) });
    const shadow = store.recordPick({ snapshot: snapOf(CA_C), reason: "", topic: "GTA", source: "shadow" });
    expect(await withdraw({ id: String(fresh.id) })).toEqual({ pickId: fresh.id, withdrawn: true });
    expect(await status(Promise.resolve().then(() => withdraw({ id: String(fresh.id) })))).toBe(409);
    expect(await status(Promise.resolve().then(() => withdraw({ id: String(old.id) })))).toBe(409);
    expect(await status(Promise.resolve().then(() => withdraw({ id: String(shadow.id) })))).toBe(409);
    expect(await status(Promise.resolve().then(() => withdraw({ id: "999" })))).toBe(404);
    expect(await status(Promise.resolve().then(() => withdraw({ id: "abc" })))).toBe(400);
    expect(list().map((p) => [p.id, p.withdrawnAt === null || p.withdrawnAt === undefined ? "no" : "yes"])).toEqual([[old.id, "no"], [fresh.id, "yes"]]);
  });
});
