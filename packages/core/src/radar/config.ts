/**
 * The trend radar's numbers, all here (spec: `.scratch/trend-radar/spec.md`; ticket 01). Plain constants. The environment may only lower a
 * cap, never raise it; a raise is a reviewed code change (CODING_STANDARDS rule 4). Countries are data: ticket 02 widens `googleGeos`.
 */
export const RADAR_CONFIG = {
  // ---- sources (spec section 4.1) ----
  /** The Google Trends countries the radar polls itself (the `trends:google` Source keeps polling the US on its own). */
  googleGeos: ["US"],
  googleUrl: "https://trends.google.com/trending/rss",
  fetchTimeoutMs: 10_000,
  fetchMaxBytes: 2 * 1024 * 1024,
  /** At most this many items of one feed are read (the feed gives 10). */
  maxItemsPerFeed: 50,
  /** Minutes between ticks. */
  tickMinutes: 15,
  /** The gap between two countries' requests, in milliseconds (jittered). */
  geoGapMs: { min: 2_000, max: 5_000 },

  // ---- backoff (spec section 4: doubling, honours Retry-After, never above 1 hour) ----
  backoffBaseMs: 15 * 60_000,
  backoffMaxMs: 60 * 60_000,
  /** Failures in a row at which a source is called `down` (it is still retried on its backoff). */
  downAfterFailures: 3,
  /** A source not `ok` for longer than this raises a banner on `/radar` and `/`. */
  alertAfterMs: 60 * 60_000,

  // ---- the seen-set and the shown rule of ticket 01 ----
  /** A key is kept this many days; a key not seen for this long and seen again is new. */
  seenDays: 14,
  /** A new key with at least this Google traffic becomes a shown Trend (ticket 02 replaces this with the score). */
  shownTrafficMin: 1_000,

  // ---- the untokenized check (spec section 5.5) ----
  /** DexScreener searches in one tick, the most; the environment may only lower it. */
  searchesPerTick: 30,
  /** The gap between two searches, in milliseconds (jittered). */
  searchGapMs: { min: 300, max: 1_200 },
  /** A shown Trend is checked again this often while it is live. */
  recheckMinutes: 60,
  /** A Trend is live for this long after it was last seen. */
  liveHours: 24,
  /** A pair created before the Trend's first sighting minus this is not a clone of it. */
  pairLookbackHours: 48,
  /** The local creates are those of the last this-many hours. */
  localCreatesHours: 48,
  /** The most local creates read into the in-memory index in one tick. */
  localCreatesMax: 500_000,
  /** A live token at or above this market cap makes the Trend `taken`. */
  takenCapUsd: 50_000,
  /** 4 or fewer distinct local creators is "few or none"; this many or more is `tokenizing`. */
  tokenizingMinCreators: 5,
  /** The most live tokens and lookalikes one trace keeps. */
  traceLiveMax: 50,
  traceLookalikesMax: 200,
  /** A token name or ticker in a trace, in characters. */
  tokenNameChars: 60,

  // ---- text (spec section 3, untrusted text) ----
  termChars: 300,
  newsTitleChars: 300,
  /** Words and word length of a search phrase. */
  searchWordsMax: 6,
  searchWordChars: 40,
  /** A raw input is read only this far before markup is stripped, so a hostile megabyte costs the same as a long term. */
  inputUnits: 4_000,

  // ---- the page (spec section 4 and ticket 01 item 8) ----
  /** A Trend is listed for this long after it was last seen. */
  listWindowHours: 24,
  apiMaxTrends: 100,
  apiMaxLookalikes: 50,
} as const;
