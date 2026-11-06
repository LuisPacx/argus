export type FetchText = (url: string) => Promise<string>;

/** A non-2xx answer. `retryAfterMs` is the server's Retry-After (whole seconds only) when it sent one. */
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

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  return raw !== null && /^\d{1,7}$/.test(raw.trim()) ? Number(raw.trim()) * 1_000 : undefined;
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
