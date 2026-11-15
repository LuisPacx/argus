import { CURRENT_META_SHOWN, Datastore, META_RULE, type CurrentMeta, type CurrentMetaResponse, type MetaSnapshot, type NewMemeTrio, type NewMetaRow, type NewMetaRun } from "@argus/core";
import { beforeEach, expect, it, vi } from "vitest";

/** Endpoint-level test: the real route handler over a seeded in-memory store, with only Nitro's auto-imported globals stubbed. */
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("useStore", () => store);

const currentMeta = (await import("../api/current-meta.get.ts")).default as unknown as () => CurrentMetaResponse;

const NOW = Date.now(); // the route reads the clock for the Hot now window and the summary age
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (minutes: number) => iso(NOW - minutes * 60_000);
const counts = (tokens: number, creators: number) => ({ "6h": { tokens: Math.floor(tokens / 3), creators: Math.floor(creators / 3), migrations: 0, migrationsAfter60s: 0 }, "24h": { tokens, creators, migrations: 2, migrationsAfter60s: 1 } });

const themeRow = (key: string, label = key): NewMetaRow => ({ key, label, firstSeenAt: ago(600), counts: counts(40, 30), topTokens: [] });
const subject = (key: string, cap: number, over: Partial<CurrentMeta> = {}): CurrentMeta => ({
  key,
  label: key.toUpperCase(),
  leader: { mint: `${key}Mint1111111111111111111111111111111111`.slice(0, 40), name: `${key} the token`, symbol: key.toUpperCase(), marketCapUsd: cap, source: "trending", stale: false, freshAt: ago(10) },
  holding: false,
  enteredAt: ago(180),
  counts: counts(40, 30),
  topTokens: [{ mint: "MintA", name: "A", symbol: "SYM", marketCapUsd: cap }],
  ...over,
});
const save = (metas: CurrentMeta[], watching: CurrentMeta[], at = ago(5)): void => {
  const run: NewMetaRun = {
    computedAt: at,
    note: "n",
    rule: META_RULE,
    dexCalls: 0,
    dexFailures: 0,
    base: { "6h": { tokens: 100, migrations: 20 }, "24h": { tokens: 400, migrations: 40 } },
    rows: { "6h": [], "24h": [...metas, ...watching].map((m) => themeRow(m.key, m.label)) },
    current: { metas, watching },
  };
  store.meta.saveRun(run);
};

const trio = (key: string): NewMemeTrio => ({
  metaKey: key,
  metaLabel: key.toUpperCase(),
  snapshot: {
    version: 1,
    capturedAt: ago(0),
    meta: { key, label: key.toUpperCase(), rank: 1, firstSeenAt: ago(600), counts: counts(40, 30), topTokens: [] },
    run: { id: 1, computedAt: ago(5), window: "24h", baseMigrationRate: 0.03, coverage: null },
    hot: { reason: "r", raisedAt: ago(30), rank: 1, creators: 30 },
    roomLeft: { passed: true, text: "t" },
    tokens: [],
    news: [],
  } satisfies MetaSnapshot,
  reason: "Hot now: r",
  summary: "s",
  evidenceLinks: [],
  ideas: ["Alpha", "Bravo", "Charlie"].map((n, i) => ({ name: `Idea ${n}`, ticker: ["AAA", "BBB", "CCC"][i]!, angle: `Angle ${n}`, difference: "d", description: "p", hook: "h", imageIdea: "i", riskLabels: ["real person"] })),
});

beforeEach(() => {
  store = Datastore.open(":memory:");
});

it("GET /api/current-meta is empty lists and a null computedAt before the first run", () => {
  expect(currentMeta()).toEqual({ computedAt: null, coverageNote: null, metas: [], watching: [] });
});

it("a run with no Meta and no Watching: computedAt set, both lists empty", () => {
  save([], []);
  expect(currentMeta()).toMatchObject({ computedAt: ago(5), metas: [], watching: [] });
});

