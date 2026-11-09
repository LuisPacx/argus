import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no types
import { analyze, fmtDuration, report } from "./tick-gaps.mjs";

const LOG = [
  "[worker] tick 2026-11-05T00:00:00.000Z",
  "[worker] tick 2026-11-09T12:00:00.000Z",
  "[ingest] 17 sources",
  "[worker] tick 2026-11-09T12:05:00.000Z",
  "[worker] tick 2026-11-09T12:10:00.000Z",
  "[worker] tick 2026-11-09T13:10:00.000Z",
  "[worker] tick 2026-11-09T13:15:00.000Z",
  "[worker] tick 2026-11-09T22:15:00.000Z",
  "[worker] tick 2026-11-09T22:20:00.000Z",
].join("\n");

describe("tick-gaps", () => {
  const r = analyze(LOG, "2026-11-09T12:00:00.000Z");

  it("ignores ticks before T0 and finds gaps over 10 min", () => {
    expect(r.gaps).toHaveLength(2);
    expect(r.gaps[0].ms).toBe(60 * 60 * 1000);
    expect(r.gaps[1].ms).toBe(9 * 3600 * 1000);
  });

  it("computes wall, downtime, uptime and End", () => {
    expect(r.wall).toBe(10 * 3600 * 1000 + 20 * 60 * 1000);
    expect(r.downtime).toBe(10 * 3600 * 1000);
    expect(r.uptime).toBe(20 * 60 * 1000);
    expect(new Date(r.end).toISOString()).toBe("2026-11-11T22:00:00.000Z");
  });

  it("prints End in UTC and -03:00", () => {
    const out = report(r);
    expect(out).toContain("End (T0 + 48h + downtime): 2026-11-11T22:00:00.000Z (2026-11-11T19:00:00-03:00)");
    expect(out).toContain("Total downtime: 10h00m00s");
  });

  it("formats durations", () => {
    expect(fmtDuration(3661000)).toBe("1h01m01s");
  });

  it("rejects a bad T0 and a log without ticks", () => {
    expect(() => analyze(LOG, "nope")).toThrow("bad T0");
    expect(() => analyze(LOG, "2027-01-01T00:00:00Z")).toThrow("no ticks");
  });
});
