import { RADAR_CONFIG } from "./config.ts";

/**
 * The agreement score of a Trend (spec section 5.2), plain counting, every number in `config.ts`. Independent sources carrying the key within
 * 3 hours are worth 20 points each up to 4 (Google Trends in any country is ONE source, each news feed is one), plus 10 for a Google
 * `approx_traffic` of 5,000 or more or 20 for 20,000 or more, plus 10 when 3 or more Google countries carry it. The two slots of tickets 04 and
 * 12 (an upcoming date, X posts doubling) are in `config.ts` and give 0 until then. The score only orders and gates the page.
 */

/** One reading of a key: which source carried it, Google's traffic figure (0 for a feed) and when. */
export interface ScoreReading {
  source: string;
  trafficMin: number;
  /** ISO. */
  at: string;
}

export interface ScorePart {
  label: string;
  points: number;
}

export interface TrendScore {
  total: number;
  /** The parts the page shows as "why", in the order of the spec's table. */
  parts: ScorePart[];
  /** The Google countries (`US`, `GB`) and the feeds (their ids) that carried the key inside the window, sorted. */
  geos: string[];
  feeds: string[];
  /** The biggest Google traffic figure in the window, 0 when Google did not carry it. */
  trafficMin: number;
  /** The earliest reading inside the window (ISO), or null when there is none. */
  since: string | null;
}

/** A Trend is shown from 40 points. */
export function isShown(total: number): boolean {
  return total >= RADAR_CONFIG.shownScoreMin;
}

const GOOGLE_PREFIX = "radar:google:";

export function isGoogleSource(source: string): boolean {
  return source.startsWith(GOOGLE_PREFIX);
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** The score of the readings of one key at `now`. Only readings inside the 3-hour window count, so a stale reading adds nothing. */
export function scoreTrend(readings: readonly ScoreReading[], now: Date): TrendScore {
  const to = now.getTime() + RADAR_CONFIG.itemFutureSlackMs;
  const from = now.getTime() - RADAR_CONFIG.agreementWindowMs;
  const geos = new Set<string>();
  const feeds = new Set<string>();
  let trafficMin = 0;
  let since: string | null = null;
  for (const r of readings) {
    const t = Date.parse(r.at);
    if (!Number.isFinite(t) || t < from || t > to) continue;
    if (since === null || r.at < since) since = r.at;
    if (isGoogleSource(r.source)) {
      geos.add(r.source.slice(GOOGLE_PREFIX.length));
      if (r.trafficMin > trafficMin) trafficMin = r.trafficMin;
    } else feeds.add(r.source);
  }
  const sourceCount = feeds.size + (geos.size > 0 ? 1 : 0);
  const counted = Math.min(sourceCount, RADAR_CONFIG.sourcesMax);
  const parts: ScorePart[] = [];
  if (counted > 0) {
    const extra = sourceCount > counted ? ` (${sourceCount} carry it, ${counted} count)` : "";
    parts.push({ label: `${plural(counted, "independent source")} within 3 hours${extra}`, points: counted * RADAR_CONFIG.pointsPerSource });
  }
  const tier = RADAR_CONFIG.trafficTiers.find((t) => trafficMin >= t.min);
  if (tier) parts.push({ label: `Google traffic of ${tier.min.toLocaleString("en-US")} or more`, points: tier.points });
  if (geos.size >= RADAR_CONFIG.geoCountMin) parts.push({ label: `${geos.size} Google countries`, points: RADAR_CONFIG.geoPoints });
  return { total: parts.reduce((sum, p) => sum + p.points, 0), parts, geos: [...geos].sort(), feeds: [...feeds].sort(), trafficMin, since };
}
