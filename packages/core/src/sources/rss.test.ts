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

describe("RssSource decoding", () => {
  const one = async (item: string) => (await new RssSource({ id: "rss:d", label: "D", url: "https://d.example/f", fetchText: async () => `<rss><channel>${item}</channel></rss>` }).poll())[0]!;

  it("decodes numeric entities (decimal and hex) in titles and summaries", async () => {
    const s = await one("<item><title>It&#8217;s &#x2019;fine&#x1F600;</title><link>https://d.example/1</link><description>a&#160;b &#xZZ; &#99999999;</description></item>");
    expect(s.title).toBe("It’s ’fine\u{1F600}");
    expect(s.summary).toBe("a b &#xZZ; &#99999999;");
  });

  it("decodes entities in the link before checking it", async () => {
    expect((await one("<item><title>t</title><link>https://d.example/a?b=1&amp;c=2</link></item>")).url).toBe("https://d.example/a?b=1&c=2");
    expect((await one("<item><title>t</title><link>&#106;avascript:alert(1)</link></item>")).url).toBe("");
    expect((await one("<item><title>t</title><link>&#x6A;avascript:alert(1)</link></item>")).url).toBe("");
    expect((await one("<item><title>t</title><link>&amp;#106;avascript:alert(1)</link></item>")).url).toBe("");
  });
});

describe("RssSource against hostile feeds", () => {
  const poll = (xml: string) => new RssSource({ id: "rss:h", label: "H", url: "https://h.example/f", fetchText: async () => xml }).poll();

  it("takes only the first 100 items of an endless item list", async () => {
    const xml = `<rss><channel>${Array.from({ length: 10_000 }, (_, i) => `<item><title>t${i}</title><link>https://h.example/${i}</link></item>`).join("")}</channel></rss>`;
    const signals = await poll(xml);
    expect(signals).toHaveLength(100);
    expect(signals[0]!.title).toBe("t0");
    expect(signals[99]!.title).toBe("t99");
  });

  it("truncates oversized title, summary and url", async () => {
    const [s] = await poll(`<rss><item><title>${"T".repeat(5_000)}</title><link>https://h.example/${"u".repeat(5_000)}</link><description>${"S".repeat(50_000)}</description></item></rss>`);
    expect(s!.title).toHaveLength(300);
    expect(s!.summary).toHaveLength(1_000);
    expect(s!.url).toHaveLength(0); // an over-long link is dropped, not cut into a different URL
  });

  it("keeps a link at the limit", async () => {
    const link = `https://h.example/${"u".repeat(1_900)}`;
    expect((await poll(`<rss><item><title>t</title><link>${link}</link></item></rss>`))[0]!.url).toBe(link);
  });

  it("parses unclosed items and tags in linear time", async () => {
    const t0 = Date.now();
    expect(await poll(`<rss>${"<item><title>x".repeat(40_000)}`)).toEqual([]);
    expect(await poll(`<rss><item>${"<title>x".repeat(60_000)}</item></rss>`)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe("RssSource default fetch", () => {
  const streamOf = (chunks: () => Generator<Uint8Array>) => {
    let cancelled = false;
    const it = chunks();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const n = it.next();
        if (n.done) controller.close();
        else controller.enqueue(n.value);
      },
      cancel() {
        cancelled = true;
      },
    });
    return { body, wasCancelled: () => cancelled };
  };

  it("aborts an endless body once it passes the byte cap", async () => {
    const { body, wasCancelled } = streamOf(function* () {
      const chunk = new Uint8Array(64 * 1024).fill(97);
      while (true) yield chunk;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    try {
      await expect(new RssSource({ id: "rss:big", label: "Big", url: "https://big.example/f" }).poll()).rejects.toThrow(/too large/);
      expect(wasCancelled()).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("reads a body under the cap", async () => {
    const xml = readFileSync(join(import.meta.dirname, "../fixtures", "other-feed.rss.xml"), "utf8");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(xml));
    try {
      expect(await new RssSource({ id: "rss:ok", label: "Ok", url: "https://ok.example/f" }).poll()).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

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
