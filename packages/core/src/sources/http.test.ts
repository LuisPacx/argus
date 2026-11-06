import { describe, expect, it, vi } from "vitest";
import { HttpError, timedFetchText } from "./http.ts";

const withFetch = async (res: Response, run: () => Promise<void>) => {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(res);
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
};

describe("timedFetchText", () => {
  const get = (url = "https://x.example/f") => timedFetchText({ what: "Test", timeoutMs: 1_000, maxBytes: 1_000 })(url);

  it("reads a body under the cap", async () => {
    await withFetch(new Response("hello"), async () => expect(await get()).toBe("hello"));
  });

  it("fails a body over the cap", async () => {
    await withFetch(new Response("x".repeat(5_000)), async () => await expect(get()).rejects.toThrow(/Test body too large/));
  });

  it("turns a 429 into an HttpError carrying Retry-After", async () => {
    await withFetch(new Response("", { status: 429, statusText: "Too Many Requests", headers: { "retry-after": "120" } }), async () => {
      const err = await get().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(429);
      expect((err as HttpError).retryAfterMs).toBe(120_000);
      expect((err as HttpError).message).toContain("429");
    });
  });

  describe("Retry-After as an HTTP-date", () => {
    const NOW = Date.parse("2026-11-05T12:00:00Z");
    const retryAfter = async (header: string) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      try {
        let ms: number | undefined;
        await withFetch(new Response("", { status: 503, headers: { "retry-after": header } }), async () => {
          ms = ((await get().catch((e: unknown) => e)) as HttpError).retryAfterMs;
        });
        return ms;
      } finally {
        vi.useRealTimers();
      }
    };

    it("waits until a date in the future", async () => {
      expect(await retryAfter("Thu, 05 Nov 2026 12:05:00 GMT")).toBe(5 * 60_000);
    });

    it("clamps a date far in the future to an hour", async () => {
      expect(await retryAfter("Fri, 06 Nov 2026 12:00:00 GMT")).toBe(60 * 60_000);
    });

    it("treats a date in the past as no wait", async () => {
      expect(await retryAfter("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(0);
    });

    it("ignores garbage", async () => {
      expect(await retryAfter("soon")).toBeUndefined();
      expect(await retryAfter("-5")).toBeUndefined();
    });

    it("clamps a huge number of seconds to an hour", async () => {
      expect(await retryAfter("9999999")).toBe(60 * 60_000);
    });
  });

  it("sends the given headers", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    try {
      await timedFetchText({ what: "T", timeoutMs: 1_000, maxBytes: 100, headers: { accept: "application/json" } })("https://x.example/f");
      expect(spy).toHaveBeenCalledWith("https://x.example/f", expect.objectContaining({ headers: { accept: "application/json" } }));
    } finally {
      spy.mockRestore();
    }
  });
});
