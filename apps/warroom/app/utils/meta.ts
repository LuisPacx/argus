// What the home page's "Current Meta (last 24h)" section shows. The ranking, the grouping and the summary line all come from the
// worker through GET /api/metas; this file only turns that payload into display text. Every string in the payload is creator-written
// or model text: it is cut here and rendered as text only, and a link exists only where `safeHttpUrl` accepted the URL.
import { fmtUtc } from "./format.ts";
import { safeHttpUrl } from "./safe-link.ts";
import { ideaViews, type MetaIdeaPayload, type MetaIdeaView } from "./meme.ts";
import { angleStatusFor, type AngleRequestPayload, type AngleStatusView } from "./angle.ts";

/** The page refreshes the ranking this often (the worker computes it every 15 minutes at most), not with the 3-second list poll. */
export const META_POLL_MS = 60_000;
/** A stored run older than this is called stale. */
export const META_STALE_MS = 2 * 3_600_000;
/** Rows shown. */
export const META_ROWS = 5;
/**
 * The trend word, from the share of the last 24 h's launches that fell in the last 6 h. An even rate is 0.25. At or above `accelerating`
 * the Meta is speeding up; at or below `fading` it has slowed; between, steady.
 */
export const META_TREND = { accelerating: 0.4, fading: 0.15 } as const;

const LABEL_CHARS = 60;
const TOKEN_NAME_CHARS = 30;
const TICKER_CHARS = 12;
const SUMMARY_CHARS = 200;
const COVERAGE_NOTE_CHARS = 80;
const NEW_META_REASON_CHARS = 120;

export interface MetaPayloadCounts {
  tokens: number;
  creators: number;
  migrations: number;
  migrationsAfter60s?: number;
}

export interface MetaPayloadToken {
  mint?: string;
  name: string;
  symbol: string;
  marketCapUsd?: number;
  url?: string;
}

/** The part of GET /api/metas the section reads (the server's `MetasResponse`; a field renamed there is a type error in the server test). */
export interface MetaPayload {
  computedAt: string | null;
  /** "Only 1 h of data in the last 24 h" when the shown window has gaps; the server decides (core's `coverageNote`). */
  coverageNote?: string | null;
  metas: Array<{
    rank: number;
    label: string;
    firstSeenAt: string;
    counts: { "6h": MetaPayloadCounts; "24h": MetaPayloadCounts };
    createsPerMigration: number | null;
    topTokens: MetaPayloadToken[];
    summary: string;
    summarySource?: string;
  }>;
}

export type MetaTrendWord = "accelerating" | "steady" | "fading";

