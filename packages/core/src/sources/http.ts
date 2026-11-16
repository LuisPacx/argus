export type FetchText = (url: string) => Promise<string>;

/** A non-2xx answer. `retryAfterMs` is the server's Retry-After, or the wait until GitHub's `x-ratelimit-reset`, when it sent one. */
export class HttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface TimedFetchOptions {
  /** Names the Source kind in errors, e.g. `RSS`. */
  what: string;
  timeoutMs: number;
  maxBytes: number;
  headers?: Record<string, string>;
}

/** Reads a body as text, cancelling the stream as soon as it passes `maxBytes`. */
async function readLimited(res: Response, maxBytes: number, what: string): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`${what} body too large (over ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A server's Retry-After is never trusted for longer than this. */
export const MAX_RETRY_AFTER_MS = 60 * 60_000;

/** GitHub's primary rate limit sends no Retry-After: it answers 403 with `x-ratelimit-remaining: 0` and `x-ratelimit-reset` (epoch seconds). Clamped like Retry-After. */
function rateLimitResetMs(res: Response): number | undefined {
  if (res.headers.get("x-ratelimit-remaining")?.trim() !== "0") return undefined;
  const reset = res.headers.get("x-ratelimit-reset")?.trim();
  if (!reset || !/^\d{1,12}$/.test(reset)) return undefined;
  return Math.min(Math.max(Number(reset) * 1_000 - Date.now(), 0), MAX_RETRY_AFTER_MS);
}

/** Retry-After is whole seconds or an HTTP-date. Either way the result is within [0, MAX_RETRY_AFTER_MS]; anything else is ignored. */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after")?.trim();
  if (!raw) return rateLimitResetMs(res);
  let ms: number;
  if (/^\d{1,9}$/.test(raw)) ms = Number(raw) * 1_000;
  else {
    ms = Date.parse(raw) - Date.now();
    if (Number.isNaN(ms) || !/[a-z]/i.test(raw)) return undefined;
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

export interface RetryOptions {
  /** Retries after the first attempt (default 2, so 3 attempts in all). 0 turns retrying off. */
  retries?: number;
  /** The first wait; each later one doubles (default 500 ms). */
  baseMs?: number;
  /** No single wait is longer than this, a server's Retry-After included (default 5,000 ms). */
  maxWaitMs?: number;
  /** Replaces the timer wait (tests pass a recorder). */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each wait, for a log line. `attempt` is the number of the retry about to run, from 1. */
  onRetry?: (info: { url: string; attempt: number; retries: number; error: unknown; waitMs: number }) => void;
}

const RETRY_STATUSES = new Set([408, 425, 429]);

/** A network error (undici's `TypeError: fetch failed`), a timeout (`AbortError`), or a 408, 425, 429 or 5xx answer. Anything else will not get better. */
export function isTransientFetchError(e: unknown): boolean {
  if (e instanceof HttpError) return RETRY_STATUSES.has(e.status) || (e.status >= 500 && e.status <= 599);
  if (e instanceof TypeError) return true;
  return e instanceof Error && e.name === "AbortError";
}

/**
 * Wraps a `FetchText` so a transient failure is tried again, with doubling waits (no jitter). The last error is thrown unchanged.
 * Only the fetch is retried: the caller parses the body, so a bad body after a 2xx is never fetched twice.
 */
export function retryingFetchText(fetchText: FetchText, opts: RetryOptions = {}): FetchText {
  const retries = Math.max(0, Math.floor(opts.retries ?? 2));
  const baseMs = opts.baseMs ?? 500;
  const maxWaitMs = opts.maxWaitMs ?? 5_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (url) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fetchText(url);
      } catch (error) {
        if (attempt > retries || !isTransientFetchError(error)) throw error;
        const floor = error instanceof HttpError ? (error.retryAfterMs ?? 0) : 0;
        const waitMs = Math.min(Math.max(baseMs * 2 ** (attempt - 1), floor), maxWaitMs);
        opts.onRetry?.({ url, attempt, retries, error, waitMs });
        await sleep(waitMs);
      }
    }
  };
}

/** Fetches with a timer that stays armed until the body is read, so a trickled body is bounded too. Remote bodies are untrusted. */
export function timedFetchText(opts: TimedFetchOptions): FetchText {
  return async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, ...(opts.headers ? { headers: opts.headers } : {}) });
      if (!res.ok) throw new HttpError(`${opts.what} fetch failed: ${res.status} ${res.statusText}`, res.status, retryAfterMs(res));
      return await readLimited(res, opts.maxBytes, opts.what);
    } finally {
      clearTimeout(timer);
    }
  };
}
