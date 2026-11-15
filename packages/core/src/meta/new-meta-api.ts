import { flat } from "../context-block.ts";
import type { Datastore } from "../datastore.ts";
import { currentApiRow, type CurrentMetaApiRow, type NewMetaMark } from "./api.ts";
import { META_RULE, type MetaConfig } from "./config.ts";
import { newsForKeys } from "./news.ts";

/**
 * The read-only New Meta API (meta redesign ticket 03, replaces Hot now): the live events with what the Operator needs to judge one at a
 * glance, so the page computes nothing. An event is live for `newMetaLiveHours` after it was raised. Its subject must still be a Meta in
 * the newest run: one that has fallen out has nothing current to show, and is left out of the panel (its stored event stays for later
 * readers). Every string is creator-written, third-party or model text and travels as JSON text only; it is never markup.
 */

/** Most events shown (there are at most `maxMetas` Metas). */
export const NEW_META_MAX = 5;
const TITLE_CHARS = 200;
const LABEL_CHARS = 60;
const REASON_CHARS = 160;

export interface NewMetaNewsItem {
  title: string;
  sourceLabel: string;
  /** http(s) or empty as the Source stored it; the page links it only through `safeHttpUrl`. */
  url: string;
  publishedAt: string;
}

export interface NewMetaItem {
  reason: string;
  raisedAt: string;
  /** The Meta as the Current Meta shows it: label, summary, leader and cap, top tokens, counts (migrations unfiltered and after 60 s). */
  meta: CurrentMetaApiRow;
  /** Matching news, context only, newest first. */
  news: NewMetaNewsItem[];
}

export interface NewMetasResponse {
  /** The run the Metas come from; null before the first run. */
  computedAt: string | null;
  items: NewMetaItem[];
}

/** The live events by group key, newest per key. */
export function liveNewMetas(store: Pick<Datastore, "newMetaEvents">, now: Date, config: Pick<MetaConfig, "newMetaLiveHours"> = META_RULE): Map<string, NewMetaMark> {
  const out = new Map<string, NewMetaMark>();
  for (const e of store.newMetaEvents(new Date(now.getTime() - config.newMetaLiveHours * 3_600_000).toISOString())) {
    if (!out.has(e.key)) out.set(e.key, { reason: flat(e.reason, REASON_CHARS), raisedAt: e.raisedAt });
  }
  return out;
}

export function newMetasResponse(store: Pick<Datastore, "currentMetas" | "newMetaEvents" | "contextHeadlines" | "metaSummaries">, now: Date, config: MetaConfig = META_RULE): NewMetasResponse {
  const current = store.currentMetas();
  if (!current) return { computedAt: null, items: [] };
  const live = liveNewMetas(store, now, config);
  const shown = current.metas.filter((m) => live.has(m.key)).slice(0, NEW_META_MAX);
  const news = newsForKeys(store, shown.map((m) => m.key), now, config);
  const records = store.metaSummaries(shown.map((m) => m.key));
  return {
    computedAt: current.computedAt,
    items: shown.map((m) => {
      const mark = live.get(m.key) as NewMetaMark;
      return {
        reason: mark.reason,
        raisedAt: mark.raisedAt,
        meta: currentApiRow(m, true, records.get(m.key), now.getTime()),
        news: (news.get(m.key) ?? []).map((n) => ({ title: flat(n.title, TITLE_CHARS), sourceLabel: flat(n.sourceLabel, LABEL_CHARS), url: n.url, publishedAt: n.publishedAt })),
      };
    }),
  };
}
