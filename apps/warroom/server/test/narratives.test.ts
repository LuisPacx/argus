import { Datastore, clusterNewSignals } from "@argus/core";
import { beforeEach, expect, it, vi } from "vitest";

/** Endpoint-level tests: the real route handlers, with only Nitro's auto-imported globals stubbed. */
type Ev = { params: Record<string, string> };
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("getRouterParam", (e: Ev, k: string) => e.params[k]);
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);

const list = (await import("../api/narratives/index.get.ts")).default as unknown as () => unknown;
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
  expect(list()).toEqual([
    {
      id: 2,
      title: "Cat elected mayor of small town",
      summary: "Cat elected mayor of small town summary",
      signalCount: 1,
      createdAt: "2026-06-14T11:00:00.000Z",
      lastSignalAt: "2026-06-14T11:00:00.000Z",
      changedMateriallyAt: "2026-06-14T11:00:00.000Z",
    },
    {
      id: 1,
      title: "Tokenized stocks arrive in Europe",
      summary: "Tokenized stocks arrive in Europe summary",
      signalCount: 2,
      createdAt: "2026-06-14T11:00:00.000Z",
      lastSignalAt: "2026-06-14T11:00:00.000Z",
      changedMateriallyAt: "2026-06-14T11:00:00.000Z",
    },
  ]);
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
