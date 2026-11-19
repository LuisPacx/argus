// The Moments page (moment scanner ticket 01): what GET /api/moments sends, turned into the text the page shows. Every post, handle and
// text is third-party: it is cut to one line, shown as text, and a link is built only for an https://x.com/<handle>/status/<id> address.
import { ageText, clampText } from "./meta.ts";
import { safeHttpUrl } from "./safe-link.ts";

export const MOMENTS_POLL_MS = 60_000;
/** A post's text on a row, in characters. */
export const POST_TEXT_CLAMP = 220;

export interface MomentsPayloadPost {
  statusId: string;
  handle: string;
  url: string;
  text: string;
  postedAt: string;
  views: number | null;
  likes: number | null;
  viewsPerHour: number | null;
  recentRate: number | null;
  readings: number;
  lastSeenAt: string;
}

export interface MomentsPayload {
  enabled: boolean;
  topic: string | null;
  scanner: { lastScanAt: string | null; lastStatus: string | null; lastReason: string; lastLoads: number; lastGoodScanAt: string | null };
  session: { status: "ok" | "stopped"; reason: string; stoppedAt: string | null; resumeAt: string | null; probeDue: boolean };
  posts: MomentsPayloadPost[];
}

export interface MomentRowView {
  key: string;
  /** The link to the post; null unless it is a plain https://x.com/<handle>/status/<id> address. */
  href: string | null;
  handle: string;
  text: string;
  views: string;
  likes: string;
  perHour: string;
  /** "recent 390K an hour", or null when there is no earlier reading. */
  recent: string | null;
  posted: string;
  readings: string;
}

export interface MomentsView {
  topic: string | null;
  /** "Last good scan 12 minutes ago." or why there is none. */
  scanLine: string;
  session: { text: string; tone: "ok" | "amber"; detail: string | null };
  canResume: boolean;
  rows: MomentRowView[];
  /** Why the list is empty, or null when it has rows. */
  empty: string | null;
}

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const STATUS_PATH_RE = /^\/[A-Za-z0-9_]{1,15}\/status\/\d{15,19}$/;

/** The address of a post when it is `https://x.com/<handle>/status/<id>` and nothing else (no credentials, port, query or fragment), else null. */
export function postHref(raw: unknown): string | null {
  const href = safeHttpUrl(raw);
  if (href === null) return null;
  const url = new URL(href);
  if (url.protocol !== "https:" || url.hostname !== "x.com" || url.port !== "" || url.search !== "" || url.hash !== "") return null;
  return STATUS_PATH_RE.test(url.pathname) ? href : null;
}

/** "18.9K", "1.2M", "640"; "n/a" when the figure was not shown. */
export function fmtCount(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  for (const [size, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) if (n >= size) return `${Math.round((n / size) * 10) / 10}${suffix}`;
  return String(Math.round(n));
}

const dayWord = (iso: string | null, nowMs: number) => (iso === null ? null : ageText(iso, nowMs));

function sessionView(p: MomentsPayload["session"], nowMs: number): MomentsView["session"] {
  if (p.status !== "stopped") return { text: "X session: ok", tone: "ok", detail: null };
  const reason = clampText(p.reason, 40) || "a stop signal";
  const since = dayWord(p.stoppedAt, nowMs);
  const text = `X session: stopped on ${reason}${since ? `, ${since}` : ""}`;
  if (p.resumeAt === null) return { text, tone: "amber", detail: "This is the second stop within 7 days. Nothing loads from X until you press Resume." };
  if (p.probeDue) return { text, tone: "amber", detail: "The day has passed: the next scan makes one probe load, and goes on only if it is clean." };
  return { text, tone: "amber", detail: "Nothing loads from X until 00:00 UTC; then one probe load decides whether to go on." };
}

function rowView(p: MomentsPayloadPost, nowMs: number): MomentRowView {
  const handle = HANDLE_RE.test(String(p.handle)) ? p.handle : "";
  return {
    key: String(p.statusId).replace(/\D/g, "").slice(0, 20),
    href: postHref(p.url),
    handle,
    text: clampText(p.text, POST_TEXT_CLAMP),
    views: `${fmtCount(p.views)} views`,
    likes: `${fmtCount(p.likes)} likes`,
    perHour: p.viewsPerHour === null ? "no rate yet" : `${fmtCount(p.viewsPerHour)} views an hour`,
    recent: p.recentRate === null || p.recentRate === undefined ? null : `recent ${fmtCount(p.recentRate)} an hour`,
    posted: `posted ${ageText(p.postedAt, nowMs) ?? "at an unknown time"}`,
    readings: `${p.readings} ${p.readings === 1 ? "reading" : "readings"}`,
  };
}

/** The page's view of the API payload. `nowMs` is 0 until mounted (absolute UTC text, the same on the server and the client). */
export function momentsPageView(payload: MomentsPayload | null | undefined, nowMs: number): MomentsView {
  if (!payload) return { topic: null, scanLine: "", session: { text: "X session: unknown", tone: "amber", detail: null }, canResume: false, rows: [], empty: "The Moments list could not be loaded." };
  const session = sessionView(payload.session, nowMs);
  const rows = (Array.isArray(payload.posts) ? payload.posts : []).map((p) => rowView(p, nowMs));
  const good = dayWord(payload.scanner.lastGoodScanAt, nowMs);
  const scanLine = good ? `Last good scan ${good}.` : "No good scan yet.";
  const last = payload.scanner;
  const topic = payload.topic === null ? null : clampText(payload.topic, 60);
  let empty: string | null = null;
  if (rows.length === 0) {
    if (!payload.enabled && last.lastScanAt === null) empty = "The Moment scanner is off. The worker scans only when ARGUS_MOMENTS=1 and ARGUS_MOMENT_TOPIC are set.";
    else if (payload.session.status === "stopped") empty = `Stopped for the day: X showed ${clampText(payload.session.reason, 40) || "a stop signal"}. ${session.detail ?? ""}`.trim();
    else if (last.lastScanAt === null) empty = "No scan yet. The worker scans every 30 minutes once it is on.";
    else if (last.lastStatus === "skipped") empty = `The last scan was skipped: ${clampText(last.lastReason, 120) || "no reason recorded"}. It tries again at the next interval.`;
    else if (last.lastStatus === "error" || last.lastStatus === "selectors_found_nothing" || last.lastStatus === "stopped") empty = `The last scan did not finish: ${clampText(last.lastReason, 160) || last.lastStatus}.`;
    else empty = `Nothing is rising right now${topic ? ` in ${topic}` : ""}: no video with 50K views an hour or more.`;
  }
  return { topic, scanLine, session, canResume: payload.session.status === "stopped", rows, empty };
}

/** The server's reason for a refused Resume, as one short line. */
export function resumeFailure(e: unknown): string {
  const data = (e as { data?: { statusMessage?: unknown } } | null)?.data;
  const msg = data?.statusMessage ?? (e as { statusMessage?: unknown } | null)?.statusMessage;
  return typeof msg === "string" && msg !== "" ? clampText(msg, 200) : "The request failed. Try again.";
}
