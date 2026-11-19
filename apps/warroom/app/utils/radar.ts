// The Radar page (trend radar ticket 01): what GET /api/radar sends, turned into the text the page shows. Every term, headline, token name and
// reason is third-party text: it is cut to one line, shown as text, and a link is built only through safeHttpUrl.
import { ageText, clampText, fmtUsd } from "./meta.ts";
import { safeHttpUrl } from "./safe-link.ts";

export const RADAR_POLL_MS = 60_000;
/** A term, a headline and a token name on a row, in characters. */
export const TERM_CLAMP = 120;
export const NEWS_CLAMP = 160;
export const TOKEN_CLAMP = 50;
export const REASON_CLAMP = 120;
/** Lookalikes listed on a row before "and N more". */
export const LOOKALIKES_SHOWN = 5;

export type TrendSide = "unchecked" | "not traced" | "taken" | "contested" | "tokenizing" | "untokenized";
export type SourceStatus = "ok" | "backing off" | "format changed" | "down";

export interface RadarPayloadToken {
  name: string;
  symbol: string;
  url: string;
  marketCapUsd: number | null;
  liquidityUsd: number;
}

export interface RadarPayloadTrend {
  id: number;
  term: string;
  firstSeen: string;
  lastSeen: string;
  score: number;
  side: TrendSide;
  sideAt: string | null;
  trafficText: string;
  trafficMin: number;
  newsTitle: string;
  newsUrl: string;
  lastChecked: string | null;
  localCreates: number | null;
  localCreators: number | null;
  traceAt: string | null;
  liveCount: number;
  biggest: RadarPayloadToken | null;
  lookalikes: Array<RadarPayloadToken & { reason: string }>;
  lookalikeCount: number;
}

export interface RadarPayloadSource {
  source: string;
  status: SourceStatus;
  reason: string;
  lastOk: string | null;
  since: string;
}

export interface RadarPayloadAlert {
  source: string;
  status: Exclude<SourceStatus, "ok">;
  reason: string;
  since: string;
  lastOk: string | null;
}

export interface RadarPayload {
  enabled: boolean;
  trends: RadarPayloadTrend[];
  sources: RadarPayloadSource[];
  alerts: RadarPayloadAlert[];
  lastGoodPollAt: string | null;
  counts: { shown: number; untokenized: number };
}

export interface RadarStripPayload {
  enabled: boolean;
  shown: number;
  untokenized: number;
  alerts: RadarPayloadAlert[];
}

export interface RadarRowView {
  key: string;
  term: string;
  traffic: string;
  seen: string;
  side: TrendSide;
  sideLabel: string;
  tone: "green" | "amber" | "muted" | "red";
  /** The coin-side line: the biggest live token, or that there is none. */
  coinLine: string;
  /** Said after the coin line when the last check failed: how old the trace is. */
  coinNote: string | null;
  /** The link to the biggest live token's DexScreener page; null unless it is a plain http(s) address. */
  tokenHref: string | null;
  lookalikes: Array<{ key: string; text: string }>;
  lookalikesMore: string | null;
  createsLine: string;
  news: { title: string; href: string | null } | null;
  checked: string;
}

export interface RadarGroupView {
  key: "open" | "folded";
  /** Set for the folded group, which is shown under a `details`. */
  title: string | null;
  rows: RadarRowView[];
}

export interface RadarSourceView {
  key: string;
  label: string;
  text: string;
  tone: "green" | "amber";
}

export interface RadarPageView {
  groups: RadarGroupView[];
  /** The banners: sources not ok for more than an hour. */
  alerts: string[];
  sources: RadarSourceView[];
  /** Why the list is empty, or null when it has rows. */
  empty: string | null;
  /** One line over the list: how many are shown and how many are untokenized, or null. */
  summary: string | null;
  lastGood: string;
}

const SIDE_LABEL: Record<TrendSide, string> = {
  unchecked: "Not checked yet",
  "not traced": "Not traced",
  taken: "Taken",
  contested: "Contested",
  tokenizing: "Tokenizing",
  untokenized: "Untokenized",
};
const SIDE_TONE: Record<TrendSide, RadarRowView["tone"]> = { unchecked: "muted", "not traced": "red", taken: "muted", contested: "amber", tokenizing: "amber", untokenized: "green" };
const FOLDED: readonly TrendSide[] = ["taken", "tokenizing"];
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
const when = (iso: string | null, nowMs: number): string | null => (iso === null ? null : ageText(iso, nowMs));

/** "Google Trends (US)" from `radar:google:US`; any other name is cleaned and shown as it is. */
export function sourceLabel(source: string): string {
  const parts = String(source).split(":");
  if (parts[0] === "radar" && parts[1] === "google" && /^[A-Z]{2}$/.test(parts[2] ?? "")) return `Google Trends (${parts[2]})`;
  return clampText(source, 40);
}

/** The banner text for one source that has been not ok for more than an hour. */
export function alertText(a: RadarPayloadAlert, nowMs: number): string {
  const since = when(a.since, nowMs);
  const good = when(a.lastOk, nowMs);
  return `${sourceLabel(a.source)} is ${a.status}${since ? ` since ${since}` : ""}${a.reason ? ` (${clampText(a.reason, 80)})` : ""}. Last good poll: ${good ?? "none yet"}.`;
}

function tokenText(t: RadarPayloadToken): string {
  const name = clampText(t.name, TOKEN_CLAMP) || "unnamed";
  const symbol = clampText(t.symbol, 20);
  return `${name}${symbol ? ` ($${symbol})` : ""}${finite(t.marketCapUsd) ? ` at ${fmtUsd(t.marketCapUsd)}` : ""}`;
}

