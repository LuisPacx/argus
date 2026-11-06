import { Datastore } from "@argus/core";
import { beforeEach, expect, it, vi } from "vitest";

/** Endpoint-level test: the real route handler, with only Nitro's auto-imported globals stubbed. */
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("useStore", () => store);

const signals = (await import("../api/signals.get.ts")).default as unknown as () => unknown;

beforeEach(() => {
  store = Datastore.open(":memory:");
});

it("GET /api/signals returns no Signals before anything is ingested", () => {
  expect(signals()).toEqual([]);
});

it("GET /api/signals returns the exact payload index.vue renders: Source, title, link, time", () => {
  store.recordSignals([
    { id: "rss:a:1", sourceId: "rss:a", sourceLabel: "Feed A", title: "Older", summary: "s1", url: "https://a.example/1", publishedAt: "2026-06-14T09:00:00.000Z" },
    { id: "rss:b:1", sourceId: "rss:b", sourceLabel: "Feed B", title: "Newer", summary: "", url: "", publishedAt: "2026-06-15T09:00:00.000Z" },
  ]);
  expect(signals()).toEqual([
    { id: "rss:b:1", sourceId: "rss:b", sourceLabel: "Feed B", title: "Newer", summary: "", url: "", publishedAt: "2026-06-15T09:00:00.000Z", ingestedAt: expect.any(String) },
    { id: "rss:a:1", sourceId: "rss:a", sourceLabel: "Feed A", title: "Older", summary: "s1", url: "https://a.example/1", publishedAt: "2026-06-14T09:00:00.000Z", ingestedAt: expect.any(String) },
  ]);
});

it("GET /api/signals returns at most the 50 latest", () => {
  store.recordSignals(
    Array.from({ length: 60 }, (_, i) => ({
      id: `s:${i}`,
      sourceId: "s",
      sourceLabel: "S",
      title: `t${i}`,
      summary: "",
      url: "",
      publishedAt: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString(),
    })),
  );
  const out = signals() as Array<{ title: string }>;
  expect(out).toHaveLength(50);
  expect(out[0]!.title).toBe("t59");
});