it("returns at most 3 Metas and 3 Watching in the stored (leader-cap) order, with leader, cap, copies, holding, enteredAt and a numbers line", () => {
  expect(CURRENT_META_SHOWN).toBe(3);
  save(
    [subject("a", 9_000_000), subject("b", 4_000_000, { holding: true }), subject("c", 2_000_000), subject("d", 1_500_000)],
    [subject("w1", 90_000), subject("w2", 60_000), subject("w3", 40_000), subject("w4", 30_000)],
  );
  const r = currentMeta();
  expect(r.metas.map((m) => m.key)).toEqual(["a", "b", "c"]);
  expect(r.watching.map((m) => m.key)).toEqual(["w1", "w2", "w3"]);
  expect(r.metas[0]).toMatchObject({ label: "A", holding: false, enteredAt: ago(180), counts: { "24h": { creators: 30 } }, leader: { name: "a the token", symbol: "A", marketCapUsd: 9_000_000, stale: false } });
  expect(r.metas[0]!.leader.url).toMatch(/^https:\/\/dexscreener\.com\/solana\/aMint/);
  expect(r.metas[1]!.holding).toBe(true);
  expect(r.metas[0]!.summarySource).toBe("template");
  expect(r.metas[0]!.summary).toContain("30 creators in 24 h");
  expect(r.watching.every((w) => w.holding === false && !("ideas" in w))).toBe(true);
});

it("a leader marked stale stays stale; a leader mint that is not an address gets no link", () => {
  save([subject("a", 3_000_000, { leader: { mint: "not an address", name: "n", symbol: "N", marketCapUsd: 3_000_000, source: "theme", stale: true, freshAt: ago(30) } })], []);
  const l = currentMeta().metas[0]!.leader;
  expect(l.stale).toBe(true);
  expect(l).not.toHaveProperty("url");
});

it("the stored LLM line shows while it is under a day old, however the counts moved, and is replaced by the numbers line led by the leader once it is older", () => {
  save([subject("a", 3_000_000), subject("b", 3_000_000)], [subject("w", 80_000)]);
  store.meta.saveSummary("a", "Jensen Huang quits Nvidia and the token market follows", "h", ago(60), { tokens: 400, creators: 300 }); // counts moved since: the line stands
  store.meta.saveSummary("b", "An old line", "h", ago(25 * 60), { tokens: 40, creators: 30 });
  store.meta.saveSummary("w", "Watching line", "h", ago(60), { tokens: 40, creators: 30 });
  const r = currentMeta();
  expect(r.metas[0]).toMatchObject({ summary: "Jensen Huang quits Nvidia and the token market follows", summarySource: "llm" });
  expect(r.metas[1]).toMatchObject({ summarySource: "template" });
  expect(r.metas[1]!.summary).toMatch(/^led by b the token at \$3M; 40 tokens from 30 creators in 24 h/);
  expect(r.watching[0]).toMatchObject({ summary: "Watching line", summarySource: "llm" });
});

it("a Meta carries a New Meta mark while its event is live (not Watching), from the same lookup as /api/new-metas", () => {
  save([subject("a", 3_000_000), subject("b", 3_000_000)], [subject("w", 80_000)]);
  const runId = store.currentMetas()!.runId;
  const leader = store.currentMetas()!.metas[0]!.leader;
  store.meta.saveNewMeta({ key: "a", label: "A", raisedAt: ago(20), reason: "became a Meta: $A at $3M, 30 creators in 24 h", rank: 1, leader, copies: 30, runId });
  store.meta.saveNewMeta({ key: "w", label: "W", raisedAt: ago(20), reason: "became a Meta: $W", rank: 1, leader, copies: 30, runId });
  store.meta.saveNewMeta({ key: "b", label: "B", raisedAt: ago(60 * 7), reason: "became a Meta: $B", rank: 1, leader, copies: 30, runId }); // past its live window
  const r = currentMeta();
  expect(r.metas[0]).toMatchObject({ newMeta: { reason: "became a Meta: $A at $3M, 30 creators in 24 h", raisedAt: ago(20) } });
  expect(r.metas[1]).not.toHaveProperty("newMeta");
  expect(r.watching[0]).not.toHaveProperty("newMeta");
});

it("a Meta carries its live meme ideas; a Watching subject with the same key does not", () => {
  save([subject("jensen", 3_000_000)], [subject("w", 80_000)]);
  store.createMemeProposals(trio("jensen"), { now: new Date(NOW) });
  const r = currentMeta();
  expect(r.metas[0]!.ideas?.map((i) => i.name)).toEqual(expect.arrayContaining(["Idea Alpha", "Idea Bravo", "Idea Charlie"]));
  expect(r.watching[0]).not.toHaveProperty("ideas");
});

it("is read-only: the route takes no query and writes nothing", () => {
  save([subject("a", 3_000_000)], []);
  const before = store.currentMetas();
  currentMeta();
  expect(store.currentMetas()).toEqual(before);
});
