import { slugify } from "./datastore.ts";
import { DexScreenerClient, type DexPair } from "./sources/dexscreener.ts";
import { GITHUB_API_HEADERS, GITHUB_SEARCH_URL } from "./sources/github-trending.ts";
import { HttpError, timedFetchText, type FetchText } from "./sources/http.ts";

/**
 * `clear` is only ever said after a lookup that answered and found nothing. Anything that stops a lookup (a timeout, a rate limit,
 * an error, an answer in a shape we do not know, a wait still running after a rate limit) is `unknown`, never `clear`.
 */
export type CollisionStatus = "clear" | "collides" | "unknown";

/** One check's outcome, stored with the Proposal. `checkedAt` is when the check ran (or was attempted), `source` who was asked. */
export interface CollisionCheck {
  status: CollisionStatus;
  /** One line: what matched, or why the check could not say. */
  detail: string;
  source: string;
  checkedAt: string;
}

export interface CollisionResult {
  /** DexScreener, by token name and ticker. */
  dex: CollisionCheck;
  /** GitHub, by the repo name the Build would use (the slug of the name). */
  github: CollisionCheck;
}

export interface CollisionChecker {
  check(fields: { name: string; ticker: string }): Promise<CollisionResult>;
}

export const DEX_SOURCE = "DexScreener";
export const GITHUB_SOURCE = "GitHub";

/** The whole of one check (every request in it) is cut off after this long. */
export const COLLISION_TIMEOUT_MS = 15_000;
const MAX_DETAIL_CHARS = 200;
const GITHUB_PER_PAGE = 100;
/** Above these the name (a model's answer is at most 40 and 10 characters) is not put in a search. GitHub repo names are at most 100. */
const MAX_NAME_QUERY_CHARS = 100;
const MAX_TICKER_QUERY_CHARS = 30;
const MAX_REPO_NAME_CHARS = 100;

export interface CollisionCheckerOptions {
  /** Replace the network (tests pass recorded JSON). */
  dexFetchText?: FetchText;
  githubFetchText?: FetchText;
  /** Replace the API roots (tests point them at a dead loopback port). */
  dexBaseUrl?: string;
  githubUrl?: string;
  timeoutMs?: number;
  now?: () => Date;
}

/** BackoffSource's rule for a lookup that is not a Source: after a failure, leave the API alone for a doubling wait (or its Retry-After). */
class Cooldown {
  private failures = 0;
  private blockedUntil = 0;
  private readonly baseMs: number;
  private readonly maxMs: number;
  constructor(baseMs: number, maxMs: number) {
    this.baseMs = baseMs;
    this.maxMs = maxMs;
  }
  /** Milliseconds still to wait, 0 when the API may be asked. */
  remaining(nowMs: number): number {
    return Math.max(0, this.blockedUntil - nowMs);
  }
  failed(nowMs: number, e: unknown): void {
    this.failures++;
    const exponential = this.baseMs * 2 ** Math.min(this.failures - 1, 20);
    const asked = e instanceof HttpError ? (e.retryAfterMs ?? 0) : 0;
    this.blockedUntil = nowMs + Math.min(Math.max(exponential, asked), this.maxMs);
  }
  succeeded(): void {
    this.failures = 0;
  }
}

const normal = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL_CHARS);

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const cut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, cut]).finally(() => clearTimeout(timer));
}

/** Why a lookup produced no answer, in words. */
function failureWords(e: unknown): string {
  if (e instanceof HttpError) return e.status === 403 || e.status === 429 ? `rate-limited (HTTP ${e.status})` : `HTTP ${e.status}`;
  const m = e instanceof Error ? e.message : String(e);
  return /timed out/i.test(m) ? "timed out" : `error: ${oneLine(m)}`;
}

/**
 * The collision checks (architecture section 8): DexScreener by name and by ticker, GitHub by the repo name. Both are keyless public
 * APIs reached through the shared bounded fetch, so a body is size-capped and a request time-limited, and the whole check is cut off
 * at `timeoutMs`. Each side backs off after a failure like `BackoffSource`; while it waits the check is `unknown` and sends nothing.
 * A match is reported even when another request of the same side failed; "clear" needs every request to have answered.
 */