function rowView(t: RadarPayloadTrend, nowMs: number): RadarRowView {
  const lookalikes = (Array.isArray(t.lookalikes) ? t.lookalikes : []).slice(0, LOOKALIKES_SHOWN).map((l, i) => ({ key: `${t.id}-${i}`, text: `${tokenText(l)}: ${clampText(l.reason, REASON_CLAMP)}` }));
  const hidden = Math.max(0, (finite(t.lookalikeCount) ? t.lookalikeCount : lookalikes.length) - lookalikes.length);
  const traced = t.traceAt !== null;
  let coinLine: string;
  if (t.biggest) coinLine = `Biggest live token: ${tokenText(t.biggest)}${t.liveCount > 1 ? ` (${t.liveCount} live)` : ""}`;
  else if (!traced) coinLine = "No search has answered yet.";
  else coinLine = "No live token found.";
  const coinNote = t.side === "not traced" && traced ? `As of the last good check, ${when(t.traceAt, nowMs) ?? "earlier"}.` : null;
  const news = clampText(t.newsTitle, NEWS_CLAMP);
  const checked = when(t.lastChecked, nowMs);
  return {
    key: String(Math.trunc(Number(t.id))),
    term: clampText(t.term, TERM_CLAMP),
    traffic: t.trafficText ? `${clampText(t.trafficText, 20)} searches` : "traffic n/a",
    seen: `first seen ${when(t.firstSeen, nowMs) ?? "at an unknown time"}`,
    side: t.side,
    sideLabel: SIDE_LABEL[t.side] ?? "Not traced",
    tone: SIDE_TONE[t.side] ?? "red",
    coinLine,
    coinNote,
    tokenHref: t.biggest ? safeHttpUrl(t.biggest.url) : null,
    lookalikes,
    lookalikesMore: hidden > 0 ? `and ${plural(hidden, "more lookalike")}` : null,
    createsLine:
      t.localCreates === null || t.localCreators === null
        ? "Local creates not read yet; local creates are a partial view."
        : `${plural(t.localCreates, "create")} in 48 h by ${plural(t.localCreators, "creator")}; local creates are a partial view.`,
    news: news ? { title: news, href: safeHttpUrl(t.newsUrl) } : null,
    checked: checked ? `checked ${checked}` : "not checked yet",
  };
}

/** The page's view of the API payload. `nowMs` is 0 until mounted (absolute UTC text, the same on the server and the client). */
export function radarPageView(payload: RadarPayload | null | undefined, nowMs: number): RadarPageView {
  if (!payload) return { groups: [], alerts: [], sources: [], empty: "The Radar list could not be loaded.", summary: null, lastGood: "" };
  const trends = Array.isArray(payload.trends) ? payload.trends : [];
  const rows = trends.map((t) => rowView(t, nowMs));
  const open = rows.filter((r) => !FOLDED.includes(r.side));
  const folded = rows.filter((r) => FOLDED.includes(r.side));
  const groups: RadarGroupView[] = [];
  if (open.length > 0) groups.push({ key: "open", title: null, rows: open });
  if (folded.length > 0) groups.push({ key: "folded", title: `Already has a coin or is being tokenized (${folded.length})`, rows: folded });
  const rawSources = Array.isArray(payload.sources) ? payload.sources : [];
  const sources = rawSources.map((s): RadarSourceView => {
    const good = when(s.lastOk, nowMs);
    const since = when(s.since, nowMs);
    return {
      key: String(s.source),
      label: sourceLabel(s.source),
      tone: s.status === "ok" ? "green" : "amber",
      text: `${s.status}${s.status !== "ok" && since ? ` since ${since}` : ""}${s.status !== "ok" && s.reason ? ` (${clampText(s.reason, 80)})` : ""}; last good poll ${good ?? "none yet"}`,
    };
  });
  const alerts = (Array.isArray(payload.alerts) ? payload.alerts : []).map((a) => alertText(a, nowMs));
  let empty: string | null = null;
  if (rows.length === 0) {
    if (!payload.enabled && sources.length === 0) empty = "The trend radar is off. The worker polls only when ARGUS_RADAR=1.";
    else if (sources.length === 0) empty = "No poll yet. The worker polls every 15 minutes once it is on.";
    else if (rawSources.some((s) => s.status !== "ok")) empty = "Nothing to list: a source is not answering (see the sources below). An empty answer is never read as no trends.";
    else empty = "No new rising term in the last 24 hours with 1,000 or more searches.";
  }
  const counts = payload.counts ?? { shown: rows.length, untokenized: 0 };
  return {
    groups,
    alerts,
    sources,
    empty,
    summary: rows.length === 0 ? null : `${plural(counts.shown, "Trend")} shown, ${counts.untokenized} untokenized.`,
    lastGood: when(payload.lastGoodPollAt, nowMs) ?? "none yet",
  };
}

export interface RadarStripView {
  text: string;
  alerts: string[];
}

/** The one-line strip on `/`; null while there is nothing to say (the radar is off and has no Trend and no alert). */
export function radarStripView(payload: RadarStripPayload | null | undefined, nowMs: number): RadarStripView | null {
  if (!payload) return null;
  const alerts = (Array.isArray(payload.alerts) ? payload.alerts : []).map((a) => alertText(a, nowMs));
  if (!payload.enabled && payload.shown === 0 && alerts.length === 0) return null;
  return { text: `Radar: ${plural(payload.shown, "Trend")} shown, ${payload.untokenized} untokenized.`, alerts };
}
