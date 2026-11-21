import type { Datastore } from "../datastore.ts";
import { MOMENT_CONFIG } from "../moments/config.ts";
import { cleanSpelling, sinceStamp, type ScanTarget } from "../moments/query.ts";
import type { MomentRunner } from "../moments/scan-runner.ts";
import type { ScanStatus } from "../moments/store.ts";
import type { Notifier } from "../telegram.ts";
import { isXStopSignal, runXJob, xStopText } from "../x-session/state.ts";
import { RESEARCH_SCAN_PREFIX, RESEARCH_X_LOADS_PER_DAY, RESEARCH_X_LOADS_PER_RUN, RESEARCH_X_POSTS_MAX, type PromptPost } from "./brief.ts";

/**
 * What a research run reads of X (human researcher ticket 05, ADR 0009 as amended). Nothing here opens a browser or reaches a host: the one way to
 * X is the scanner's child process (the `MomentRunner` the worker hands in), which opens the dedicated logged-in profile through the shared session
 * path (`x-capture/session.mjs`, the Chrome binary named by `ARGUS_CHROME_BIN`), refuses every address but a search page or a post page, and reads
 * only. The run goes through the same gate as the scanner (`runXJob`: a stopped session loads nothing, one probe load the next day), counts its
 * loads in the same table (`moment_scans`, so the scanner's daily cap sees them) and is held by its own caps on top: 2 loads a run and 20 a day.
 * X data is optional: when it cannot be read the brief says why and the run goes on without it.
 */

const DAY_MS = 24 * 3_600_000;
/** How far back the search reaches. */
const SEARCH_WINDOW_MS = 3 * DAY_MS;

export interface XReadDeps {
  store: Pick<Datastore, "moments" | "xSession">;
  /** The scanner's child process. Absent (no runner wired, or a dry run), X is not read. */
  runner?: MomentRunner;
  notifier?: Pick<Notifier, "notify">;
  /** The shared daily cap on X page loads (the scanner's setting: it can only be lowered from 100). */
  loadsPerDay: number;
  now: () => Date;
  signal?: AbortSignal;
  log: (line: string) => void;
}

export interface XRead {
  posts: PromptPost[];
  /** Code-written: what was read, or why X was not. */
  note: string;
  loads: number;
}

const none = (why: string): XRead => ({ posts: [], note: `X was not read: ${why}`, loads: 0 });

/**
 * The two search pages of a topic (the Top and the Latest tab), built by code: the topic is cleaned by the scanner's own cleaner (letters, digits,
 * spaces, `#` and `$`; the operator words and every other character are gone) and the only operator is the fixed `since:`. A topic with nothing left
 * after cleaning gives null: it is a skip, never a search.
 */
export function topicTargets(topic: string, now: Date): ScanTarget[] | null {
  const spelling = cleanSpelling(topic);
  if (spelling === "") return null;
  const query = `${spelling.includes(" ") ? `"${spelling}"` : spelling} since:${sinceStamp(new Date(now.getTime() - SEARCH_WINDOW_MS))}`;
  const url = (f: "top" | "live") => `https://x.com/search?q=${encodeURIComponent(query)}&f=${f}`;
  return [
    { id: "top", query, url: url("top") },
    { id: "live", query, url: url("live") },
  ];
}

/** Reads X for one topic. Never throws: every way it can fail is a note. */
export async function readXForTopic(topic: string, deps: XReadDeps): Promise<XRead> {
  const { store, runner } = deps;
  if (runner === undefined) return none("no X reader is wired in this worker");
  const start = deps.now();
  const targets = topicTargets(topic, start);
  if (targets === null) return none("the topic has no searchable words");
  const label = `${RESEARCH_SCAN_PREFIX}${topic}`;
  const record = (status: ScanStatus, loads: number, signals: string[], reason: string) => store.moments.recordScan({ at: start.toISOString(), topic: label, status, loads, signals, reason });
  try {
    const ran = await runXJob(store.xSession, start, async (mode): Promise<XRead> => {
      const dayAgo = new Date(start.getTime() - DAY_MS).toISOString();
      const left = Math.min(deps.loadsPerDay - store.moments.loadsSince(dayAgo), RESEARCH_X_LOADS_PER_DAY - store.moments.researchLoadsSince(dayAgo));
      const allowed = Math.min(mode === "probe" ? 1 : RESEARCH_X_LOADS_PER_RUN, left, MOMENT_CONFIG.loadsPerScan);
      if (allowed <= 0) {
        record("skipped", 0, [], "daily load cap reached");
        return none("the daily X load cap is reached");
      }
      const plan = targets.slice(0, allowed).map((t) => ({ id: t.id, url: t.url }));
      const r = await runner(plan, { signal: deps.signal });
      const end = deps.now();
      if (r.kind === "locked") {
        record("skipped", 0, [], "browser busy");
        return none("the browser is busy");
      }
      const loads = r.pages.length;
      if (mode === "probe" && loads > 0) store.xSession.beginProbe(start);
      const stopSignal = r.stopped !== null && isXStopSignal(r.stopped) ? r.stopped : null;
      const signals = [...new Set(r.pages.flatMap((p) => p.signals))];
      if (r.kind === "refused" || r.kind === "failed") {
        record("error", loads, signals, r.reason);
        return { ...none("the reader failed"), loads };
      }
      let status: ScanStatus = "ok";
      if (stopSignal !== null) status = "stopped";
      else if (r.selectorsFoundNothing) status = "selectors_found_nothing";
      else if (loads > 0 && r.pages.every((p) => p.status === "error")) status = "error";
      record(status, loads, signals, stopSignal !== null ? `stopped on ${stopSignal}: no retry` : status === "ok" ? "" : "a page was not read");
      if (stopSignal !== null) {
        const stop = store.xSession.recordStop(stopSignal, end);
        if (stop) {
          deps.log(`[worker] X session stopped on ${stopSignal}${stop.repeated ? " (second stop within 7 days: only Resume clears it)" : " until 00:00 UTC"}`);
          deps.notifier?.notify(xStopText(stopSignal, stop.state.resumeAt));
        }
      } else if (mode === "probe" && loads > 0) {
        if (status === "ok" && r.pages[0]?.status === "ok") store.xSession.clearOnCleanProbe();
        else store.xSession.probeNotClean(end);
      }
      if (status !== "ok") return { ...none(status === "stopped" ? `X stopped the session (${stopSignal})` : "its pages could not be read"), loads };
      const seen = new Set<string>();
      const posts: PromptPost[] = [];
      for (const page of r.pages.filter((p) => p.status === "ok")) {
        for (const p of page.posts) {
          if (seen.has(p.statusId)) continue;
          seen.add(p.statusId);
          posts.push({ handle: p.handle, text: p.text, likes: p.counts.likes, views: p.counts.views });
        }
      }
      posts.sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || (b.likes ?? -1) - (a.likes ?? -1));
      const shown = posts.slice(0, RESEARCH_X_POSTS_MAX);
      return { posts: shown, note: `X was read: ${loads} ${loads === 1 ? "page" : "pages"}, ${posts.length} ${posts.length === 1 ? "post" : "posts"} found, the ${shown.length} most viewed shown`, loads };
    });
    if (!ran.ran) return none(`the session is stopped (${ran.reason})`);
    return ran.result;
  } catch (e) {
    deps.log(`[worker] research: reading X failed: ${e instanceof Error ? e.message : String(e)}`);
    return none("the reader failed");
  }
}