export function createCollisionChecker(opts: CollisionCheckerOptions = {}): CollisionChecker {
  const timeoutMs = opts.timeoutMs ?? COLLISION_TIMEOUT_MS;
  const now = opts.now ?? (() => new Date());
  const dex = new DexScreenerClient({ fetchText: opts.dexFetchText, baseUrl: opts.dexBaseUrl, timeoutMs });
  const githubFetch =
    opts.githubFetchText ?? timedFetchText({ what: "GitHub", timeoutMs, maxBytes: 2 * 1024 * 1024, headers: GITHUB_API_HEADERS });
  const githubUrl = opts.githubUrl ?? GITHUB_SEARCH_URL;
  const dexWait = new Cooldown(30_000, 15 * 60_000);
  const githubWait = new Cooldown(60_000, 60 * 60_000);

  /** Runs `lookup` unless the side is backing off; whatever it throws becomes `unknown`. */
  async function guarded(source: string, wait: Cooldown, lookup: () => Promise<{ status: CollisionStatus; detail: string } | { failed: unknown }>): Promise<CollisionCheck> {
    const at = now();
    const base = { source, checkedAt: at.toISOString() };
    const left = wait.remaining(at.getTime());
    if (left > 0) return { ...base, status: "unknown", detail: `backing off after an earlier failure, about ${Math.ceil(left / 1000)} s to go` };
    try {
      const r = await withTimeout(lookup(), timeoutMs);
      if ("failed" in r) {
        wait.failed(at.getTime(), r.failed);
        return { ...base, status: "unknown", detail: failureWords(r.failed) };
      }
      wait.succeeded();
      return { ...base, status: r.status, detail: r.detail };
    } catch (e) {
      wait.failed(at.getTime(), e);
      return { ...base, status: "unknown", detail: failureWords(e) };
    }
  }

  const dexCheck = (name: string, ticker: string) =>
    guarded(DEX_SOURCE, dexWait, async () => {
      // A shortened query could return unrelated pairs and read as clear, so an over-long name or ticker is not searched at all.
      if (name.length > MAX_NAME_QUERY_CHARS || ticker.length > MAX_TICKER_QUERY_CHARS) return { status: "unknown" as const, detail: "the name or ticker is too long to search for" };
      const searches = await Promise.allSettled([dex.search(name), dex.search(ticker)]);
      const pairs: DexPair[] = searches.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
      const sameTicker = pairs.find((p) => p.symbol.toLowerCase() === ticker.toLowerCase());
      if (sameTicker) return { status: "collides" as const, detail: oneLine(`ticker ${ticker} is already $${sameTicker.symbol} (${sameTicker.name}) on ${sameTicker.chainId}${sameTicker.url ? ` ${sameTicker.url}` : ""}`) };
      const sameName = pairs.find((p) => normal(p.name) !== "" && normal(p.name) === normal(name));
      if (sameName) return { status: "collides" as const, detail: oneLine(`name "${name}" is already ${sameName.name} ($${sameName.symbol}) on ${sameName.chainId}${sameName.url ? ` ${sameName.url}` : ""}`) };
      const rejected = searches.find((s): s is PromiseRejectedResult => s.status === "rejected");
      if (rejected) return { failed: rejected.reason as unknown };
      return { status: "clear" as const, detail: "no token with this name or ticker found" };
    });

  const githubCheck = (name: string) =>
    guarded(GITHUB_SOURCE, githubWait, async () => {
      const slug = slugify(name);
      if (!slug) return { status: "unknown" as const, detail: "the name has no letters or digits to make a repo name from" };
      if (slug.length > MAX_REPO_NAME_CHARS) return { status: "unknown" as const, detail: "the repo name is too long to search for" };
      const q = new URLSearchParams({ q: `${slug} in:name fork:true`, per_page: String(GITHUB_PER_PAGE) });
      const data = JSON.parse(await githubFetch(`${githubUrl}?${q}`)) as unknown;
      const items = typeof data === "object" && data !== null && "items" in data ? (data as { items: unknown }).items : undefined;
      if (!Array.isArray(items)) throw new Error("unexpected search response (no items array)");
      for (const item of items) {
        const full = typeof item === "object" && item !== null ? (item as { full_name?: unknown }).full_name : undefined;
        if (typeof full !== "string") continue;
        const repo = full.split("/")[1] ?? "";
        if (repo.toLowerCase() === slug) return { status: "collides" as const, detail: oneLine(`a repo named ${slug} exists: ${full}`) };
      }
      // No match on page 1 is "clear" only when page 1 was the whole answer. Search matches names loosely and ranks by best match, so an
      // exact-name repo can sit beyond the first page, and `incomplete_results` says GitHub itself did not finish the search.
      const total = (data as { total_count?: unknown }).total_count;
      if (typeof total !== "number" || !Number.isFinite(total)) throw new Error("unexpected search response (no total_count)");
      if ((data as { incomplete_results?: unknown }).incomplete_results !== false) return { status: "unknown" as const, detail: "GitHub reports incomplete search results and none matches" };
      if (total > items.length) return { status: "unknown" as const, detail: `no exact match on the first page, but ${total} repos have the name in them; not checked past the first page` };
      return { status: "clear" as const, detail: `no repo named ${slug} found` };
    });

  return {
    async check({ name, ticker }) {
      const [dexResult, githubResult] = await Promise.all([dexCheck(name, ticker), githubCheck(name)]);
      return { dex: dexResult, github: githubResult };
    },
  };
}

export function hasCollision(r: CollisionResult): boolean {
  return r.dex.status === "collides" || r.github.status === "collides";
}

/** One line for a card or a notice. An unknown is worded as "unknown, not checked", so it cannot be read as clear. */
export function describeCollision(c: CollisionCheck): string {
  if (c.status === "clear") return `clear (${c.source}, ${c.checkedAt})`;
  if (c.status === "collides") return `collides: ${c.detail} (${c.source}, ${c.checkedAt})`;
  return `unknown, could not be checked: ${c.detail} (${c.source}, ${c.checkedAt})`;
}
