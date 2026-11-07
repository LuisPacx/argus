// Date text shared by the pages. Fixed locale and options so the server render and the browser agree.
const WHEN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/** "6 Nov, 23:49" in the viewer's time zone. */
export const fmtWhen = (iso: string): string => WHEN.format(new Date(iso));

/** The first letters of a Rubric dimension key, for the compact score bars in list rows. */
export const abbrev = (key: string): string => (key.length <= 4 ? key : key.slice(0, 3));

/** A URL without its scheme, for display (the full URL stays in the link's title). */
export const bareUrl = (url: string): string => url.replace(/^https?:\/\/(www\.)?/, "");

/** "1 Signal" / "5 Signals". */
export const signalsLabel = (n: number): string => `${n} ${n === 1 ? "Signal" : "Signals"}`;
