import { describe, expect, it } from "vitest";
import { HttpError, retryingFetchText, type RetryOptions } from "./http.ts";

describe("retryingFetchText", () => {
  const abort = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  /** A fetch fake that throws each of `errors` in turn, then returns "ok". */
  function flaky(errors: unknown[]) {
    let calls = 0;
    const fetchText = async () => {
      const i = calls++;
      if (i < errors.length) throw errors[i];
      return "ok";
    };
    return { fetchText, calls: () => calls };
  }
  const run = async (errors: unknown[], opts: RetryOptions = {}) => {
    const f = flaky(errors);
    const waits: number[] = [];
    const result = await retryingFetchText(f.fetchText, { sleep: async (ms) => void waits.push(ms), ...opts })("https://x.example/p?q=1").catch((e: unknown) => e);
    return { result, waits, calls: f.calls() };
  };

  it("returns the body after two network errors, waiting 500 then 1,000 ms on an injected sleep", async () => {
    const { result, waits, calls } = await run([new TypeError("fetch failed"), new TypeError("fetch failed")]);
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(waits).toEqual([500, 1_000]);
  });

  it("fails after the last attempt with the same error", async () => {
    const err = new TypeError("fetch failed");
    const { result, calls, waits } = await run([err, err, err, err]);
    expect(calls).toBe(3);
    expect(waits).toEqual([500, 1_000]);
    expect(result).toBe(err);
    expect((result as Error).message).toBe("fetch failed");
  });

  const table: Array<[string, unknown, number, number[]]> = [
    ["429 with Retry-After 2,000 waits 2,000", new HttpError("x", 429, 2_000), 2, [2_000]],
    ["a Retry-After of 600,000 waits only the 5,000 cap", new HttpError("x", 429, 600_000), 2, [5_000]],
    ["503 retries", new HttpError("x", 503), 2, [500]],
    ["500 retries", new HttpError("x", 500), 2, [500]],
    ["408 retries", new HttpError("x", 408), 2, [500]],
    ["425 retries", new HttpError("x", 425), 2, [500]],
    ["an AbortError retries", abort(), 2, [500]],
    ["400 is called once", new HttpError("x", 400), 1, []],
    ["401 is called once", new HttpError("x", 401), 1, []],
    ["403 is called once", new HttpError("x", 403), 1, []],
    ["404 is called once", new HttpError("x", 404), 1, []],
    ["body too large is called once", new Error("DexScreener body too large (over 5 bytes)"), 1, []],
  ];
  for (const [name, error, calls, waits] of table)
    it(`status table: ${name}`, async () => {
      const r = await run([error]);
      if (calls === 1) expect(r.result).toBe(error);
      else expect(r.result).toBe("ok");
      expect(r.calls).toBe(calls);
      expect(r.waits).toEqual(waits);
    });

  it("retries 0 turns it off, and onRetry gets the url, the attempt and the wait", async () => {
    expect((await run([new TypeError("fetch failed")], { retries: 0 })).calls).toBe(1);
    const seen: Array<{ url: string; attempt: number; waitMs: number }> = [];
    await run([new TypeError("fetch failed")], { onRetry: (i) => void seen.push({ url: i.url, attempt: i.attempt, waitMs: i.waitMs }) });
    expect(seen).toEqual([{ url: "https://x.example/p?q=1", attempt: 1, waitMs: 500 }]);
  });
});
