/**
 * The Moment scanner's numbers, all here with their source (spec: `.scratch/moment-scanner/spec.md`; ticket 01). Plain constants, no imports,
 * so the scanner's child process (a plain .mjs script) can read the same file. The environment may only lower a cap, never raise it; a
 * raise is a reviewed code change (CODING_STANDARDS rule 4).
 */
export const MOMENT_CONFIG = {
  // ---- load caps (spec section 7; ADR 0009's 2026-11-19 amendment) ----
  /** Page loads in one scan: one topic is 2 loads (Top and Latest); 8 leaves room for the re-reads of tickets 02 and later. */
  loadsPerScan: 8,
  /** Loads in any rolling 24 hours when ARGUS_MOMENT_LOADS_PER_DAY is unset: "start at 100 a day for the first week" (spec section 7, Operator decision 1). */
  loadsPerDayDefault: 100,
  /** The most ARGUS_MOMENT_LOADS_PER_DAY may say: the spec's cap for the scanner after a week with no wall. Ticket 08 builds the ramp. */
  loadsPerDayCeiling: 300,
  /** Mouse-wheel scrolls per page (about 20 to 40 posts). */
  scrollsPerPage: 3,
  /** The jittered gap between two loads, in milliseconds: the spike's pacing (Phase 3 ticket 05). */
  gapMs: { min: 9_000, max: 22_000 },
  /** Minutes between scans: the default and the least ARGUS_MOMENT_INTERVAL_MIN may say. */
  intervalMinutesDefault: 30,
  intervalMinutesMin: 15,
  /** The longest one child process may run before the worker kills its process group: 8 loads at their slowest, with room. */
  childTimeoutMs: 12 * 60_000,

  // ---- what a rate is (spec section 3.2) ----
  /** Views an hour at or above which a clip is "rising": the brief's "rising only" bar of the 15:20 scan. */
  risingViewsPerHour: 50_000,
  /** The rate floor (proposal in the spec): a post must be at least this old, and have at least this many views, before a rate counts. */
  rateFloor: { minAgeMs: 30 * 60_000, minViews: 20_000 },
  /** The least gap between two readings for a recent rate to count (proposal): a 1-minute gap would turn a few hundred views into a huge rate. 12 minutes, so scans 15 minutes apart (the least interval) still rate despite the time a scan takes. */
  recentMinGapMs: 12 * 60_000,

  // ---- the query (spec section 3.1, group B) ----
  /** The `min_faves:` of the rising-clips query. */
  minFaves: 500,
  /** Spellings kept of a topic, and each word's length, in characters. */
  maxSpellings: 6,
  spellingChars: 40,
  /** A topic's label, in characters. */
  labelChars: 60,

  // ---- storage and page ----
  /** A stored post's text, in characters, after flattening. */
  textChars: 600,
  /** The page lists a post only while its newest reading is this young. */
  listWindowMs: 24 * 3_600_000,
  /** Rows on the page. */
  listLimit: 100,

  // ---- the stop state (ticket 01 item 7a) ----
  /** A second STOP within this long of the last one stops the X jobs until the Operator presses Resume. */
  repeatStopMs: 7 * 24 * 3_600_000,
} as const;
