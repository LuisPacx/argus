import { timedFetchText, type FetchText } from "./http.ts";
import { safeUrl, stripHtml } from "./rss.ts";
import type { Signal, Source } from "./source.ts";

/** GitHub's public search API, unauthenticated: 10 requests a minute per IP (ADR 0008). One poll is one request. */
const API_BASE = "https://api.github.com/search/repositories";
const API_TIMEOUT_MS = 10_000;
const API_MAX_BYTES = 2 * 1024 * 1024;
/** "Trending" is: created within this many days, most starred first. */
const WINDOW_DAYS = 7;
const PER_PAGE = 30;
const MAX_NAME_CHARS = 140;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_SUMMARY_CHARS = 1_000;
// Repo names come out of a remote response and go into an id: only plain owner/name tokens are used.
const NAME_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

export interface GitHubTrendingOptions {
  /** Replaces the network fetch (tests pass recorded JSON). */
  fetchText?: FetchText;
  baseUrl?: string;
  timeoutMs?: number;
  now?: () => Date;
  /** Where a layout change is reported besides the thrown error. */
  log?: (message: string) => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === "string" ? stripHtml(v).trim().slice(0, max) : "");
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const fmt = (n: number) => n.toLocaleString("en-US");

/** Repos created in the last week with the most stars, from the public GitHub search API, one Signal per repo. */
export class GitHubTrendingSource implements Source {
  readonly id = "github:trending";
  readonly label = "GitHub trending";
  private readonly fetchText: FetchText;
  private readonly baseUrl: string;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(opts: GitHubTrendingOptions = {}) {
    this.baseUrl = opts.baseUrl ?? API_BASE;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? console.error;
    this.fetchText =
      opts.fetchText ??
      timedFetchText({
        what: "GitHub",
        timeoutMs: opts.timeoutMs ?? API_TIMEOUT_MS,
        maxBytes: API_MAX_BYTES,
        headers: { accept: "application/vnd.github+json", "user-agent": "argus-ingest", "x-github-api-version": "2022-11-28" },
      });
  }

  async poll(): Promise<Signal[]> {
    const since = new Date(this.now().getTime() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    const query = new URLSearchParams({ q: `created:>${since}`, sort: "stars", order: "desc", per_page: String(PER_PAGE) });
    const body = await this.fetchText(`${this.baseUrl}?${query}`);
    try {
      return this.parse(body);
    } catch (err) {
      this.log(`[github-trending] layout check failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  private parse(body: string): Signal[] {
    const data = JSON.parse(body) as unknown;
    if (!isRecord(data) || !Array.isArray(data.items)) throw new Error("GitHub: unexpected search response (no items array)");
    const items = data.items.slice(0, PER_PAGE);
    const signals: Signal[] = [];
    for (const item of items) {
      if (!isRecord(item)) continue;
      const name = str(item.full_name, MAX_NAME_CHARS);
      if (!NAME_RE.test(name)) continue;
      const created = typeof item.created_at === "string" ? new Date(item.created_at) : undefined;
      const language = str(item.language, 40);
      const description = str(item.description, MAX_DESCRIPTION_CHARS);
      const facts = [`${fmt(count(item.stargazers_count))} stars`, `${fmt(count(item.forks_count))} forks`, ...(language ? [language] : [])].join(", ");
      signals.push({
        id: `${this.id}:${name.toLowerCase()}`,
        sourceId: this.id,
        sourceLabel: this.label,
        title: name,
        summary: `New on GitHub, ${facts}.${description ? ` ${description}` : ""}`.slice(0, MAX_SUMMARY_CHARS),
        url: safeUrl(str(item.html_url, 2_001)),
        publishedAt: created && !Number.isNaN(created.getTime()) ? created.toISOString() : new Date(0).toISOString(),
      });
    }
    // Entries were returned but none could be read: the field names changed. An honest empty result has no entries.
    if (items.length > 0 && signals.length === 0) throw new Error(`GitHub: none of ${items.length} search results could be read (layout change?)`);
    return signals;
  }
}
