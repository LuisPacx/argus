import { retryingFetchText, timedFetchText, type FetchText } from "./http.ts";
import { stripHtml } from "./rss.ts";

/**
 * What the two top-down list clients (Jupiter and GeckoTerminal trending, meta-redesign ticket 05) share: one read-only fetch with the
 * retries of ticket 04, and the rules for reading untrusted remote JSON. Every string is cut and stripped, every number is finite and not
 * negative, every mint matches the same address shape DexScreener's client uses before it can go into a URL or a table.
 */

/** Only the first this-many entries of any response are read. */
export const MAX_ENTRIES = 100;
export const MAX_NAME_CHARS = 100;
export const MAX_SYMBOL_CHARS = 30;
export const MAX_TAG_CHARS = 40;
export const MAX_TAGS = 20;
const LIST_TIMEOUT_MS = 10_000;
const LIST_MAX_BYTES = 2 * 1024 * 1024;

/** A token address: a plain base-58-looking token, 20 to 66 characters. Same shape as DexScreener's `ADDRESS_RE`. */
export const MINT_RE = /^[A-Za-z0-9]{20,66}$/;

/** Remote text: cut first (the markup pattern is quadratic on a long run of `<`), markup removed, trimmed, cut again. */
export const text = (v: unknown, max: number): string => (typeof v === "string" ? stripHtml(v.slice(0, max * 4)).trim().slice(0, max) : "");

/** A finite, non-negative number from a JSON number or a decimal string (GeckoTerminal sends its figures as strings); anything else is absent. */
export function amount(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.length <= 64 && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** An ISO time from a remote date string, or undefined. */
export function isoTime(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > 40) return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}

/** The first `MAX_ENTRIES` entries of a response, or an error when the response is not a list (never an empty list standing for a broken answer). */
export function listOf(what: string, data: unknown): unknown[] {
  if (!Array.isArray(data)) throw new Error(`${what}: unexpected response (no list)`);
  return data.slice(0, MAX_ENTRIES);
}

export function parseJson(what: string, body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`${what}: response is not JSON`);
  }
}

export interface ListFetchOptions {
  /** Names the source in errors and retry notes, for example `Jupiter`. */
  what: string;
  /** Replaces the network fetch (tests pass recorded JSON). */
  fetchText?: FetchText;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Retries after a transient failure. Default 2 on the network fetch; an injected `fetchText` is used as given unless this is set. 0 turns it off. */
  retries?: number;
  /** The first retry wait in ms (doubles each time). Default 500. */
  retryBaseMs?: number;
  /** Replaces the retry timer (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Receives the one-line retry notes. Default `console.log`. */
  log?: (line: string) => void;
  /** Called before every HTTP request, retries included; a throw ends that request without a retry (the per-tick call budget). */
  onRequest?: () => void;
}

/** A read-only text fetch: counted per request, then retried on a transient failure. */
export function listFetch(o: ListFetchOptions): FetchText {
  const base = o.fetchText ?? timedFetchText({ what: o.what, timeoutMs: o.timeoutMs ?? LIST_TIMEOUT_MS, maxBytes: LIST_MAX_BYTES, headers: { accept: "application/json", ...o.headers } });
  const counted: FetchText = o.onRequest
    ? async (url) => {
        o.onRequest?.();
        return base(url);
      }
    : base;
  if (o.fetchText && o.retries === undefined) return counted;
  const log = o.log ?? ((line: string) => console.log(line));
  const label = o.what.toLowerCase();
  return retryingFetchText(counted, {
    retries: o.retries ?? 2,
    ...(o.retryBaseMs !== undefined ? { baseMs: o.retryBaseMs } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
    onRetry: ({ url, attempt, retries, error, waitMs }) => {
      const why = error instanceof Error ? error.message : String(error);
      let path = "";
      try {
        path = new URL(url).pathname;
      } catch {
        // not a URL: log no path
      }
      log(`[${label}] retry ${attempt}/${retries} after ${why} (waiting ${waitMs} ms): ${path}`);
    },
  });
}
