import { flat } from "../context-block.ts";
import type { Datastore } from "../datastore.ts";
import { apiRow, type HotMark, type MetaApiRow } from "./api.ts";
import { META_RULE, type MetaConfig } from "./config.ts";
import { newsForKeys } from "./news.ts";

/**
 * The read-only Hot now API (missed ideas ticket 03): the live events with what the Operator needs to judge one at a glance, so the page
 * computes nothing. An event is live for `hotCooldownHours` after it was raised. Its Meta must still be in the newest 24 h ranking: one
 * that has dropped out of it has nothing current to show, and is left out of the panel (its stored event stays for later readers).
 * Every string is creator-written, third-party or model text and travels as JSON text only; it is never markup.
 */

/** Most events shown. */
export const HOT_NOW_MAX = 5;
const TITLE_CHARS = 200;
const LABEL_CHARS = 60;

export interface HotNewsItem {
  title: string;
  sourceLabel: string;
  /** http(s) or empty as the Source stored it; the page links it only through `safeHttpUrl`. */
  url: string;
  publishedAt: string;
}

export interface HotNowItem {
  reason: string;
  raisedAt: string;
  /** The Meta as the ranking shows it: label, summary, top tokens, migrations (unfiltered and after 60 s). */
  meta: MetaApiRow;
  /** Matching news, context only, newest first. */
  news: HotNewsItem[];
}

export interface HotNowResponse {
  /** The ranking run the Metas come from; null before the first run. */
  computedAt: string | null;
  items: HotNowItem[];
}

/** The live events by group key, newest per key. */
export function liveHot(store: Pick<Datastore, "hotMetaEvents">, now: Date, config: MetaConfig = META_RULE): Map<string, HotMark> {
  const out = new Map<string, HotMark>();
  for (const e of store.hotMetaEvents(new Date(now.getTime() - config.hotCooldownHours * 3_600_000).toISOString())) {
    if (!out.has(e.key)) out.set(e.key, { reason: e.reason, raisedAt: e.raisedAt });
  }
  return out;
}

export function hotNowResponse(store: Pick<Datastore, "latestMetas" | "hotMetaEvents" | "contextHeadlines">, now: Date, config: MetaConfig = META_RULE): HotNowResponse {
  const run = store.latestMetas("24h", 200);
  if (!run) return { computedAt: null, items: [] };
  const live = liveHot(store, now, config);
  const rows = run.rows.filter((r) => live.has(r.key)).slice(0, HOT_NOW_MAX);
  const news = newsForKeys(store, rows.map((r) => r.key), now, config);
  return {
    computedAt: run.computedAt,
    items: rows.map((r) => {
      const mark = live.get(r.key) as HotMark;
      return {
        reason: mark.reason,
        raisedAt: mark.raisedAt,
        meta: apiRow(r),
        news: (news.get(r.key) ?? []).map((n) => ({ title: flat(n.title, TITLE_CHARS), sourceLabel: flat(n.sourceLabel, LABEL_CHARS), url: n.url, publishedAt: n.publishedAt })),
      };
    }),
  };
}
