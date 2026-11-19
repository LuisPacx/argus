import { normaliseKey } from "../meta/key.ts";
import type { Datastore } from "../datastore.ts";
import type { DexScreenerClient } from "../sources/dexscreener.ts";
import { defaultPhrases, LocalCreateIndex, traceTrend } from "./check.ts";
import { RADAR_CONFIG } from "./config.ts";
import type { RadarFeed } from "./feeds.ts";
import { PhraseCounter, type PhraseEntry } from "./phrases.ts";
import type { Candidate, GoogleTrendsReader } from "./readers/google-trends.ts";
import type { RssFeedReader } from "./readers/rss.ts";
import { isShown, scoreTrend, type ScoreReading, type TrendScore } from "./score.ts";
import type { RadarSettings } from "./settings.ts";
import { skipKeys } from "./skip.ts";
import type { CheckResult, TrendWhy } from "./types.ts";

/**
 * The worker's radar step (tickets 01 and 02), every 15 minutes: poll Google Trends for each country and the radar's own news feeds, count the
 * headline phrases that 3 or more distinct feeds carry within 3 hours, score every key by how many independent sources carry it (`score.ts`), drop
 * what is already a Meta or Watching subject, make a shown Trend of each new key that reaches 40 points (at most 10 an hour), and run the untokenized
 * check on shown Trends, new ones first and then live ones hourly, within 30 DexScreener searches a tick. No model, no Signal, no Source. Switch
 * `ARGUS_RADAR=1`; a dry run polls and searches nothing. Two ticks never overlap.
 */

export interface RadarJobDeps {
  store: Pick<Datastore, "radar" | "study" | "currentMetas">;
  settings: RadarSettings;
  reader: Pick<GoogleTrendsReader, "read">;
  /** The news feeds' reader and list; with no list there is no feed step. */
  feedReader?: Pick<RssFeedReader, "read">;
  feeds?: readonly RadarFeed[];
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
  /** Google readings stored this tick. */
  readings: number;
  /** News feed items counted this tick (items inside the 3-hour window). */
  feedItems: number;
  newTrends: number;
  /** Keys that were a current Meta or Watching subject, so no Trend was made. */
  skipped: number;
  /** Keys under the score floor (40), not new, still warming up, or held by the hourly limit: no Trend was made. */
  belowBar: number;
  notNew: number;
  warming: number;
  held: number;
  searches: number;
  checked: number;
  /** True when 3 `not traced` results in a row ended this tick's checks early (a 429 storm guard); the rest wait for the next tick. */
  stoppedEarly: boolean;
  /** Sources whose request was held back by their backoff, and sources whose poll failed. */
  waiting: string[];
  failed: string[];
  note: string;
}

const HOUR_MS = 3_600_000;

/** One key that could become a Trend this tick. */
interface Eligible {
  key: string;
  label: string;
  score: TrendScore;
  google: Candidate | undefined;
  entries: PhraseEntry[];
}

