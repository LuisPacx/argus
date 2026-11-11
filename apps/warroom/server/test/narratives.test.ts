import { Datastore, clusterNewSignals } from "@argus/core";
import { beforeEach, expect, it, vi } from "vitest";

/** Endpoint-level tests: the real route handlers, with only Nitro's auto-imported globals stubbed. */
type Ev = { params: Record<string, string>; query?: Record<string, string> };
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("getRouterParam", (e: Ev, k: string) => e.params[k]);
vi.stubGlobal("getQuery", (e?: Ev) => e?.query ?? {});
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);

const list = (await import("../api/narratives/index.get.ts")).default as unknown as (e?: { query: Record<string, string> }) => Array<{ id: number; score: number | null; hasProposal: boolean }>;
const one = (await import("../api/narratives/[id].get.ts")).default as unknown as (e: Ev) => unknown;

const signal = (id: string, title: string, publishedAt: string) => ({ id, sourceId: "rss:a", sourceLabel: "Feed A", title, summary: `${title} summary`, url: `https://a.example/${id}`, publishedAt });

beforeEach(async () => {
  store = Datastore.open(":memory:");
  store.recordSignals([
    signal("s:1", "Tokenized stocks arrive in Europe", "2026-06-14T09:00:00.000Z"),
    signal("s:2", "Europe gets tokenized stocks", "2026-06-14T09:30:00.000Z"),
    signal("s:3", "Cat elected mayor of small town", "2026-06-14T10:00:00.000Z"),
  ]);
  // A fake through the Embedder seam: the two tokenized-stocks headlines point one way, the cat another.
  const embedder = { id: "fake", dimension: 2, embed: async (s: { title: string }) => (/tokenized/i.test(s.title) ? [1, 0] : [0, 1]) };
  await clusterNewSignals(store, embedder, { now: new Date("2026-06-14T11:00:00.000Z") });
});

it("GET /api/narratives returns no Narratives before anything is clustered", () => {
  store = Datastore.open(":memory:");
  expect(list()).toEqual([]);
});

it("GET /api/narratives returns the exact payload narratives/index.vue renders: summary lines, age, Signal count", () => {
  expect(list({ query: { sort: "active" } })).toEqual([
    {
      id: 2,
      title: "Cat elected mayor of small town",
      summary: "Cat elected mayor of small town summary",
      signalCount: 1,
      createdAt: "2026-06-14T11:00:00.000Z",
      lastSignalAt: "2026-06-14T11:00:00.000Z",
      changedMateriallyAt: "2026-06-14T11:00:00.000Z",
      score: null,
      hasProposal: false,
      sourceClass: "context",
    },
    {
      id: 1,
      title: "Tokenized stocks arrive in Europe",
      summary: "Tokenized stocks arrive in Europe summary",
      signalCount: 2,
      createdAt: "2026-06-14T11:00:00.000Z",
      lastSignalAt: "2026-06-14T11:00:00.000Z",
      changedMateriallyAt: "2026-06-14T11:00:00.000Z",
      score: null,
      hasProposal: false,
      sourceClass: "context",
    },
  ]);
});

it("GET /api/narratives still lists a context-only Narrative, labelled context; one with a market Signal is labelled market", () => {
  expect(list().map((n) => [n.id, (n as unknown as { sourceClass: string }).sourceClass])).toEqual([
    [1, "context"],
    [2, "context"],
  ]);
  store.recordSignals([{ ...signal("m:1", "Pump token", "2026-06-14T10:30:00.000Z"), sourceId: "pumpportal:events", sourceLabel: "PumpPortal" }]);
  const sig = store.unclusteredSignals(10).find((s) => s.id === "m:1")!;
  store.joinNarrative(2, sig, [0, 1], "2026-06-14T11:30:00.000Z");
  const byId = Object.fromEntries(list().map((n) => [n.id, (n as unknown as { sourceClass: string }).sourceClass]));
  expect(byId).toEqual({ 1: "context", 2: "market" });
});

/**
 * Three Narratives whose ids, creation times and last-Signal times all order differently, built relative to the real clock so the
 * activity-window filter has both recent and old Narratives:
 *  1 tokenized: feed a, 2 Signals, created 10 days ago, last Signal 10 days ago, Score 4 then 8 (the latest counts)
 *  2 cat:       feed a, 2 Signals, created 3 h ago, last Signal 2 h ago, Score 6.5, has a Proposal
 *  3 dog:       feed b, 1 Signal, created 5 days ago, unscored
 * So by id desc: 3,2,1; by created_at desc: 2,3,1; by Signals then last Signal: 2,1,3.
 */
