// What the home page's "Hot now" panel shows (missed ideas ticket 03). The trigger, the ranking row and the matching news all come from the
// worker through GET /api/hot-metas; this file only turns that payload into display text. Every string in it is creator-written (the label,
// the token names), third-party (the headlines) or model text (the summary): it is cut here and rendered as text only, and a link exists only
// where `safeHttpUrl` accepted the URL.
import { ageText, clampText, metaAnchor, tokenViews, type MetaPayloadCounts, type MetaPayloadToken, type MetaTokenView } from "./meta.ts";
import { safeHttpUrl } from "./safe-link.ts";

/** The panel refreshes at the Meta strip's pace: the worker raises events when it ranks, every 15 minutes at most. */
export const HOT_POLL_MS = 60_000;

const LABEL_CHARS = 60;
const SUMMARY_CHARS = 200;
const REASON_CHARS = 80;
const HEADLINE_CHARS = 160;
const SOURCE_CHARS = 40;
const NEWS_SHOWN = 5;

/** The part of GET /api/hot-metas the panel reads (the server's `HotNowResponse`; a field renamed there is a type error in the server test). */
export interface HotPayload {
  computedAt: string | null;
  items: Array<{
    reason: string;
    raisedAt: string;
    meta: {
      label: string;
      summary: string;
      counts: { "6h": MetaPayloadCounts; "24h": MetaPayloadCounts };
      topTokens: MetaPayloadToken[];
    };
    news: Array<{ title: string; sourceLabel: string; url: string; publishedAt: string }>;
  }>;
}

export interface HotNewsView {
  /** The headline, cut. */
  title: string;
  /** "Wired, 3 hours ago". */
  meta: string;
  href: string | null;
}

export interface HotItemView {
  label: string;
  /** The `/meta#` fragment of the Meta's row. */
  anchor: string;
  /** "entered top 5" or "creators 70 to 148 in 1 h". */
  reason: string;
  /** "raised 12 minutes ago"; null when the time is not a date. */
  raised: string | null;
  summary: string | null;
  /** "148 creators", "256 tokens", "31 migrations (unfiltered)", "12 after 60 s": the 24 h counts the ranking is made of. */
  numbers: string[];
  tokens: MetaTokenView[];
  news: HotNewsView[];
}

export interface HotView {
  items: HotItemView[];
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

export function hotView(payload: HotPayload | null | undefined, nowMs: number): HotView {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return {
    items: items.flatMap((it): HotItemView[] => {
      const label = clampText(it?.meta?.label, LABEL_CHARS);
      if (label === "") return [];
      const c = it.meta.counts?.["24h"];
      const numbers: string[] = [];
      if (finite(c?.creators)) numbers.push(plural(c.creators, "creator"));
      if (finite(c?.tokens)) numbers.push(plural(c.tokens, "token"));
      if (finite(c?.migrations)) numbers.push(`${plural(c.migrations, "migration")} (unfiltered)`);
      if (finite(c?.migrationsAfter60s)) numbers.push(`${c.migrationsAfter60s} after 60 s`);
      const age = typeof it.raisedAt === "string" ? ageText(it.raisedAt, nowMs) : null;
      const news = (Array.isArray(it.news) ? it.news : []).slice(0, NEWS_SHOWN).flatMap((n): HotNewsView[] => {
        const title = clampText(n?.title, HEADLINE_CHARS);
        if (title === "") return [];
        const source = clampText(n.sourceLabel, SOURCE_CHARS);
        const when = typeof n.publishedAt === "string" ? ageText(n.publishedAt, nowMs) : null;
        return [{ title, meta: [source, when].filter((s): s is string => s !== null && s !== "").join(", "), href: safeHttpUrl(n.url) }];
      });
      return [
        {
          label,
          anchor: metaAnchor(label),
          reason: clampText(it.reason, REASON_CHARS),
          raised: age === null ? null : age === "just now" ? "raised just now" : `raised ${age}`,
          summary: clampText(it.meta.summary, SUMMARY_CHARS) || null,
          numbers,
          tokens: tokenViews(it.meta.topTokens),
          news,
        },
      ];
    }),
  };
}