export function createRadarJob(deps: RadarJobDeps): () => Promise<RadarJobResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const jitter = (r: { min: number; max: number }) => Math.round(r.min + random() * (r.max - r.min));
  const geos = deps.geos ?? RADAR_CONFIG.googleGeos;
  const feeds = deps.feeds ?? [];
  const feedLabel = new Map(feeds.map((f) => [f.id, f.label]));
  const counter = new PhraseCounter();
  let running = false;
  const blank = (status: RadarJobResult["status"], note: string): RadarJobResult => ({
    status, readings: 0, feedItems: 0, newTrends: 0, skipped: 0, belowBar: 0, notNew: 0, warming: 0, held: 0, searches: 0, checked: 0, stoppedEarly: false, waiting: [], failed: [], note,
  });

  return async () => {
    const { store, settings } = deps;
    if (!settings.enabled) return blank("off", "ARGUS_RADAR is not 1");
    if (deps.dryRun) {
      log("[worker] radar: dry-run, would poll Google Trends and the news feeds and search DexScreener; nothing is polled or searched");
      return blank("dry-run", "dry run");
    }
    if (running) return blank("overlap", "a radar tick is still running");
    running = true;
    try {
      const out = blank("ok", "");
      const start = now();
      store.radar.prune(start);
      store.radar.recordWorkerTick(start);
      const skip = skipKeys(store.currentMetas());

      // ---- Google Trends, each country ----
      const google = new Map<string, Candidate>();
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
          store.radar.touchSeen(c.key, at);
          store.radar.touchTrend(c.key, c, at);
          const have = google.get(c.key);
          if (!have || c.trafficMin > have.trafficMin) google.set(c.key, c);
        }
      }

      // ---- the news feeds ----
      let warmingUp = false;
      let feedsStartedMs = 0;
      if (feeds.length > 0 && deps.feedReader) {
        feedsStartedMs = Date.parse(store.radar.feedsStartedAt(start));
        counter.expire(now().getTime());
        const fresh: string[] = [];
        for (const [i, feed] of feeds.entries()) {
          if (deps.signal?.aborted) return out;
          if (i > 0) await sleep(jitter(RADAR_CONFIG.feedGapMs));
          const polled = await deps.feedReader.read(feed, now().getTime());
          if (!polled.fetched) {
            out.waiting.push(polled.sourceId);
            continue;
          }
          store.radar.recordSource(polled.sourceId, polled.status, polled.reason, now(), feed.label);
          if (polled.status !== "ok") {
            out.failed.push(polled.sourceId);
            log(`[worker] radar: ${polled.sourceId} is ${polled.status}${polled.reason ? ` (${polled.reason})` : ""}`);
            continue;
          }
          for (const item of polled.items) {
            fresh.push(...counter.add(feed.id, item.title, item.url, item.at));
            out.feedItems++;
          }
        }
        store.radar.touchSeenMany(fresh, now());
        // Until the feeds have been polled for 3 hours, a phrase may only be new because the radar just started: it cannot become a Trend alone.
        warmingUp = now().getTime() - feedsStartedMs < RADAR_CONFIG.feedWarmupMs;
      }

      // ---- agreement: score every key that Google or 3 feeds carry, and every live Trend a feed carries ----
      const at = now();
      const atMs = at.getTime();
      const since = new Date(atMs - RADAR_CONFIG.agreementWindowMs).toISOString();
      const keys = new Set<string>([...google.keys(), ...counter.agreed(atMs)]);
      const live = store.radar.liveTrends(at);
      for (const t of live) if (counter.entries(t.key, atMs).length > 0) keys.add(t.key);
      const eligible: Eligible[] = [];
      const skippedCuts: Cut[] = [];
      for (const key of keys) {
        const entries = counter.entries(key, atMs);
        const g = google.get(key);
        const readings: ScoreReading[] = [...store.radar.googleReadings(key, since), ...entries.map((e) => ({ source: e.feed, trafficMin: 0, at: new Date(e.at).toISOString() }))];
        const score = scoreTrend(readings, at);
        if (store.radar.trendByKey(key)) {
          // A Trend that exists is updated, never made twice; a feed's reading of it is kept as evidence.
          store.radar.recordFeedReadings(readingRows(key, entries), at);
          store.radar.rescore(key, score.total, whyOf(score, at, feedLabel, g), at);
          continue;
        }
        if (skip.has(key)) {
          out.skipped++;
          // Its other cuts are the same story (the Meta's page owns it): a shorter or longer phrase of the same headline is not a Trend either.
          skippedCuts.push({ words: wordsOf(g?.term ?? entries[0]?.term ?? ""), titles: titlesOf(entries) });
          continue;
        }
        if (!isShown(score.total)) {
          out.belowBar++;
          continue;
        }
        // New means its first sighting (in any source) was inside the agreement window; a phrase the feeds have always carried is not news.
        const first = store.radar.seenSince(key, at);
        if (first === null || Date.parse(first) < atMs - RADAR_CONFIG.agreementWindowMs) {
          out.notNew++;
          continue;
        }
        // A phrase the feeds carried when the radar first read them is background, not news: until the feeds have been polled for 3 hours, and for
        // any phrase first seen at the very first poll, it cannot become a Trend on the feeds' word alone.
        if (!g && (warmingUp || Date.parse(first) <= feedsStartedMs + RADAR_CONFIG.feedFirstPollSlackMs)) {
          out.warming++;
          continue;
        }
        eligible.push({ key, label: g?.term ?? entries[0]?.term ?? key, score, google: g, entries });
      }

      // Highest score first (then the more feeds, then the longer phrase); at most 10 new Trends an hour. A phrase that overlaps a phrase already
      // chosen, or the label of a live Trend, is the same story told by a shorter or longer cut of the same words, not a second Trend.
      const room = Math.max(0, RADAR_CONFIG.newPerHourMax - store.radar.trendsCreatedSince(new Date(atMs - HOUR_MS).toISOString()));
      eligible.sort((a, b) => b.score.total - a.score.total || b.score.feeds.length - a.score.feeds.length || wordCount(b.label) - wordCount(a.label) || (a.key < b.key ? -1 : 1));
      const taken: Cut[] = [...live.map((t) => ({ words: wordsOf(t.label), titles: [t.newsTitle] })), ...skippedCuts];
      for (const e of eligible) {
        if (!e.google) {
          const cut: Cut = { words: wordsOf(e.label), titles: titlesOf(e.entries) };
          if (taken.some((t) => sameStory(t, cut))) {
            out.notNew++;
            continue;
          }
          taken.push(cut);
        }
        if (out.newTrends >= room) {
          out.held++;
          continue;
        }
        store.radar.createTrend({
          key: e.key,
          label: e.label,
          firstSeen: at.toISOString(),
          score: e.score.total,
          candidate: { trafficText: e.google?.trafficText ?? "", trafficMin: e.google?.trafficMin ?? 0, ...headlineOf(e) },
          why: whyOf(e.score, at, feedLabel, e.google),
        });
        store.radar.recordFeedReadings(readingRows(e.key, e.entries), at);
        out.newTrends++;
      }

      // ---- the untokenized check: new Trends first, then live ones an hour after their last check, within the search cap ----
      const due = store.radar.dueChecks(now(), settings.searchesPerTick);
      let index: LocalCreateIndex | undefined;
      let searches = 0;
      let notTracedRun = 0;
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
        // Three `not traced` in a row is a rate-limit storm, not three bad luck: stop, and let the next tick's window try the rest.
        notTracedRun = result.side === "not traced" ? notTracedRun + 1 : 0;
        if (notTracedRun >= RADAR_CONFIG.notTracedStreakMax) {
          out.stoppedEarly = true;
          log(`[worker] radar: ${notTracedRun} checks in a row were not traced; the rest of this tick's checks wait for the next tick`);
          break;
        }
      }
      out.searches = searches;
      out.note = `${out.readings} Google reading(s), ${out.feedItems} feed item(s), ${out.newTrends} new Trend(s)${out.held > 0 ? ` (${out.held} held by the hourly limit)` : ""}, ${out.checked} checked with ${searches} search(es)${out.stoppedEarly ? " (stopped early: 3 not traced in a row)" : ""}`;
      return out;
    } finally {
      running = false;
    }
  };
}

