import type { Datastore } from "../datastore.ts";
import type { Notifier } from "../telegram.ts";
import { isXStopSignal, runXJob, xStopText } from "../x-session/state.ts";
import { MOMENT_CONFIG } from "./config.ts";
import { momentQueries, TopicRefused, type MomentTopic, type ScanTarget } from "./query.ts";
import type { MomentRunner } from "./scan-runner.ts";
import type { MomentSettings } from "./settings.ts";
import type { ScanStatus } from "./store.ts";

/**
 * The worker's scan step (Moment scanner ticket 01). One scan: read the X session's stop state first, work out how many page loads the caps
 * leave, run the child process on the topic's two search addresses, store the posts and readings, and record the scan whatever came of it.
 * No Claude and no Brain: plain code. A dry run, or the switch off, spawns nothing. Two scans never overlap.
 */

export interface MomentJobDeps {
  store: Pick<Datastore, "moments" | "xSession">;
  settings: MomentSettings;
  runner: MomentRunner;
  notifier: Pick<Notifier, "notify">;
  dryRun?: boolean;
  /** The pages one scan of the topic loads; the topic's two search addresses unless a later ticket adds more (and for tests of the caps). */
  targetsOf?: (topic: MomentTopic) => ScanTarget[];
  /** For tests. */
  now?: () => Date;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

export interface MomentJobResult {
  /** `off` and `dry-run` and `overlap` made no scan row; the others are the scan row's status. */
  status: ScanStatus | "off" | "dry-run" | "overlap";
  loads: number;
  newPosts: number;
  readings: number;
  note: string;
}

const DAY_MS = 24 * 3_600_000;

/** The Resume presses waiting, applied: the worker calls this on its tick and the scan calls it first. Returns whether it cleared a stop. */
export function applyXSessionResumes(store: Pick<Datastore, "xSession">, now: Date, log: (line: string) => void = () => {}): boolean {
  const cleared = store.xSession.applyResumes(now);
  if (cleared) log("[worker] X session: resumed by the Operator; the scanner goes on at its next scan");
  return cleared;
}

/**
 * The probe's plan: the first of the topic's own search addresses and nothing else. Never a profile page, so the allowlist needs no other
 * address (asserted in the tests against `isAllowedXUrl`).
 */
export const probePlan = (targets: readonly ScanTarget[]): ScanTarget[] => targets.slice(0, 1);

export function createMomentJob(deps: MomentJobDeps): () => Promise<MomentJobResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  let running = false;
  const result = (status: MomentJobResult["status"], note: string, over: Partial<MomentJobResult> = {}): MomentJobResult => ({ status, loads: 0, newPosts: 0, readings: 0, note, ...over });

  return async () => {
    const { store, settings } = deps;
    if (!settings.enabled || settings.topic === null) return result("off", "ARGUS_MOMENTS is not 1");
    if (deps.dryRun) {
      log("[worker] moment scan: dry-run, would read the X session state and scan the topic; nothing is spawned");
      return result("dry-run", "dry run");
    }
    if (running) return result("overlap", "a scan is still running");
    running = true;
    try {
      const topic = settings.topic;
      const start = now();
      applyXSessionResumes(store, start, log);
      const skip = (reason: string): MomentJobResult => {
        store.moments.recordScan({ at: start.toISOString(), topic: topic.label, status: "skipped", loads: 0, signals: [], reason });
        return result("skipped", reason);
      };
      let targets: ScanTarget[];
      try {
        targets = (deps.targetsOf ?? momentQueries)(topic);
      } catch (e) {
        if (!(e instanceof TopicRefused)) throw e;
        store.moments.recordScan({ at: start.toISOString(), topic: topic.label, status: "error", loads: 0, signals: [], reason: e.message });
        return result("error", e.message);
      }

      const ran = await runXJob(store.xSession, start, async (mode): Promise<MomentJobResult> => {
        const left = settings.loadsPerDay - store.moments.loadsSince(new Date(start.getTime() - DAY_MS).toISOString());
        const allowed = Math.min(mode === "probe" ? 1 : MOMENT_CONFIG.loadsPerScan, left);
        if (allowed <= 0) return skip(`daily load cap reached (${settings.loadsPerDay} loads in 24 hours)`);
        const plan = (mode === "probe" ? probePlan(targets) : targets).slice(0, allowed).map((t) => ({ id: t.id, url: t.url }));
        const r = await deps.runner(plan, { signal: deps.signal });
        const end = now();

        if (r.kind === "locked") return skip("browser busy");
        const loads = r.pages.length;
        // The one probe load is spent as soon as a page was loaded, whatever came of it.
        if (mode === "probe" && loads > 0) store.xSession.beginProbe(start);

        const stopSignal = r.stopped !== null && isXStopSignal(r.stopped) ? r.stopped : null;
        const signals = [...new Set(r.pages.flatMap((p) => p.signals))];
        let status: ScanStatus;
        let reason = "";
        if (r.kind === "refused" || r.kind === "failed") {
          status = "error";
          reason = r.reason;
        } else if (stopSignal !== null) {
          status = "stopped";
          reason = `stopped on ${stopSignal}: no retry`;
        } else if (r.selectorsFoundNothing) {
          status = "selectors_found_nothing";
          reason = "a page had no readable posts: X's markup may have changed";
        } else if (loads > 0 && r.pages.every((p) => p.status === "error")) {
          status = "error";
          reason = r.pages.map((p) => p.error).find((e) => e !== "") ?? "every page failed";
        } else {
          status = "ok";
          const bad = r.pages.filter((p) => p.status !== "ok");
          if (bad.length > 0) reason = `${bad.length} page(s) not read: ${bad.map((p) => p.status).join(", ")}`;
          if (mode === "probe") reason = `probe load; ${reason}`.trim();
        }
        const scanId = store.moments.recordScan({ at: start.toISOString(), topic: topic.label, status, loads, signals, reason });
        let newPosts = 0;
        let readings = 0;
        let badPosts = 0;
        for (const page of r.pages) {
          if (page.status !== "ok") continue;
          const added = store.moments.recordPosts(scanId, end.toISOString(), page.posts);
          newPosts += added.posts;
          readings += added.readings;
          badPosts += added.skipped;
        }
        if (badPosts > 0) log(`[worker] moment scan: ${badPosts} post(s) skipped (an ID or handle that is not well formed)`);

        if (stopSignal !== null) {
          const stop = store.xSession.recordStop(stopSignal, end);
          if (stop) {
            log(`[worker] X session stopped on ${stopSignal}${stop.repeated ? " (second stop within 7 days: only Resume clears it)" : " until 00:00 UTC"}`);
            deps.notifier.notify(xStopText(stopSignal, stop.state.resumeAt));
          }
        } else if (mode === "probe" && loads > 0) {
          if (status === "ok" && r.pages[0]?.status === "ok") {
            store.xSession.clearOnCleanProbe();
            log("[worker] X session: the probe load was clean; the scanner goes on");
          } else store.xSession.probeNotClean(end);
        }
        return result(status, reason, { loads, newPosts, readings });
      });
      if (!ran.ran) return skip(`stopped for the day (${ran.reason})${ran.resumeAt === null ? ": waiting for Resume" : ""}`);
      return ran.result;
    } finally {
      running = false;
    }
  };
}
