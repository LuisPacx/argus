import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RssSource } from "./rss.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "../fixtures", name), "utf8");

describe("RssSource", () => {
  const source = (xml: string) => new RssSource({ id: "rss:tech", label: "Example Tech News", url: "https://news.example.com/feed", fetchText: async () => xml });

  it("has an id and a label", () => {
    const s = source("");
    expect([s.id, s.label]).toEqual(["rss:tech", "Example Tech News"]);
  });

  it("normalizes a recorded feed into Signals", async () => {
    const signals = await source(fixture("tech-news.rss.xml")).poll();
    expect(signals.map(({ id: _id, ...rest }) => rest)).toEqual([
      {
        sourceId: "rss:tech",
        sourceLabel: "Example Tech News",
        title: "Cat Elected Mayor of Small Town",
        summary: "A cat won by a landslide & purred.",
        url: "https://news.example.com/cat-mayor",
        publishedAt: "2026-06-14T09:00:00.000Z",
      },
      {
        sourceId: "rss:tech",
        sourceLabel: "Example Tech News",
        title: "Robots & Rockets: A Launch Day",
        summary: "Short summary.",
        url: "https://news.example.com/robots-rockets",
        publishedAt: "2026-06-14T10:00:00.000Z",
      },
      {
        sourceId: "rss:tech",
        sourceLabel: "Example Tech News",
        title: "Unsafe link item",
        summary: "The link scheme is not http(s).",
        url: "",
        publishedAt: "2026-06-14T11:00:00.000Z",
      },
      {
        sourceId: "rss:tech",
        sourceLabel: "Example Tech News",
        title: "Undated item",
        summary: "",
        url: "https://news.example.com/undated",
        publishedAt: "1970-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("gives the same item the same id on every poll and different items different ids", async () => {
    const a = await source(fixture("tech-news.rss.xml")).poll();
    const b = await source(fixture("tech-news.rss.xml")).poll();
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
    expect(new Set(a.map((s) => s.id)).size).toBe(a.length);
    expect(a[0]!.id.startsWith("rss:tech:")).toBe(true);
  });

  it("ids do not collide across Sources for the same item", async () => {
    const other = new RssSource({ id: "rss:other", label: "O", url: "https://x.example/feed", fetchText: async () => fixture("tech-news.rss.xml") });
    const [a] = await source(fixture("tech-news.rss.xml")).poll();
    const [b] = await other.poll();
    expect(a!.id).not.toBe(b!.id);
  });

  it("returns no Signals for a feed with no items", async () => {
    expect(await source('<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>').poll()).toEqual([]);
  });
});

describe("RssSource default fetch", () => {
  it("is time-bounded: a feed that never answers fails the poll instead of hanging", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    try {
      const s = new RssSource({ id: "rss:hang", label: "Hang", url: "https://hang.example/feed", timeoutMs: 1_000 });
      const result = expect(s.poll()).rejects.toThrow("aborted");
      await vi.advanceTimersByTimeAsync(1_001);
      await result;
      expect(fetchSpy).toHaveBeenCalledWith("https://hang.example/feed", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("fails the poll on a non-2xx response", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 503, statusText: "Service Unavailable" }));
    try {
      await expect(new RssSource({ id: "rss:x", label: "X", url: "https://x.example/feed" }).poll()).rejects.toThrow("503");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
