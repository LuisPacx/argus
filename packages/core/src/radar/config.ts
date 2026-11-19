/**
 * The trend radar's numbers, all here (spec: `.scratch/trend-radar/spec.md`; ticket 01). Plain constants. The environment may only lower a
 * cap, never raise it; a raise is a reviewed code change (CODING_STANDARDS rule 4). Countries are data: ticket 02 widens `googleGeos`.
 */
export const RADAR_CONFIG = {
  // ---- sources (spec section 4.1) ----
  /** The Google Trends countries the radar polls itself (the `trends:google` Source keeps polling the US on its own). */
  googleGeos: ["US", "GB", "CA", "AU", "IN", "BR", "DE", "JP"],
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

  /** The radar's own User-Agent on the news feeds (some hosts refuse the bare Node one). It names the tool and nothing about the Operator. */
  userAgent: "argus-radar/1.0 (RSS reader; research tool)",
  /** The gap between two news feeds' requests, in milliseconds (jittered; the feeds are on different hosts). */
  feedGapMs: { min: 200, max: 900 },
  /** The most feeds the list may hold (the environment may only lower it, by pointing at a shorter file). */
  feedsMax: 40,
  /** A feed item older than this (by its own date) is not read, and an item with no readable date is never read: a stale item must not look new. */
  itemMaxAgeMs: 3 * 60 * 60_000,
  /** A feed item dated this far ahead of the poll is read as now (a skewed clock must not hide it). */
  itemFutureSlackMs: 10 * 60_000,

  // ---- the seen-set (spec section 5.1) ----
  /** A key is kept this many days; a key not seen for this long and seen again is new. */
  seenDays: 14,
  /** The readings are kept this many days and then deleted (ADR 0016: it covers the 14-day scorecard, and the table stays small). */
  readingsKeepDays: 30,

  // ---- the agreement score (spec section 5.2): every number of the table ----
  /** Sources that agree within this long count together. */
  agreementWindowMs: 3 * 60 * 60_000,
  /** 20 points a source (Google in any country is one, each feed is one), up to 4 sources. */
  pointsPerSource: 20,
  sourcesMax: 4,
  /** Google `approx_traffic` points: the higher tier replaces the lower one. */
  trafficTiers: [
    { min: 20_000, points: 20 },
    { min: 5_000, points: 10 },
  ],
  /** 3 or more Google countries carrying the key add this. */
  geoCountMin: 3,
  geoPoints: 10,
  /** The slots of tickets 04 and 12 (the upcoming date, and X posts doubling). Kept in the table so the breakdown has its place; both are 0 until then. */
  upcomingDatePoints: 0,
  xDoublingPoints: 0,
  /** A Trend is shown from this score (the page lists at most `apiMaxTrends`, 30), and at most `newPerHourMax` are made in an hour. */
  shownScoreMin: 40,
  newPerHourMax: 10,
  /** A Trend crossing this score is flagged "changed" once. */
  strongScore: 70,

  // ---- headline phrases (spec section 5.1) ----
  /** A phrase is a candidate when this many distinct feeds carry it within the agreement window. */
  phraseFeedsMin: 3,
  /** A phrase is 1 to this many words (stop words dropped first). */
  phraseWordsMax: 4,
  /** The most words of one headline that make phrases (the rest is ignored), and the longest word kept. */
  headlineWordsMax: 40,
  headlineWordChars: 30,
  /** The in-memory counter holds at most this many phrases; a phrase beyond it is not counted (the counter empties as items age out). */
  phraseKeysMax: 400_000,
  /** The feeds are polled this long before any phrase can become a Trend by feeds alone, so a first poll cannot turn every common word into one. */
  feedWarmupMs: 3 * 60 * 60_000,
  /** A phrase first seen within this long of the very first feed poll came with the backlog of that poll (one poll takes under a minute, a tick is 15). */
  feedFirstPollSlackMs: 5 * 60_000,

  // ---- trace work (review leftover of ticket 01) ----
  /** After this many `not traced` results in a row in one tick the rest of the tick's checks wait for the next tick (a 429 storm guard). */
  notTracedStreakMax: 3,

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
  /** Rows the page lists at most (spec 5.2: at most 30 on the page). */
  apiMaxTrends: 30,
  apiMaxLookalikes: 50,
} as const;
