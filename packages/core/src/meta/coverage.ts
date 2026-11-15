import { META_WINDOW_HOURS, type MetaWindow } from "./config.ts";

/**
 * How much of a Meta window the ingested creates really cover (viral sources ticket 05, ADR 0012 addendum). After a pause or an outage
 * the 24 h window holds a few hours of launches, and its counts are not comparable to a normal day's. The window of H hours is cut into
 * H trailing 60-minute buckets ending at the as-of time; a bucket is covered when at least `minCreates` tokens were created in it.
 * Creates are what the ranking counts, so they are the honest measure (a run with an empty feed would not count).
 */

const HOUR_MS = 3_600_000;

/** Covered hours of a window of `hours` ending at `nowMs`, from the tokens' create times (ms). Times outside the window are ignored. */
export function coveredHours(createdMs: readonly number[], nowMs: number, hours: number, minCreates: number): number {
  const buckets = new Array<number>(hours).fill(0);
  for (const t of createdMs) {
    const age = nowMs - t;
    if (!(age >= 0)) continue; // not yet created at the as-of time (or NaN)
    const i = Math.floor(age / HOUR_MS);
    if (i < hours) buckets[i] = (buckets[i] ?? 0) + 1;
  }
  return buckets.filter((n) => n >= minCreates).length;
}

export interface WindowCoverage {
  covered: number;
  /** The window's length in hours. */
  of: number;
}

export type MetaCoverage = Record<MetaWindow, WindowCoverage>;

/** Covered hours of both windows. */
export function metaCoverage(createdMs: readonly number[], nowMs: number, minCreates: number): MetaCoverage {
  return {
    "6h": { covered: coveredHours(createdMs, nowMs, META_WINDOW_HOURS["6h"], minCreates), of: META_WINDOW_HOURS["6h"] },
    "24h": { covered: coveredHours(createdMs, nowMs, META_WINDOW_HOURS["24h"], minCreates), of: META_WINDOW_HOURS["24h"] },
  };
}

/** True when the window has fewer covered hours than `below` of its length. Unknown (null) coverage is never thin. */
export function isThin(c: WindowCoverage | null | undefined, below: number): boolean {
  return c != null && c.covered < c.of * below;
}

/** "Only 1 h of data in the last 24 h"; null when the window is covered well enough or the coverage is unknown. */
export function coverageNote(coverage: MetaCoverage | null | undefined, window: MetaWindow, below: number): string | null {
  const c = coverage?.[window];
  if (!c || !isThin(c, below)) return null;
  return `Only ${c.covered} h of data in the last ${c.of} h`;
}