/** The headline a new Trend shows: Google's own news item, else the first feed's headline. Both were cleaned by their readers. */
function headlineOf(e: Eligible): { newsTitle: string; newsUrl: string } {
  if (e.google?.newsTitle) return { newsTitle: e.google.newsTitle, newsUrl: e.google.newsUrl };
  const first = e.entries[0];
  return first ? { newsTitle: first.title, newsUrl: first.url } : { newsTitle: "", newsUrl: "" };
}

const wordsOf = (label: string): string[] => normaliseKey(label).split(" ").filter((w) => w !== "");
const wordCount = (s: string) => wordsOf(s).length;

/** The words of a phrase or a live Trend's label, and the headlines it was cut from. */
interface Cut {
  words: string[];
  titles: string[];
}

/**
 * Two cuts of the same headline are one story, not two Trends: they came from one headline (`gta vi` and `trailer` from "GTA VI trailer"), or one's
 * words are all in the other (`ipo` in `anthropic ipo`), or they share two words. Plain comparison of text; no pattern is built.
 */
function sameStory(a: Cut, b: Cut): boolean {
  if (a.titles.some((t) => t !== "" && b.titles.includes(t))) return true;
  const shared = a.words.filter((w) => b.words.includes(w)).length;
  return shared > 0 && (shared >= 2 || shared === Math.min(a.words.length, b.words.length));
}

const titlesOf = (entries: readonly PhraseEntry[]): string[] => entries.map((e) => e.title);

function readingRows(key: string, entries: readonly PhraseEntry[]) {
  return entries.map((e) => ({ source: e.feed, key, term: e.term, title: e.title, url: e.url, at: new Date(e.at).toISOString() }));
}

function whyOf(score: TrendScore, at: Date, labels: ReadonlyMap<string, string>, google: Candidate | undefined): TrendWhy {
  return {
    at: at.toISOString(),
    since: score.since,
    parts: score.parts,
    geos: score.geos,
    feeds: score.feeds.map((id) => ({ id, label: labels.get(id) ?? id })),
    trafficText: google?.trafficText ?? "",
  };
}

/** The local half of the check: the last 48 hours of stored creates, indexed once. */
function buildIndex(store: Pick<Datastore, "study">, at: Date): LocalCreateIndex {
  const since = new Date(at.getTime() - RADAR_CONFIG.localCreatesHours * HOUR_MS).toISOString();
  return LocalCreateIndex.build(store.study.createsSince(since, RADAR_CONFIG.localCreatesMax));
}
