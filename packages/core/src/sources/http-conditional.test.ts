import { describe, expect, it, vi } from "vitest";
import { HttpError, timedFetchConditional } from "./http.ts";
import { FEED_HEADERS, RssSource } from "./rss.ts";

const withFetch = async (res: Response, run: (spy: ReturnType<typeof vi.spyOn>) => Promise<void>) => {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(res);
  try {
    await run(spy as never);
  } finally {
    spy.mockRestore();
  }
};
const headersOf = (spy: { mock: { calls: unknown[][] } }, call = 0) => ((spy.mock.calls[call]![1] as RequestInit).headers ?? {}) as Record<string, string>;

describe("timedFetchConditional", () => {
  const get = (cond = {}) => timedFetchConditional({ what: "Test", timeoutMs: 1_000, maxBytes: 1_000, headers: { "user-agent": "tester" } })("https://x.example/f", cond);

  it("sends the validators and the headers it was given", async () => {
    await withFetch(new Response("hello"), async (spy) => {
      await get({ etag: '"abc"', lastModified: "Thu, 19 Nov 2026 11:50:00 GMT" });
      expect(headersOf(spy)).toEqual({ "user-agent": "tester", "if-none-match": '"abc"', "if-modified-since": "Thu, 19 Nov 2026 11:50:00 GMT" });
    });
  });

  it("a 200 returns the body and the validators the server sent; a 304 is not an error", async () => {
    await withFetch(new Response("hello", { headers: { etag: '"v1"', "last-modified": "Thu, 19 Nov 2026 11:50:00 GMT" } }), async () => {
      expect(await get()).toEqual({ notModified: false, body: "hello", etag: '"v1"', lastModified: "Thu, 19 Nov 2026 11:50:00 GMT" });
    });
    await withFetch(new Response(null, { status: 304 }), async () => expect(await get({ etag: '"v1"' })).toEqual({ notModified: true }));
  });

  it("keeps the size cap and the error of timedFetchText (a 429 carries Retry-After)", async () => {
    await withFetch(new Response("x".repeat(5_000)), async () => await expect(get()).rejects.toThrow(/Test body too large/));
    await withFetch(new Response("", { status: 429, statusText: "Too Many Requests", headers: { "retry-after": "120" } }), async () => {
      const err = await get().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).retryAfterMs).toBe(120_000);
    });
  });
});

describe("the Narrative RSS Source names itself (the TechCrunch 403 of the ticket 01 review)", () => {
  it("sends a User-Agent and an Accept header, because some hosts answer 403 to Node's bare one", async () => {
    expect(FEED_HEADERS["user-agent"]).toMatch(/^argus\/\d/);
    expect(FEED_HEADERS["user-agent"]).not.toMatch(/@|https?:/); // it names the tool and nobody else
    await withFetch(new Response('<rss><channel><item><title>t</title><link>https://x.example/a</link></item></channel></rss>'), async (spy) => {
      const signals = await new RssSource({ id: "rss:techcrunch", label: "TechCrunch", url: "https://techcrunch.com/feed/" }).poll();
      expect(signals).toHaveLength(1);
      expect(headersOf(spy)).toMatchObject({ "user-agent": FEED_HEADERS["user-agent"], accept: expect.stringContaining("rss+xml") });
    });
  });
});
