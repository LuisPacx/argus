// Date text shared by the pages. Fixed locale and options so the server render and the browser agree.
const LOCAL_OPTS: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" };

/**
 * An absolute time, same client-only pattern as the relative times (ticket 15). While `nowMs <= 0` (the server render and the first client
 * render) it is the fixed UTC text "6 Nov 23:49 UTC". Once the client clock is set it is the viewer's own zone with a hint,
 * "6 Nov 20:49 GMT-3" ("6 Nov 2025 20:49 GMT-3" when the year is not the current one). "" when `iso` is not a date.
 * Formatters are built per call so the host zone read is current (the page re-renders after mount, never on the server).
 */
export const fmtWhen = (iso: string, nowMs: number): string => {
  if (nowMs <= 0) return fmtUtc(iso);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear();
  return new Intl.DateTimeFormat("en-GB", sameYear ? LOCAL_OPTS : { ...LOCAL_OPTS, year: "numeric" }).format(d).replace(",", "");
};

const UTC_WHEN = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/** "6 Nov 23:49 UTC": the text a relative time shows until the client clock is set (the same on the server and in any browser time zone); "" when `iso` is not a date. */
export const fmtUtc = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${UTC_WHEN.format(d).replace(",", "")} UTC`;
};

/** "04:10:02 UTC"; "" when `iso` is not a date. */
export const fmtUtcClock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.toISOString().slice(11, 19)} UTC`;
};

/** The first letters of a Rubric dimension key, for the compact score bars in list rows. */
export const abbrev = (key: string): string => (key.length <= 4 ? key : key.slice(0, 3));

/** A URL without its scheme, for display (the full URL stays in the link's title). */
export const bareUrl = (url: string): string => url.replace(/^https?:\/\/(www\.)?/, "");

/** "1 Signal" / "5 Signals". */
export const signalsLabel = (n: number): string => `${n} ${n === 1 ? "Signal" : "Signals"}`;
