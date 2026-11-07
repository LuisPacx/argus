import { Datastore, type CollisionResult } from "@argus/core";
import { beforeEach, expect, it, vi } from "vitest";

/** Endpoint-level tests: the real route handler, with only Nitro's auto-imported globals stubbed. */
type Ev = { query?: Record<string, string> };
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("getQuery", (e?: Ev) => e?.query ?? {});
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);
vi.stubGlobal("useDataDir", () => "/argus/data");
vi.stubGlobal("useBuildRoot", () => "/builds/code");

const list = (await import("../api/proposals/index.get.ts")).default as unknown as (e?: Ev) => Array<{ id: number; name: string; score: { total: number } | null }>;
const ids = (e?: Ev) => list(e).map((p) => p.id);

const dims = { momentum: 5, novelty: 5, buildability: 5, hook: 5, legitimacy: 5 };
const check = (status: "clear" | "collides" | "unknown") => ({ status, detail: "d", source: "s", checkedAt: "2026-06-14T10:00:00.000Z" });
const collisions = (dex: "clear" | "collides" | "unknown", github: "clear" | "collides" | "unknown"): CollisionResult => ({ dex: check(dex), github: check(github) });
const fields = (name: string) => ({ narrativeSummary: "s", techOneLiner: "t", whyNow: "w", name, ticker: "TKR", description: "d", evidenceLinks: ["https://e.example/1", "https://e.example/2", "https://e.example/3"] });
const signal = (id: string, title: string) => ({ id, sourceId: "rss:a", sourceLabel: "Feed A", title, summary: "", url: `https://a.example/${id}`, publishedAt: "2026-06-14T09:00:00.000Z" });

const DAY = 24 * 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

/**
 * Four Proposals. 1 Alpha: Narrative scored 4 then 9 (the latest counts), collides, 40 days old, cost 1. 2 Beta: Narrative scored 6.5,
 * clear/clear, 3 days old, shortlisted (just now), cost 3. 3 Gamma: Narrative with no Score, one unknown check, 2 hours old, cost 0.
 * 4 Delta: hand-entered (no Narrative, never checked), created now, cost 2.
 */
function seed() {
  store = Datastore.open(":memory:");
  const narrative = (i: number) => {
    store.recordSignals([signal(`s:${i}`, `Story ${i}`)]);
    const sig = store.unclusteredSignals(10).find((s) => s.id === `s:${i}`)!;
    return store.createNarrative(sig, [1, 0], new Date().toISOString(), { id: "e", dimension: 2 });
  };
  const score = (narrativeId: number, total: number, n: number) =>
    store.recordScore({ narrativeId, rubricVersion: 1, scores: dims, total, rationale: "r", signalCount: 1, changedMateriallyAt: new Date().toISOString(), createdAt: new Date(Date.now() - n).toISOString() });
  const n1 = narrative(1);
  const n2 = narrative(2);
  const n3 = narrative(3);
  const first = score(n1, 4, 3000);
  score(n1, 9, 2000);
  const second = score(n2, 6.5, 1000);
  const a = store.createResearchProposal({ ...fields("Alpha"), narrativeId: n1, scoreId: first, collisions: collisions("collides", "clear") }, { now: ago(40 * DAY) });
  const b = store.createResearchProposal({ ...fields("Beta"), narrativeId: n2, scoreId: second, collisions: collisions("clear", "clear") }, { now: ago(3 * DAY) });
  const c = store.createResearchProposal({ ...fields("Gamma"), narrativeId: n3, scoreId: first, collisions: collisions("clear", "unknown") }, { now: ago(2 * 3_600_000) });
  store.transition(b.id, "shortlisted", "operator");
  const d = store.createProposal(fields("Delta")); // created after the transition, so it is the newest and the most recently changed
  const run = (proposalId: number, cost: number) => store.finishBrainRun(store.startBrainRun({ proposalId, task: "spec", backend: "claude-code", model: "m" }), { sessionId: null, totalCostUsd: cost, exitStatus: "success" });
  run(a.id, 1);
  run(b.id, 3);
  run(d.id, 2);
  return { a: a.id, b: b.id, c: c.id, d: d.id };
}

let p: ReturnType<typeof seed>;
beforeEach(() => {
  p = seed();
});

it("GET /api/proposals sorts by the Narrative's latest Score, highest first, unscored last (the default)", () => {
  expect(list().map((r) => [r.id, r.score?.total ?? null])).toEqual([
    [p.a, 9],
    [p.b, 6.5],
    [p.d, null],
    [p.c, null],
  ]);
  expect(ids({ query: { sort: "score" } })).toEqual([p.a, p.b, p.d, p.c]);
});

it("GET /api/proposals sorts by newest, recently changed, and Est. usage", () => {
  expect(ids({ query: { sort: "newest" } })).toEqual([p.d, p.c, p.b, p.a]);
  expect(ids({ query: { sort: "changed" } })).toEqual([p.d, p.b, p.c, p.a]);
  expect(ids({ query: { sort: "usage" } })).toEqual([p.b, p.d, p.a, p.c]);
});

it("GET /api/proposals filters by status, collision result and created window, and combines filters", () => {
  expect(ids({ query: { status: "shortlisted" } })).toEqual([p.b]);
  expect(ids({ query: { status: "new" } })).toEqual([p.a, p.d, p.c]);
  expect(ids({ query: { collision: "collides" } })).toEqual([p.a]);
  expect(ids({ query: { collision: "clear" } })).toEqual([p.b]);
  expect(ids({ query: { collision: "unknown" } })).toEqual([p.d, p.c]); // one unknown check, and never checked
  expect(ids({ query: { created: "24h" } })).toEqual([p.d, p.c]);
  expect(ids({ query: { created: "7d" } })).toEqual([p.b, p.d, p.c]);
  expect(ids({ query: { created: "30d" } })).toEqual([p.b, p.d, p.c]);
  expect(ids({ query: { status: "new", collision: "unknown", created: "24h", sort: "newest" } })).toEqual([p.d, p.c]);
  expect(ids({ query: { status: "shortlisted", collision: "collides" } })).toEqual([]);
});

it("Datastore.queryProposals applies the limit after sorting, so the highest Score is highest across all Proposals", () => {
  expect(store.queryProposals({ limit: 1 }).map((r) => r.id)).toEqual([p.a]);
  expect(store.queryProposals({ sort: "newest", limit: 1 }).map((r) => r.id)).toEqual([p.d]);
  expect(store.queryProposals({ status: "new", sort: "usage", limit: 2 }).map((r) => r.id)).toEqual([p.d, p.a]);
});

it("GET /api/proposals answers 400 to an unknown sort, status, collision result or created window", () => {
  expect(() => list({ query: { sort: "random" } })).toThrow("Invalid sort");
  expect(() => list({ query: { status: "bogus" } })).toThrow("Invalid status");
  expect(() => list({ query: { collision: "maybe" } })).toThrow("Invalid collision filter");
  expect(() => list({ query: { created: "forever" } })).toThrow("Invalid created window");
  for (const inherited of ["constructor", "__proto__", "toString"]) expect(() => list({ query: { created: inherited } })).toThrow("Invalid created window");
});
