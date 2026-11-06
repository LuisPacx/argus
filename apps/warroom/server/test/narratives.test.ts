import { Datastore, HashingEmbedder, clusterNewSignals } from "@argus/core";
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
  await clusterNewSignals(store, new HashingEmbedder(), { now: new Date("2026-06-14T11:00:00.000Z") });
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

it("GET /api/narratives/:id is 404 for an unknown or malformed id", () => {
  expect(() => one({ params: { id: "99" } })).toThrow("Narrative not found");
  expect(() => one({ params: { id: "abc" } })).toThrow("Narrative not found");
});
