/** The coin-side picture of a Trend (spec section 5.5). `unchecked` is only the state before the first check; it is never "untokenized". */
export type TrendSide = "unchecked" | "not traced" | "taken" | "contested" | "tokenizing" | "untokenized";

/** One DexScreener pair as the page lists it. Text is third-party: cleaned and cut before it is stored. */
export interface TracedToken {
  name: string;
  symbol: string;
  /** A DexScreener https link, or "". */
  url: string;
  marketCapUsd: number | null;
  liquidityUsd: number;
  /** When the pair was created (ISO); null when DexScreener gave none. */
  createdAt: string | null;
}

/** A pair that matched the name and failed the live-token test, with the reason ("pool $4, cap $131K: drained or fake"). */
export interface Lookalike extends TracedToken {
  reason: string;
}

/** What the last good DexScreener check found. */
export interface Trace {
  /** When it was made (ISO). */
  at: string;
  /** The cleaned phrases that were searched. */
  phrases: string[];
  /** Live tokens by the ticket 16 test, the biggest cap first. */
  live: TracedToken[];
  lookalikes: Lookalike[];
}

/** The answer of one untokenized check. `trace` is null when the check failed (the store then keeps the last good one). */
export interface CheckResult {
  side: Exclude<TrendSide, "unchecked">;
  trace: Trace | null;
  /** Local launchpad creates of the last 48 hours under the Trend's name, and their distinct creators. Null when the check failed. */
  localCreates: number | null;
  localCreators: number | null;
}

export type SourceStatus = "ok" | "backing off" | "format changed" | "down";

/** Why a Trend is shown (ticket 02): the sources that carried it and the parts of its score. Text is cleaned and cut before it is stored. */
export interface TrendWhy {
  /** When this was worked out (ISO). */
  at: string;
  /** The earliest reading inside the 3-hour window (ISO), or null. */
  since: string | null;
  parts: Array<{ label: string; points: number }>;
  /** The Google countries that carried it. */
  geos: string[];
  /** The feeds that carried it: id and label. */
  feeds: Array<{ id: string; label: string }>;
  /** Google's traffic figure, as Google wrote it ("20000+"), or "". */
  trafficText: string;
}

/** What the worker says about itself (item 3 of the ticket 01 review): the War Room shows this and not its own environment. */
export interface WorkerState {
  /** ARGUS_RADAR=1 in the worker's environment. */
  enabled: boolean;
  dryRun: boolean;
  startedAt: string;
  /** The last tick that ran (ISO), or null before the first. */
  lastTickAt: string | null;
  /** How many Google countries and news feeds the worker polls. */
  geos: number;
  feeds: number;
}

/** The status of one source, as stored and shown. */
export interface SourceState {
  source: string;
  /** A feed's label ("IGN"); "" for a Google country. */
  label: string;
  status: SourceStatus;
  reason: string;
  /** The last good poll (ISO), or null. */
  lastOk: string | null;
  /** When the source last stopped being `ok` (or became `ok`), ISO. */
  since: string;
}

export interface SourceAlert {
  source: string;
  label: string;
  status: Exclude<SourceStatus, "ok">;
  reason: string;
  since: string;
  lastOk: string | null;
}
