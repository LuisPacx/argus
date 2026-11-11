import type { Resolver, Transport } from "./guarded-fetch.ts";
import { MAX_CAPTURE_RUNS_PER_DAY, STUDY_CAPTURE_RULE } from "./config.ts";
import { GatewayStats, ipfsGateways } from "./ipfs-gateways.ts";
import { fetchMetadata, inPopulation } from "./metadata.ts";
import { SnapshotNotAllowedError, type StudyStore, type StudyToken } from "./store.ts";
import { fetchWebsite } from "./website.ts";

/**
 * The capture job: for each pending token whose age has reached the fixed Snapshot age, read its metadata, apply the population rule,
 * and for a studied token fetch its one website and write the frozen Snapshot. Plain code, no Claude. The worker runs it every few
 * seconds. A token the worker reached too late is marked late and never captured; a missed create is never due at all.
 */

export interface CaptureDeps {
  now?: () => Date;
  log?: (line: string) => void;
  /** Fetches nothing, writes nothing: only reports what it would capture. */
  dryRun?: boolean;
  /** Capture runs allowed in a rolling 24 h; clamped to MAX_CAPTURE_RUNS_PER_DAY by the store. */
  runCap?: number;
  /** Tokens looked at per call. */
  batch?: number;
  rule?: typeof STUDY_CAPTURE_RULE;
  /** Ordered IPFS gateway base URLs; default from `ARGUS_STUDY_IPFS_GATEWAYS` or the built-in list. */
  gateways?: readonly string[];
  resolve?: Resolver;
  transport?: Transport;
}

export interface CaptureReport {
  dryRun: boolean;
  /** Pending tokens at or past the Snapshot age (up to the batch size). */
  due: number;
  captured: number;
  /** Read, and found to have neither a website nor an X link. */
  counted: number;
  late: number;
  capped: number;
  unreadable: number;
  /** Metadata fetch failed but may work next tick; still pending. */
  retrying: number;
  /** Dry run: how many of the due tokens are still inside the capture window. */
  wouldCapture?: number;
}

const BATCH = 25;
const CONCURRENCY = 5;

export async function captureDueSnapshots(store: StudyStore, deps: CaptureDeps = {}): Promise<CaptureReport> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const rule = deps.rule ?? STUDY_CAPTURE_RULE;
  const cap = deps.runCap ?? MAX_CAPTURE_RUNS_PER_DAY;
  const due = store.dueTokens(now(), deps.batch ?? BATCH, rule);
  const report: CaptureReport = { dryRun: deps.dryRun === true, due: due.length, captured: 0, counted: 0, late: 0, capped: 0, unreadable: 0, retrying: 0 };
  const ageOf = (createdAt: string) => (now().getTime() - Date.parse(createdAt)) / 1000;
  const windowEnd = rule.snapshotAgeSec + rule.captureGraceSec;

  if (deps.dryRun) {
    report.wouldCapture = due.filter((t) => ageOf(t.createdAt!) <= windowEnd).length;
    return report;
  }

  const net = { resolve: deps.resolve, transport: deps.transport };
  const gateways = deps.gateways ?? ipfsGateways();
  const stats = new GatewayStats();
  const one = async (token: StudyToken): Promise<void> => {
    try {
      if (ageOf(token.createdAt!) > windowEnd) {
        store.markToken(token.mint, "late", `reached at age ${Math.round(ageOf(token.createdAt!))} s, past the ${windowEnd} s capture window`);
        report.late++;
        return;
      }
      // A retry of a token already admitted does not count again: only the first attempt spends the daily capture cap.
      if (token.metadataAttempts === 0 && !store.beginCaptureRun(token.mint, now(), cap)) {
        store.markToken(token.mint, "capped", "the daily capture run cap was reached");
        report.capped++;
        return;
      }
      const attempts = store.bumpMetadataAttempts(token.mint);
      const m = await fetchMetadata(token.uri, { maxBytes: rule.metadataMaxBytes, timeoutMs: rule.metadataTimeoutMs, gateways, stats, ...net });
      if (!m.ok) {
        if (m.retryable && attempts < rule.metadataAttempts) {
          report.retrying++;
        } else {
          store.markToken(token.mint, "unreadable", `metadata: ${m.detail}`);
          report.unreadable++;
        }
        return;
      }
      const population = inPopulation(m.metadata);
      if (!population.studied) {
        store.markToken(token.mint, "counted", population.reason, { inPopulation: false });
        report.counted++;
        return;
      }
      const website = m.metadata.websiteUrl
        ? await fetchWebsite(m.metadata.websiteUrl, {
            maxBytes: rule.websiteMaxBytes,
            textChars: rule.websiteTextChars,
            timeoutMs: rule.websiteTimeoutMs,
            emptyShellMaxVisibleChars: rule.emptyShellMaxVisibleChars,
            ...net,
          })
        : null;
      try {
        // The capture time is the time the Snapshot is written, after the fetches: the stored age is the real one.
        store.recordSnapshot(
          { mint: token.mint, ...m.metadata, selectionReason: population.reason, website },
          now(),
          rule,
        );
        report.captured++;
      } catch (e) {
        if (!(e instanceof SnapshotNotAllowedError)) throw e;
        // The fetches took the token past its window: a Snapshot now would not be at the fixed age.
        store.markToken(token.mint, "late", e.message);
        report.late++;
      }
    } catch (e) {
      log(`[study] capture of ${token.mint} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  // A few at a time, so one slow site cannot push the tokens behind it out of their window. The store is synchronous, so the counters are safe.
  const queue = [...due];
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) await one(t);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  const gatewayLine = stats.summary();
  if (gatewayLine) log(`[study] ipfs gateways: ${gatewayLine}`);
  return report;
}