/** Accelerating, steady or fading from the last-6-h and last-24-h token counts; null when nothing was launched in 24 h. */
export function trendWord(tokens6h: number, tokens24h: number): MetaTrendWord | null {
  if (!Number.isFinite(tokens6h) || !Number.isFinite(tokens24h) || tokens24h <= 0) return null;
  const share = Math.max(0, tokens6h) / tokens24h;
  if (share >= META_TREND.accelerating) return "accelerating";
  if (share <= META_TREND.fading) return "fading";
  return "steady";
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/**
 * "just now", "12 minutes ago", "14 hours ago", "3 days ago"; a time in the future (clock skew) reads "just now"; null when `iso` is not a date.
 * With `nowMs <= 0` (the clock before mount) it is the absolute UTC time, "6 Nov 23:49 UTC", the same on the server and the first client render.
 */
export function ageText(iso: string, nowMs: number): string | null {
  const then = Date.parse(iso);
  if (!Number.isFinite(then) || !Number.isFinite(nowMs)) return null;
  if (nowMs <= 0) return fmtUtc(iso);
  const mins = Math.floor((nowMs - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${plural(mins, "minute")} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${plural(hours, "hour")} ago`;
  return `${plural(Math.floor(hours / 24), "day")} ago`;
}

/** "$13M", "$2.1M", "$850K", "$123". */
export function fmtUsd(usd: number): string {
  for (const [size, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (usd >= size) return `$${Math.round((usd / size) * 10) / 10}${suffix}`;
  }
  return `$${Math.round(usd)}`;
}

/** One line cut to `max` characters: whitespace and control characters flattened, an ellipsis where it was cut. */
export function clampText(text: unknown, max: number): string {
  if (typeof text !== "string") return "";
  const flat = text.slice(0, max * 4).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join("").trimEnd()}…` : flat;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export interface MetaTokenView {
  text: string;
  href: string | null;
}

export interface MetaRowView {
  rank: number;
  label: string;
  /** The row's element id and the `/meta#` fragment the home strip links to. */
  anchor: string;
  /** "190 creators · 6 migrations after 60s" (the strip's line); null when the payload has neither. */
  stripLine: string | null;
  /** The market cap of the first top token that has one, "$13M". */
  topCap: string | null;
  /** "312 tokens", "190 creators", "15 migrations (unfiltered)", "12.4 creates per migration": only those the payload has. */
  numbers: string[];
  trend: { word: MetaTrendWord; text: string } | null;
  firstSeen: string | null;
  tokens: MetaTokenView[];
  summary: string | null;
}

export interface MetaView {
  /** `waiting`: no run yet; `none`: a run with no Meta in it; `stale`: a run older than two hours; `ok`. */
  state: "waiting" | "none" | "stale" | "ok";
  rows: MetaRowView[];
  /** "ranking from 12 minutes ago"; null before the first run. */
  footer: string | null;
  /** The message for `waiting`, `none` and `stale`; null when the ranking is current. */
  note: string | null;
  /** The "warming up" line shown above the list when the window has gaps; null otherwise (and before the first run). */
  coverageNote: string | null;
}

const ANCHOR_CHARS = 40;

/** The in-page anchor (and element id) of a Meta, from its label: `meta-` plus its letters and digits, hyphenated. Only [\p{L}\p{N}-], so safe in a URL fragment. */
export function metaAnchor(label: string): string {
  const slug = clampText(label, ANCHOR_CHARS * 4)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const cut = [...slug].slice(0, ANCHOR_CHARS).join("").replace(/-+$/g, "");
  return cut === "" ? "meta" : `meta-${cut}`;
}

/** A Meta's top tokens as text; a link exists only where `safeHttpUrl` accepted the URL. Shared with the New Meta alert. */
export function tokenViews(topTokens: MetaPayloadToken[] | undefined): MetaTokenView[] {
  return (Array.isArray(topTokens) ? topTokens : []).flatMap((t): MetaTokenView[] => {
    const name = clampText(t?.name, TOKEN_NAME_CHARS);
    const symbol = clampText(t?.symbol, TICKER_CHARS);
    const head = name !== "" ? (symbol !== "" ? `${name} ($${symbol})` : name) : symbol !== "" ? `$${symbol}` : "";
    if (head === "") return [];
    return [{ text: finite(t.marketCapUsd) ? `${head} ${fmtUsd(t.marketCapUsd)}` : head, href: safeHttpUrl(t.url) }];
  });
}

function rowView(m: MetaPayload["metas"][number], nowMs: number, window: "6h" | "24h", anchor: string): MetaRowView {
  const c24 = m.counts?.["24h"];
  const c6 = m.counts?.["6h"];
  const cw = window === "6h" ? c6 : c24;
  const numbers: string[] = [];
  if (finite(cw?.tokens)) numbers.push(plural(cw.tokens, "token"));
  if (finite(cw?.creators)) numbers.push(plural(cw.creators, "creator"));
  if (finite(cw?.migrations)) numbers.push(`${plural(cw.migrations, "migration")} (unfiltered)`);
  if (finite(cw?.migrationsAfter60s)) numbers.push(`${cw.migrationsAfter60s} after 60 s`);
  const strip = [finite(cw?.creators) ? plural(cw.creators, "creator") : null, finite(cw?.migrationsAfter60s) ? `${plural(cw.migrationsAfter60s, "migration")} after 60s` : null].filter((s) => s !== null);
  const topCap = m.topTokens?.find((t) => finite(t?.marketCapUsd));
  if (finite(m.createsPerMigration) && m.createsPerMigration > 0) {
    const n = m.createsPerMigration;
    numbers.push(`${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10} creates per migration`);
  }
  const word = finite(c6?.tokens) && finite(c24?.tokens) ? trendWord(c6.tokens, c24.tokens) : null;
  const age = typeof m.firstSeenAt === "string" ? ageText(m.firstSeenAt, nowMs) : null;
  const tokens = tokenViews(m.topTokens);
  const summary = clampText(m.summary, SUMMARY_CHARS);
  return {
    rank: m.rank,
    label: clampText(m.label, LABEL_CHARS),
    anchor,
    numbers,
    stripLine: strip.length > 0 ? strip.join(" · ") : null,
    topCap: topCap && finite(topCap.marketCapUsd) ? fmtUsd(topCap.marketCapUsd) : null,
    trend: word !== null && finite(c6?.tokens) && finite(c24?.tokens) ? { word, text: `${c6.tokens} of ${c24.tokens} in the last 6 h` } : null,
    firstSeen: age !== null ? `first seen ${age}` : null,
    tokens,
    summary: summary !== "" ? summary : null,
  };
}

/** What the section renders, from the API payload (null when it has not loaded) and the clock. */
export function metaView(payload: MetaPayload | null | undefined, nowMs: number, opts: { rows?: number; window?: "6h" | "24h" } = {}): MetaView {
  const limit = opts.rows ?? META_ROWS;
  const window = opts.window ?? "24h";
  const computedAt = payload?.computedAt;
  if (!payload || typeof computedAt !== "string") return { state: "waiting", rows: [], footer: null, note: "No launch-theme ranking yet. The worker computes it every 15 minutes.", coverageNote: null };
  const age = ageText(computedAt, nowMs);
  const footer = age === null ? null : age === "just now" ? "ranking computed just now" : `ranking from ${age}`;
  const seen = new Map<string, number>();
  const used = new Set<string>();
  const rows = (Array.isArray(payload.metas) ? payload.metas : []).slice(0, limit).map((m) => {
    const base = metaAnchor(typeof m.label === "string" ? m.label : "");
    let n = seen.get(base) ?? 0;
    let anchor = base;
    if (n === 0 && !used.has(anchor)) n = 1;
    else {
      n = Math.max(n, 1);
      do n += 1; while (used.has(`${base}-${n}`));
      anchor = `${base}-${n}`;
    }
    seen.set(base, n);
    used.add(anchor);
    return rowView(m, nowMs, window, anchor);
  });
  const coverageNote = clampText(payload.coverageNote, COVERAGE_NOTE_CHARS) || null;
  const computedMs = Date.parse(computedAt);
  if (nowMs > 0 && Number.isFinite(computedMs) && nowMs - computedMs > META_STALE_MS) {
    const hours = Math.floor((nowMs - computedMs) / 3_600_000);
    return { state: "stale", rows, footer, note: `The launch-theme ranking is stale (computed ${plural(hours, "hour")} ago).`, coverageNote };
  }
  if (rows.length === 0) return { state: "none", rows, footer, note: "No launch theme stands out in the last 24 hours yet.", coverageNote };
  return { state: "ok", rows, footer, note: null, coverageNote };
}

/** The part of GET /api/current-meta the section reads (the server's `CurrentMetaResponse`; a field renamed there is a type error in the server test). */
export interface CurrentMetaPayload {
  computedAt: string | null;
  coverageNote?: string | null;
  /** A recording gap that overlaps the 24 h window (graduation Meta ticket 04); absent when there is none. */
  gap?: { from: string; to: string | null; covered: number; of: number; endedAt: string | null };
  metas: CurrentMetaPayloadRow[];
  watching: CurrentMetaPayloadRow[];
}

export interface CurrentMetaPayloadRow {
  key?: string;
  label: string;
  leader: { mint?: string; name: string; symbol: string; marketCapUsd: number; stale?: boolean; url?: string };
  holding?: boolean;
  enteredAt: string;
  counts: { "6h": MetaPayloadCounts; "24h": MetaPayloadCounts };
  topTokens: MetaPayloadToken[];
  summary: string;
  summarySource?: string;
  newMeta?: { reason: string; raisedAt: string };
  ideas?: MetaIdeaPayload[];
  /** The launch themes merged under the name (meta redesign ticket 07); absent from an older payload. */
  themes?: { label: string; tokens: number; creators: number }[];
  /** The subject's graduations (graduation Meta ticket 02); absent from an older payload. */
  grads?: {
    "24h": number;
    "6h": number;
    creators24h: number;
    share: number;
    coverage?: { covered: number; of: number };
    sinceGap?: number;
    blended?: number;
    newest?: MetaPayloadToken[];
    rising?: boolean;
  };
}

export interface CurrentMetaRowView {
  /** "10 graduated in 24h (3 in the last 6h), 10 creators, 10% of all graduations"; null for a row without graduations (an older payload). */
  gradLine: string | null;
  /** "covered 5 of 24 h" when the 24 h window is thin; null otherwise. Ticket 04 adds the gap warning beside it. */
  gradCoverage: string | null;
  /** "3 graduated since the last gap ended" when a gap ended inside the window; null otherwise. */
  sinceGap: string | null;
  /** "includes 3 graduates matched by name blend" when the blend pass placed graduates in the subject (ADR 0019); null otherwise. A count only. */
  blendNote: string | null;
  /** The newest graduates (at most 3) as "Name ($TICK) $12K", with "-" where no price is known. */
  newest: MetaTokenView[];
  /** "rising: 3 in 6h" for a Watching subject that qualifies by the 6 h rule; null otherwise. */
  rising: string | null;
  /** The subject's key, for the angle form (ticket 11): sent back to the server, which checks it against the newest run; never shown as text. Absent from an older payload. */
  key: string | null;
  /** The status of the Operator's newest angle request for this subject; null when it has none. */
  angle: AngleStatusView | null;
  label: string;
  /** The merged launch themes shown (at most 5), one line each: "Lucia From GTA 6 - 270 tokens, 156 creators". */
  themes: { text: string }[];
  /** How many more themes there are than the ones shown. */
  moreThemes: number;
  /** True when the list is worth showing: two or more themes, or one that is not just the name again. */
  grouped: boolean;
  /** The leader as text: "Jensen Huang ($JENSEN)". */
  leader: string;
  /** "$2.4M", or "-" when the leader has no price; "cap as of the last answer" in `capNote` when the figure was not read this run. */
  cap: string;
  capNote: string | null;
  /** A DexScreener link, only where `safeHttpUrl` accepted it. */
  leaderHref: string | null;
  /** "190 creators copying in 24 h"; "no copies launched in 24 h" when there are none. Null on a row that has graduations (the graduation line says it). */
  copies: string | null;
  /** "Meta since 3 hours ago" / "Watching since 3 hours ago"; null when the time is unreadable. */
  since: string | null;
  summary: string | null;
  tokens: MetaTokenView[];
  /** A Meta below the entry cap but still at or above the stay cap. */
  cooling: boolean;
  /** Why it is called cooling (title text); null when it is not. */
  coolingWhy: string | null;
  /** "New Meta: became a Meta: $JENSEN at $2.4M, 14 creators in 24 h, 2 hours ago" while the Meta's New Meta event is live; null otherwise and for Watching. */
  newMeta: string | null;
  /** A Meta's live meme ideas; absent for Watching and for a Meta without any. */
  ideas?: MetaIdeaView[];
}

export interface CurrentMetaView {
  /** `waiting`: no run yet; `stale`: a run older than two hours (rows still shown); `ok`. */
  state: "waiting" | "stale" | "ok";
  metas: CurrentMetaRowView[];
  watching: CurrentMetaRowView[];
  /** "No Meta right now" when a run has none; null otherwise. */
  emptyNote: string | null;
  /** The message for `waiting` and `stale`; null when the run is current. */
  note: string | null;
  footer: string | null;
  coverageNote: string | null;
  /** "Argus was not recording from 20 Nov 02:00 UTC to 20 Nov 06:00 UTC; counts cover 20 of 24 h" while a gap overlaps the window; null otherwise. */
  gapWarning: string | null;
}

/** The gap warning in UTC text (the same on the server and in any browser); null when there is no readable gap. */
function gapWarningText(gap: CurrentMetaPayload["gap"]): string | null {
  if (!gap || !finite(gap.covered) || !finite(gap.of) || gap.of <= 0) return null;
  const iso = (s: unknown): string => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}T/.test(s) ? fmtUtc(s) : "");
  const from = iso(gap.from);
  if (from === "") return null;
  const to = iso(gap.to);
  return `Argus was not recording from ${from} to ${to !== "" ? to : "now"}; counts cover ${Math.round(gap.covered)} of ${Math.round(gap.of)} h`;
}

const COOLING_WHY = "Cooling: below the usual bar to stay a Meta, kept for a short while before it drops.";
const NEWEST_SHOWN = 3;

/** "10% of all graduations"; "under 1%" for a share that rounds to nothing; null when there is none to show. */
function shareText(share: unknown): string | null {
  if (!finite(share) || share <= 0) return null;
  const pct = Math.round(share * 100);
  return pct < 1 ? "under 1% of all graduations" : `${Math.min(pct, 100)}% of all graduations`;
}

function gradViews(g: CurrentMetaPayloadRow["grads"], gapEnded: boolean): Pick<CurrentMetaRowView, "gradLine" | "gradCoverage" | "sinceGap" | "blendNote" | "newest" | "rising"> {
  const n24 = g?.["24h"];
  const n6 = g?.["6h"];
  if (!g || !finite(n24) || !finite(n6)) return { gradLine: null, gradCoverage: null, sinceGap: null, blendNote: null, newest: [], rising: null };
  const creators = finite(g.creators24h) ? plural(Math.max(0, Math.round(g.creators24h)), "creator") : null;
  const share = shareText(g.share);
  const cov = g.coverage;
  const covered = finite(cov?.covered) && finite(cov?.of) && cov.of > 0 ? `covered ${Math.round(cov.covered)} of ${Math.round(cov.of)} h` : null;
  const newest = (Array.isArray(g.newest) ? g.newest : []).slice(0, NEWEST_SHOWN).flatMap((t): MetaTokenView[] => {
    const name = clampText(t?.name, TOKEN_NAME_CHARS);
    const symbol = clampText(t?.symbol, TICKER_CHARS);
    const head = name !== "" ? (symbol !== "" ? `${name} ($${symbol})` : name) : symbol !== "" ? `$${symbol}` : "";
    if (head === "") return [];
    return [{ text: `${head} ${finite(t.marketCapUsd) && t.marketCapUsd > 0 ? fmtUsd(t.marketCapUsd) : "-"}`, href: safeHttpUrl(t.url) }];
  });
  return {
    gradLine: [`${n24} graduated in 24h (${n6} in the last 6h)`, creators, share].filter((s) => s !== null).join(", "),
    gradCoverage: covered,
    sinceGap: gapEnded && finite(g.sinceGap) && g.sinceGap >= 0 ? `${Math.round(g.sinceGap)} graduated since the last gap ended` : null,
    blendNote: finite(g.blended) && g.blended > 0 ? `includes ${Math.round(g.blended)} ${Math.round(g.blended) === 1 ? "graduate" : "graduates"} matched by name blend` : null,
    newest,
    rising: g.rising === true && n6 > 0 ? `rising: ${n6} in 6h` : null,
  };
}
const SHOWN = 3;
const THEMES_SHOWN = 5;
const THEME_LABEL_CHARS = 60;
const sameName = (a: string, b: string) => a.toLowerCase().replace(/\s+/g, " ") === b.toLowerCase().replace(/\s+/g, " ");

/** The merged themes of a subject as text lines; a theme with no readable label is dropped, and a lone theme that is the name again is no list. */
function themeViews(themes: CurrentMetaPayloadRow["themes"], title: string): Pick<CurrentMetaRowView, "themes" | "moreThemes" | "grouped"> {
  const all = (Array.isArray(themes) ? themes : []).flatMap((t) => {
    const label = clampText(t?.label, THEME_LABEL_CHARS);
    if (label === "") return [];
    const n = (x: unknown) => (finite(x) && x > 0 ? Math.round(x) : 0);
    return [{ label, text: `${label} - ${plural(n(t?.tokens), "token")}, ${plural(n(t?.creators), "creator")}` }];
  });
  const first = all[0];
  const grouped = all.length >= 2 || (first !== undefined && !sameName(first.label, title));
  if (!grouped) return { themes: [], moreThemes: 0, grouped: false };
  return { themes: all.slice(0, THEMES_SHOWN).map((t) => ({ text: t.text })), moreThemes: Math.max(0, all.length - THEMES_SHOWN), grouped: true };
}

function currentRowView(m: CurrentMetaPayloadRow, nowMs: number, isMeta: boolean, angles?: readonly AngleRequestPayload[] | null, gapEnded = false): CurrentMetaRowView {
  const name = clampText(m?.leader?.name, TOKEN_NAME_CHARS);
  const symbol = clampText(m?.leader?.symbol, TICKER_CHARS);
  const leader = name !== "" ? (symbol !== "" ? `${name} ($${symbol})` : name) : symbol !== "" ? `$${symbol}` : "unknown token";
  const creators = m?.counts?.["24h"]?.creators;
  const age = typeof m?.enteredAt === "string" ? ageText(m.enteredAt, nowMs) : null;
  const summary = clampText(m?.summary, SUMMARY_CHARS);
  const newAge = typeof m?.newMeta?.raisedAt === "string" ? ageText(m.newMeta.raisedAt, nowMs) : null;
  const newReason = clampText(m?.newMeta?.reason, NEW_META_REASON_CHARS);
  const ideas = isMeta ? ideaViews(m?.ideas, nowMs) : [];
  const cooling = isMeta && m?.holding === true;
  const label = clampText(m?.label, LABEL_CHARS);
  const key = typeof m?.key === "string" && m.key !== "" ? m.key : null;
  const grads = gradViews(m?.grads, gapEnded);
  return {
    ...(ideas.length > 0 ? { ideas } : {}),
    key,
    angle: angleStatusFor(angles, key ?? undefined, nowMs),
    label,
    ...themeViews(m?.themes, label),
    ...grads,
    leader,
    cap: finite(m?.leader?.marketCapUsd) && m.leader.marketCapUsd > 0 ? fmtUsd(m.leader.marketCapUsd) : "-",
    capNote: m?.leader?.stale === true && finite(m?.leader?.marketCapUsd) && m.leader.marketCapUsd > 0 ? "cap as of the last answer" : null,
    leaderHref: safeHttpUrl(m?.leader?.url),
    copies: grads.gradLine !== null ? null : finite(creators) && creators > 0 ? `${plural(creators, "creator")} copying in 24 h` : "no copies launched in 24 h",
    since: age !== null ? `${isMeta ? "Meta" : "Watching"} since ${age}` : null,
    // A templated numbers line under a graduation line would state the Meta twice (ADR 0018): the card keeps the graduation line and shows only a model line.
    summary: summary !== "" && !(grads.gradLine !== null && m?.summarySource === "template") ? summary : null,
    // the leader is already shown above; list only the other top tokens
    tokens: tokenViews(Array.isArray(m?.topTokens) ? m.topTokens.filter((t) => t?.mint === undefined || t.mint !== m?.leader?.mint) : undefined),
    cooling,
    coolingWhy: cooling ? COOLING_WHY : null,
    newMeta: isMeta && m?.newMeta ? `New Meta${newReason !== "" ? `: ${newReason}` : ""}${newAge !== null ? `, ${newAge}` : ""}` : null,
  };
}

/** What the Current Meta section renders, from the API payload (null when it has not loaded) and the clock. */
export function currentMetaView(payload: CurrentMetaPayload | null | undefined, nowMs: number, angles?: readonly AngleRequestPayload[] | null): CurrentMetaView {
  const computedAt = payload?.computedAt;
  if (!payload || typeof computedAt !== "string") return { state: "waiting", metas: [], watching: [], emptyNote: null, note: "No Meta run yet. The worker computes it every 15 minutes.", footer: null, coverageNote: null, gapWarning: null };
  const age = ageText(computedAt, nowMs);
  const footer = age === null ? null : age === "just now" ? "computed just now" : `computed ${age}`;
  const gapWarning = gapWarningText(payload.gap);
  const gapEnded = gapWarning !== null && typeof payload.gap?.endedAt === "string";
  // With a gap the gap banner is the only coverage figure; the create-based note and "covered N of 24 h" are the fallback when none is recorded.
  const noCreateCoverage = (r: CurrentMetaRowView): CurrentMetaRowView => (gapWarning !== null ? { ...r, gradCoverage: null } : r);
  const metas = (Array.isArray(payload.metas) ? payload.metas : []).slice(0, SHOWN).map((m) => noCreateCoverage(currentRowView(m, nowMs, true, angles, gapEnded)));
  const watching = (Array.isArray(payload.watching) ? payload.watching : []).slice(0, SHOWN).map((m) => noCreateCoverage(currentRowView(m, nowMs, false, angles, gapEnded)));
  const coverageNote = gapWarning !== null ? null : clampText(payload.coverageNote, COVERAGE_NOTE_CHARS) || null;
  const emptyNote = metas.length === 0 ? "No Meta right now" : null;
  const computedMs = Date.parse(computedAt);
  if (nowMs > 0 && Number.isFinite(computedMs) && nowMs - computedMs > META_STALE_MS) {
    const hours = Math.floor((nowMs - computedMs) / 3_600_000);
    return { state: "stale", metas, watching, emptyNote, note: `The Meta run is stale (computed ${plural(hours, "hour")} ago).`, footer, coverageNote, gapWarning };
  }
  return { state: "ok", metas, watching, emptyNote, note: null, footer, coverageNote, gapWarning };
}