const HOUR = 3_600_000;
async function threeNarratives() {
  store = Datastore.open(":memory:");
  const vec = (t: string) => (/tokenized/i.test(t) ? [1, 0, 0] : /cat/i.test(t) ? [0, 1, 0] : [0, 0, 1]);
  const embedder = { id: "fake3", dimension: 3, embed: async (s: { title: string }) => vec(s.title) };
  const at = (msAgo: number) => new Date(Date.now() - msAgo);
  const batch = async (when: Date, ...signals: Array<ReturnType<typeof signal>>) => {
    store.recordSignals(signals);
    await clusterNewSignals(store, embedder, { now: when });
  };
  const t1 = at(240 * HOUR);
  await batch(t1, signal("s:1", "Tokenized stocks arrive in Europe", t1.toISOString()), signal("s:2", "Europe gets tokenized stocks", t1.toISOString()));
  const t2 = at(3 * HOUR);
  await batch(t2, signal("s:3", "Cat elected mayor of small town", t2.toISOString()));
  const t3 = at(120 * HOUR);
  await batch(t3, { ...signal("s:4", "Dog wins the marathon", t3.toISOString()), sourceId: "rss:b", sourceLabel: "Feed B" });
  const t2b = at(2 * HOUR);
  await batch(t2b, signal("s:5", "Cat sworn in as mayor", t2b.toISOString()));
  const dims = { momentum: 5, novelty: 5, buildability: 5, hook: 5, legitimacy: 5 };
  const score = (narrativeId: number, total: number, createdAt: string) =>
    store.recordScore({ narrativeId, rubricVersion: 1, scores: dims, total, rationale: "r", signalCount: 1, changedMateriallyAt: createdAt, createdAt });
  score(1, 4, at(9 * HOUR).toISOString());
  score(1, 8, at(8 * HOUR).toISOString()); // the latest Score is the one that counts
  const catScore = score(2, 6.5, at(HOUR).toISOString());
  store.createResearchProposal(
    { narrativeId: 2, scoreId: catScore, name: "Cat Mayor", ticker: "CATM", narrativeSummary: "n", techOneLiner: "t", whyNow: "w", description: "d", evidenceLinks: [] },
    { now: at(HOUR / 2) },
  );
  return score;
}

it("GET /api/narratives sorts by latest Score, highest first, unscored last (the default)", async () => {
  await threeNarratives();
  expect(list().map((n) => [n.id, n.score])).toEqual([
    [1, 8],
    [2, 6.5],
    [3, null],
  ]);
  expect(list({ query: { sort: "score" } }).map((n) => n.id)).toEqual([1, 2, 3]);
});

it("GET /api/narratives breaks Score ties by most Signals, then newest id", async () => {
  const score = await threeNarratives();
  // All three at 8: Narratives 1 and 2 have two Signals each (so the higher id wins), Narrative 3 has one.
  score(2, 8, new Date().toISOString());
  score(3, 8, new Date().toISOString());
  expect(list().map((n) => [n.id, n.score])).toEqual([
    [2, 8],
    [1, 8],
    [3, 8],
  ]);
});

it("GET /api/narratives sorts by newest (created_at, not id), most Signals, and last Signal, each in full", async () => {
  await threeNarratives();
  expect(list({ query: { sort: "newest" } }).map((n) => n.id)).toEqual([2, 3, 1]);
  expect(list({ query: { sort: "signals" } }).map((n) => [n.id, n.signalCount])).toEqual([
    [2, 2],
    [1, 2],
    [3, 1],
  ]);
  expect(list({ query: { sort: "active" } }).map((n) => n.id)).toEqual([2, 3, 1]);
});

it("GET /api/narratives filters by scored, Proposal, Source and activity window, and combines filters", async () => {
  await threeNarratives();
  expect(list({ query: { scored: "yes" } }).map((n) => n.id)).toEqual([1, 2]);
  expect(list({ query: { scored: "no" } }).map((n) => n.id)).toEqual([3]);
  expect(list({ query: { proposal: "yes" } }).map((n) => [n.id, n.hasProposal])).toEqual([[2, true]]);
  expect(list({ query: { proposal: "no" } }).map((n) => n.id)).toEqual([1, 3]);
  expect(list({ query: { source: "rss:b" } }).map((n) => n.id)).toEqual([3]);
  expect(list({ query: { source: "rss:a" } }).map((n) => n.id)).toEqual([1, 2]);
  expect(list({ query: { source: "rss:a", proposal: "no", scored: "yes" } }).map((n) => n.id)).toEqual([1]);
});

