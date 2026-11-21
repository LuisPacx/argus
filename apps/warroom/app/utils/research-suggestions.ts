// Radar suggestions on /research (human researcher ticket 07): the live Trends from GET /api/radar as a list of topics to research. A suggestion only
// carries text; picking one fills the topic box and nothing else. Every term is third-party: cut to one line (and to the topic box's length) here.
import { clampText } from "./meta.ts";
import type { RadarPayload } from "./radar.ts";
import { RESEARCH_TOPIC_MAX_CHARS } from "./research-brief.ts";

export const SUGGESTIONS_SHOWN = 12;
const SOURCES_CLAMP = 80;

export interface SuggestionView {
  key: string;
  /** What the topic box is set to: the Trend's plain subject, one line, at most the topic box's length. */
  topic: string;
  score: number;
  /** "Google Trends (US, GB) and 3 news feeds", or "". */
  sources: string;
}

export interface SuggestionsView {
  rows: SuggestionView[];
  /** Said when there is no Trend to list, else null. */
  empty: string | null;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** The live named Trends, newest first (first seen), with their score and sources. */
export function suggestionsView(payload: Pick<RadarPayload, "trends"> | null | undefined): SuggestionsView {
  const trends = Array.isArray(payload?.trends) ? payload.trends : [];
  const rows = trends
    .filter((t) => clampText(t.term, RESEARCH_TOPIC_MAX_CHARS) !== "")
    .sort((a, b) => (Date.parse(b.firstSeen) || 0) - (Date.parse(a.firstSeen) || 0))
    .slice(0, SUGGESTIONS_SHOWN)
    .map((t): SuggestionView => {
      const geos = (Array.isArray(t.why?.geos) ? t.why.geos : []).map((g) => clampText(g, 4)).filter(Boolean);
      const feeds = Array.isArray(t.why?.feeds) ? t.why.feeds.length : 0;
      const bits: string[] = [];
      if (geos.length > 0) bits.push(`Google Trends (${geos.join(", ")})`);
      if (feeds > 0) bits.push(plural(feeds, "news feed"));
      return {
        key: String(Math.trunc(Number(t.id))),
        topic: clampText(t.term, RESEARCH_TOPIC_MAX_CHARS),
        score: Number.isFinite(t.score) ? Math.trunc(t.score) : 0,
        sources: clampText(bits.join(" and "), SOURCES_CLAMP),
      };
    });
  return { rows, empty: rows.length === 0 ? "no Trends right now" : null };
}
