import { MOMENT_CONFIG } from "./config.ts";

const HOUR_MS = 3_600_000;

/** One reading of a post: when it was read and how many views it had then (`null`: not shown). */
export interface ViewReading {
  at: Date;
  views: number | null;
}

/**
 * Views an hour since posting, as of `at`: views divided by hours since the post. `null` (the post does not rate) when views are not shown,
 * when the post is under 30 minutes old, or when it has under 20,000 views, so a 10-minute-old post with 15,000 views is not "90,000 an hour".
 */
export function viewsPerHour(views: number | null, postedAt: Date, at: Date): number | null {
  if (views === null || !Number.isFinite(views)) return null;
  const age = at.getTime() - postedAt.getTime();
  if (!(age >= MOMENT_CONFIG.rateFloor.minAgeMs) || views < MOMENT_CONFIG.rateFloor.minViews) return null;
  return views / (age / HOUR_MS);
}

/**
 * Views gained an hour between two readings (the later minus the earlier, over the time between them). It rates only when the post meets the
 * floor at the later reading, both readings show views, they are at least 12 minutes apart and the count did not go down.
 */
export function recentRate(earlier: ViewReading, later: ViewReading, postedAt: Date): number | null {
  if (earlier.views === null || later.views === null) return null;
  const gap = later.at.getTime() - earlier.at.getTime();
  if (!(gap >= MOMENT_CONFIG.recentMinGapMs) || later.views < earlier.views) return null;
  if (viewsPerHour(later.views, postedAt, later.at) === null) return null; // under the floor at the later reading
  return (later.views - earlier.views) / (gap / HOUR_MS);
}

/** Whether either rate is at or above the "rising" bar (50,000 views an hour). */
export const isRising = (average: number | null, recent: number | null): boolean => (average ?? 0) >= MOMENT_CONFIG.risingViewsPerHour || (recent ?? 0) >= MOMENT_CONFIG.risingViewsPerHour;
