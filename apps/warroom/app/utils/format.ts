// Date text shared by the pages. Fixed locale and options so the server render and the browser agree.
const WHEN = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

const WHEN_YEAR = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

/** "6 Nov 23:49 UTC"; "6 Nov 2025 23:49 UTC" when the year is not the current one. UTC, so the server and any browser zone agree. */
export const fmtWhen = (iso: string): string => {
  const d = new Date(iso);
  return `${(d.getUTCFullYear() === new Date().getUTCFullYear() ? WHEN : WHEN_YEAR).format(d).replace(",", "")} UTC`;
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
