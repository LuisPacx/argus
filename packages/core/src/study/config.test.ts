import { describe, expect, it } from "vitest";
import { MAX_CAPTURE_RUNS_PER_DAY, STUDY_CAPTURE_RULE, captureRunCap, isFastMigration } from "./config.ts";

describe("capture rule (Operator decision 2026-11-08 on the ticket 01 measurements)", () => {
  it("version 1 is website/metadata at 60 s, X at 5 min, Fast within 60 s", () => {
    expect(STUDY_CAPTURE_RULE).toMatchObject({ version: 1, snapshotAgeSec: 60, xCaptureAgeSec: 300, fastMigrationSec: 60 });
  });

  it("Fast is migrated at or before 60 s after the create, in event times", () => {
    const created = "2026-11-08T10:00:00.000Z";
    expect(isFastMigration(created, "2026-11-08T10:00:00.000Z")).toBe(true); // same second (a bundle)
    expect(isFastMigration(created, "2026-11-08T10:01:00.000Z")).toBe(true); // exactly 60 s
    expect(isFastMigration(created, "2026-11-08T10:01:00.001Z")).toBe(false);
    expect(isFastMigration(created, "2026-11-08T10:05:00.000Z")).toBe(false);
  });
});

describe("capture run cap", () => {
  it("defaults to the code cap, may be lowered by the environment and never raised", () => {
    expect(captureRunCap({})).toBe(MAX_CAPTURE_RUNS_PER_DAY);
    expect(captureRunCap({ ARGUS_STUDY_CAPTURES_PER_DAY: "50" })).toBe(50);
    expect(captureRunCap({ ARGUS_STUDY_CAPTURES_PER_DAY: String(MAX_CAPTURE_RUNS_PER_DAY * 10) })).toBe(MAX_CAPTURE_RUNS_PER_DAY);
    expect(captureRunCap({ ARGUS_STUDY_CAPTURES_PER_DAY: "lots" })).toBe(MAX_CAPTURE_RUNS_PER_DAY);
  });
});
