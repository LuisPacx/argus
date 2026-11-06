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

  it("ignores a Retry-After that is not a number of seconds", async () => {
    await withFetch(new Response("", { status: 503, headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } }), async () => {
      expect(((await get().catch((e: unknown) => e)) as HttpError).retryAfterMs).toBeUndefined();
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
