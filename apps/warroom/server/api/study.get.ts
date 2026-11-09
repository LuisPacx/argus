import { STUDY_CAPTURE_RULE, captureRunCap } from "@argus/core";

/**
 * The Study page's health numbers (phase 3): tokens seen, in the population, captured and missed, and the empty-app-shell share of the
 * website Snapshots, over everything since the Study started and over the last 24 hours. Also the capture rule in force. Read-only.
 */
export default defineEventHandler(() => {
  const store = useStore();
  const now = new Date();
  const cap = captureRunCap(process.env);
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const { version, snapshotAgeSec, xCaptureAgeSec, fastMigrationSec } = STUDY_CAPTURE_RULE;
  return {
    allTime: store.studyStats(now, undefined, cap),
    last24h: store.studyStats(now, dayAgo, cap),
    rule: { version, snapshotAgeSec, xCaptureAgeSec, fastMigrationSec },
  };
});