it("GET /api/narratives filters by activity window: recent Narratives are in, old ones out", async () => {
  await threeNarratives();
  expect(list({ query: { active: "1h" } })).toEqual([]); // the newest Signal is 2 hours old
  expect(list({ query: { active: "6h" } }).map((n) => n.id)).toEqual([2]);
  expect(list({ query: { active: "24h" } }).map((n) => n.id)).toEqual([2]);
  expect(list({ query: { active: "7d" } }).map((n) => n.id)).toEqual([2, 3]); // Narrative 3's Signal is 5 days old, 1's is 10
  expect(list({ query: { active: "6h", source: "rss:b" } })).toEqual([]);
});

it("GET /api/narratives applies the cap after sorting, so the highest Score is highest across all Narratives", async () => {
  await threeNarratives();
  expect(store.queryNarratives({ limit: 1 }).map((n) => n.id)).toEqual([1]);
  expect(store.queryNarratives({ sort: "newest", limit: 1 }).map((n) => n.id)).toEqual([2]);
  expect(store.queryNarratives({ scored: false, limit: 5 }).map((n) => n.id)).toEqual([3]);
});

it("GET /api/narratives answers 400 to an unknown sort, filter value or window", async () => {
  await threeNarratives();
  expect(() => list({ query: { sort: "random" } })).toThrow("Invalid sort");
  expect(() => list({ query: { scored: "maybe" } })).toThrow("Invalid scored filter");
  expect(() => list({ query: { proposal: "1" } })).toThrow("Invalid proposal filter");
  expect(() => list({ query: { active: "forever" } })).toThrow("Invalid active window");
  for (const inherited of ["constructor", "__proto__", "toString"]) expect(() => list({ query: { active: inherited } })).toThrow("Invalid active window");
});

it("GET /api/narratives/:id returns the Narrative with its Signals, newest first", () => {
  const out = one({ params: { id: "1" } }) as { id: number; signalCount: number; signals: Array<{ id: string; title: string; url: string; sourceLabel: string; publishedAt: string }> };
  expect(out.id).toBe(1);
  expect(out.signalCount).toBe(2);
  expect(out.signals.map((s) => [s.id, s.title, s.url, s.sourceLabel, s.publishedAt])).toEqual([
    ["s:2", "Europe gets tokenized stocks", "https://a.example/s:2", "Feed A", "2026-06-14T09:30:00.000Z"],
    ["s:1", "Tokenized stocks arrive in Europe", "https://a.example/s:1", "Feed A", "2026-06-14T09:00:00.000Z"],
  ]);
});

it("GET /api/narratives/:id returns the Score history [id].vue renders: every Score with its Rubric version, newest first", () => {
  const detail = (one({ params: { id: "1" } }) as { scores: unknown[] });
  expect(detail.scores).toEqual([]);
  const dims = { momentum: 7, novelty: 6, buildability: 8, hook: 5, legitimacy: 9 };
  store.recordScore({ narrativeId: 1, rubricVersion: 1, scores: dims, total: 7, rationale: "first", signalCount: 2, changedMateriallyAt: "2026-06-14T11:00:00.000Z", createdAt: "2026-06-14T12:00:00.000Z" });
  const r = store.getRubric();
  store.saveRubric({ baseVersion: r.version, gateMinScore: 6, dimensions: r.dimensions });
  store.recordScore({ narrativeId: 1, rubricVersion: 2, scores: { ...dims, momentum: 9 }, total: 7.4, rationale: "second", signalCount: 3, changedMateriallyAt: "2026-06-14T13:00:00.000Z", createdAt: "2026-06-14T14:00:00.000Z" });
  const out = one({ params: { id: "1" } }) as { scores: Array<Record<string, unknown>> };
  expect(out.scores.map((s) => [s.rubricVersion, s.total, s.rationale, s.signalCount, s.createdAt])).toEqual([
    [2, 7.4, "second", 3, "2026-06-14T14:00:00.000Z"],
    [1, 7, "first", 2, "2026-06-14T12:00:00.000Z"],
  ]);
  expect(out.scores[0]!.scores).toEqual({ ...dims, momentum: 9 });
  // The other Narrative has none.
  expect((one({ params: { id: "2" } }) as { scores: unknown[] }).scores).toEqual([]);
});

it("GET /api/narratives/:id is 404 for an unknown or malformed id", () => {
  expect(() => one({ params: { id: "99" } })).toThrow("Narrative not found");
  expect(() => one({ params: { id: "abc" } })).toThrow("Narrative not found");
});
