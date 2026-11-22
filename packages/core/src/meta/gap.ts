/**
 * The recording gaps that overlap a Meta window (graduation Meta ticket 04). `study_gaps` says when the pump stream was down; counts over a window
 * that holds a gap are lower than a normal day's, so the Meta page warns and counts the graduations since the last gap ended. Pure: no clock, no database.
 */

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** A gap shorter than this is a reconnect blip, not worth a warning. */
export const GAP_MIN_MS = 5 * MINUTE_MS;

export interface GapSpan {
  startedAt: string;
  endedAt: string | null;
}

export interface WindowGap {
  /** The most recent gap that overlaps the window, as stored (its start may be before the window). */
  from: string;
  /** Its end; null while the gap is still open. */
  to: string | null;
  /** Whole hours of the window recorded (the window minus every gap in it); never more than `of`. */
  covered: number;
  /** The window's length in hours. */
  of: number;
  /** When the last gap ended (the "since the last gap" counter starts here); null while the gap is open. */
  endedAt: string | null;
}

/** The most recent gap that overlaps the last `hours` hours before `nowMs`, with the hours of the window the gaps leave; null when none does. */
export function windowGap(gaps: readonly GapSpan[], nowMs: number, hours: number): WindowGap | null {
  const from = nowMs - hours * HOUR_MS;
  const spans: Array<{ start: number; end: number; gap: GapSpan }> = [];
  for (const gap of gaps) {
    const start = Date.parse(gap.startedAt);
    const end = gap.endedAt === null ? nowMs : Date.parse(gap.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < GAP_MIN_MS) continue;
    if (end <= from || start >= nowMs) continue;
    spans.push({ start: Math.max(start, from), end: Math.min(end, nowMs), gap });
  }
  if (spans.length === 0) return null;
  // The union of the clipped spans, so two gaps that overlap are not counted twice.
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let missing = 0;
  let cursor = from;
  for (const s of sorted) {
    const start = Math.max(s.start, cursor);
    if (s.end > start) missing += s.end - start;
    cursor = Math.max(cursor, s.end);
  }
  const last = spans.reduce((a, b) => (b.end > a.end ? b : a)); // an open gap ends at now, so it is the last
  return {
    from: last.gap.startedAt,
    to: last.gap.endedAt,
    covered: Math.max(0, Math.min(hours, Math.floor((hours * HOUR_MS - missing) / HOUR_MS))),
    of: hours,
    endedAt: last.gap.endedAt,
  };
}
