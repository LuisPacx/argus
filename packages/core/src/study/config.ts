/**
 * The Study's capture rule, versioned. Numbers come from ticket 01's chain measurement (`.scratch/phase-3-feedback/measurements.md`) and
 * the Operator's decision on it (2026-11-08): metadata and website Snapshot at age 60 s, X capture at age 5 min, and a Fast migration
 * is one that happens within 60 s of the create. A Snapshot stores `version`, so a change to any number here means a new version, and
 * Snapshots of different versions are never pooled blindly.
 */
export const STUDY_CAPTURE_RULE = {
  version: 1,
  /** Metadata and website Snapshot age: 60 s after the create event (39% of migrators have migrated by then; 61% are left to learn from). */
  snapshotAgeSec: 60,
  /** X capture age, consumed by the X capture job (ticket 06): 5 min after create (window 5 to 15 min). */
  xCaptureAgeSec: 300,
  /** Fast migration: migrated within this many seconds of the create, in event times. Equal to the website Snapshot age by design. */
  fastMigrationSec: 60,
  /** A Snapshot later than snapshotAgeSec plus this is not taken: it would not be at the fixed age (the token is recorded as late, never backfilled). */
  captureGraceSec: 60,
  /** Metadata fetch attempts inside the window (an IPFS gateway can be slow or fail once). */
  metadataAttempts: 3,
  /** Website text kept in the Snapshot, in characters. */
  websiteTextChars: 20_000,
  /** Website HTML read, in bytes; more is cut and flagged. */
  websiteMaxBytes: 512 * 1024,
  /** Metadata JSON read, in bytes. */
  metadataMaxBytes: 64 * 1024,
  /** The whole website fetch (robots.txt, redirects and body), in milliseconds. */
  websiteTimeoutMs: 10_000,
  metadataTimeoutMs: 8_000,
  /** A page with fewer visible characters than this, and a script or mount point, is an empty app shell. */
  emptyShellMaxVisibleChars: 80,
} as const;

/**
 * Hard cap on capture runs (one run = one token processed by the capture job, which costs a metadata fetch and maybe a website fetch) in
 * any rolling 24 hours. About 600 creates an hour is 14,400 a day; the cap leaves headroom above that. The store enforces it itself, so no
 * caller can exceed it; `ARGUS_STUDY_CAPTURES_PER_DAY` can only lower it. A raise is a reviewed code change.
 */
export const MAX_CAPTURE_RUNS_PER_DAY = 20_000;

/** The cap in force: the environment may lower it, never raise it; junk is ignored. */
export function captureRunCap(env: Record<string, string | undefined> = process.env): number {
  const raw = env.ARGUS_STUDY_CAPTURES_PER_DAY;
  if (!raw || !/^\d{1,9}$/.test(raw)) return MAX_CAPTURE_RUNS_PER_DAY;
  return Math.min(MAX_CAPTURE_RUNS_PER_DAY, Number(raw));
}

/** Fast migration (GLOSSARY): migrated within `fastMigrationSec` of the create. Both times are event times in ISO. */
export function isFastMigration(createdAt: string, migratedAt: string, rule = STUDY_CAPTURE_RULE): boolean {
  const gap = (Date.parse(migratedAt) - Date.parse(createdAt)) / 1000;
  return gap >= 0 && gap <= rule.fastMigrationSec;
}
