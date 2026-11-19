import type { Datastore } from "../datastore.ts";
import type { DexScreenerClient } from "../sources/dexscreener.ts";
import { defaultPhrases, LocalCreateIndex, traceTrend } from "./check.ts";
import { RADAR_CONFIG } from "./config.ts";
import type { GoogleTrendsReader } from "./readers/google-trends.ts";
import { googleScore } from "./score.ts";
import type { RadarSettings } from "./settings.ts";
import { skipKeys } from "./skip.ts";
import type { CheckResult } from "./types.ts";

/**
 * The worker's radar step (ticket 01), every 15 minutes: poll Google Trends for each country, store the readings, keep the seen-set, drop what is
 * already a Meta or Watching subject, make a shown Trend of each new key with at least 1,000 traffic, and run the untokenized check on new Trends
 * first and then on live ones every 60 minutes, within 30 DexScreener searches a tick. No model, no Signal, no Source. Switch `ARGUS_RADAR=1`; a dry
 * run polls and searches nothing. Two ticks never overlap.
 */

export interface RadarJobDeps {
  store: Pick<Datastore, "radar" | "study" | "currentMetas">;
  settings: RadarSettings;
  reader: Pick<GoogleTrendsReader, "read">;
  dex: Pick<DexScreenerClient, "search">;
  /** The countries to poll; `RADAR_CONFIG.googleGeos` unless a test says otherwise. */
  geos?: readonly string[];
  dryRun?: boolean;
  /** For tests. */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

export interface RadarJobResult {
  /** `off`, `dry-run` and `overlap` did nothing; `ok` ran. */
  status: "off" | "dry-run" | "overlap" | "ok";
  readings: number;
  newTrends: number;
  /** New keys that were a current Meta or Watching subject, or under the traffic bar, so no Trend was made. */
  skipped: number;
  belowBar: number;
  searches: number;
  checked: number;
  /** Sources whose request was held back by their backoff, and sources whose poll failed. */
  waiting: string[];
  failed: string[];
  note: string;
}

const HOUR_MS = 3_600_000;

export function createRadarJob(deps: RadarJobDeps): () => Promise<RadarJobResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const jitter = (r: { min: number; max: number }) => Math.round(r.min + random() * (r.max - r.min));
  const geos = deps.geos ?? RADAR_CONFIG.googleGeos;
  let running = false;
  const blank = (status: RadarJobResult["status"], note: string): RadarJobResult => ({ status, readings: 0, newTrends: 0, skipped: 0, belowBar: 0, searches: 0, checked: 0, waiting: [], failed: [], note });

  return async () => {
    const { store, settings } = deps;
    if (!settings.enabled) return blank("off", "ARGUS_RADAR is not 1");
    if (deps.dryRun) {
      log("[worker] radar: dry-run, would poll Google Trends and search DexScreener; nothing is polled or searched");
      return blank("dry-run", "dry run");
    }
    if (running) return blank("overlap", "a radar tick is still running");
    running = true;
    try {
      const out = blank("ok", "");
      const start = now();
      store.radar.prune(start);
      const skip = skipKeys(store.currentMetas());

      for (const [i, geo] of geos.entries()) {
        if (deps.signal?.aborted) return out;
        if (i > 0) await sleep(jitter(RADAR_CONFIG.geoGapMs));
        const polled = await deps.reader.read(geo, now().getTime());
        // A source still waiting out its backoff makes no request and keeps the state and reason the failure gave it.
        if (!polled.fetched) {
          out.waiting.push(polled.sourceId);
          continue;
        }
        const at = now();
        store.radar.recordSource(polled.sourceId, polled.status, polled.reason, at);
        if (polled.status !== "ok") {
          out.failed.push(polled.sourceId);
          log(`[worker] radar: ${polled.sourceId} is ${polled.status}${polled.reason ? ` (${polled.reason})` : ""}`);
          continue; // never "no trends": nothing is stored, and the seen-set is untouched
        }
        for (const c of polled.candidates) {
          store.radar.recordReading(c, at.toISOString());
          out.readings++;
          if (store.radar.touchSeen(c.key, at)) {
            if (skip.has(c.key)) out.skipped++;
            else if (c.trafficMin < RADAR_CONFIG.shownTrafficMin) out.belowBar++;
            else {
              store.radar.createTrend({ key: c.key, label: c.term, firstSeen: at.toISOString(), score: googleScore(c.trafficMin), candidate: c });
              out.newTrends++;
            }
          } else store.radar.touchTrend(c.key, c, googleScore(c.trafficMin), at);
        }
      }

      // The untokenized check: new Trends first, then live ones an hour after their last check, within the search cap.
      const due = store.radar.dueChecks(now(), settings.searchesPerTick);
      let index: LocalCreateIndex | undefined;
      let searches = 0;
      const dex = {
        search: (q: string) => {
          searches++;
          return deps.dex.search(q);
        },
      };
      for (const trend of due) {
        if (deps.signal?.aborted) break;
        const phrases = defaultPhrases(trend.label);
        if (searches + Math.max(1, phrases.length) > settings.searchesPerTick) break;
        if (searches > 0) await sleep(jitter(RADAR_CONFIG.searchGapMs));
        index ??= buildIndex(store, now());
        let result: CheckResult;
        try {
          result = await traceTrend({ label: trend.label, firstSeen: trend.firstSeen, phrases }, { dex, localCreates: index, now: now() });
        } catch (e) {
          // Whatever went wrong, the Trend is `not traced` and keeps its last good trace: never untokenized.
          log(`[worker] radar: the check of "${trend.key}" failed: ${e instanceof Error ? e.message.slice(0, 120) : "unknown error"}`);
          result = { side: "not traced", trace: null, localCreates: null, localCreators: null };
        }
        store.radar.recordCheck(trend.id, result, now());
        out.checked++;
      }
      out.searches = searches;
      out.note = `${out.readings} reading(s), ${out.newTrends} new, ${out.checked} checked with ${searches} search(es)`;
      return out;
    } finally {
      running = false;
    }
  };
}

/** The local half of the check: the last 48 hours of stored creates, indexed once. */
function buildIndex(store: Pick<Datastore, "study">, at: Date): LocalCreateIndex {
  const since = new Date(at.getTime() - RADAR_CONFIG.localCreatesHours * HOUR_MS).toISOString();
  return LocalCreateIndex.build(store.study.createsSince(since, RADAR_CONFIG.localCreatesMax));
}
