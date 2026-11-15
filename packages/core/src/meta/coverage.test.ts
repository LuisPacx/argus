import { describe, expect, it } from "vitest";
import { coverageNote, coveredHours, isThin, metaCoverage } from "./coverage.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-14T23:31:00.000Z");

/** `n` creates spread inside the trailing hour bucket `hoursAgo` (0 is the newest hour). */
const inHour = (hoursAgo: number, n: number): number[] => Array.from({ length: n }, (_, i) => NOW - hoursAgo * HOUR - 1 - Math.floor((i * (HOUR - 2)) / Math.max(n, 1)));

describe("coveredHours", () => {
  it("counts an hour only at 10 creates: one stray create does not, exactly 10 does", () => {
    expect(coveredHours(inHour(3, 1), NOW, 24, 10)).toBe(0);
    expect(coveredHours(inHour(3, 9), NOW, 24, 10)).toBe(0);
    expect(coveredHours(inHour(3, 10), NOW, 24, 10)).toBe(1);
  });

  it("reads a restart after a long pause as 1 of 24: 24 h of creates, a 40 h gap, then 1 h of creates", () => {
    // The as-of time is 1 h after the restart; everything before the 40 h gap is older than the window.
    const creates = [...inHour(0, 300), ...Array.from({ length: 24 }, (_, h) => inHour(41 + h, 300)).flat()];
    expect(coveredHours(creates, NOW, 24, 10)).toBe(1);
    expect(coveredHours(creates, NOW, 6, 10)).toBe(1);
  });

  it("gives 16 of 24 when 8 hours are missing in the middle", () => {
    const creates = Array.from({ length: 24 }, (_, h) => (h >= 8 && h < 16 ? [] : inHour(h, 50))).flat();
    expect(coveredHours(creates, NOW, 24, 10)).toBe(16);
  });

  it("checks the 6 h window on its own six buckets", () => {
    const creates = [0, 1, 2, 5, 6, 7].flatMap((h) => inHour(h, 20)); // hours 6 and 7 ago are outside the 6 h window
    expect(coveredHours(creates, NOW, 6, 10)).toBe(4);
    expect(coveredHours(creates, NOW, 24, 10)).toBe(6);
  });

  it("ignores creates after the as-of time and before the window", () => {
    expect(coveredHours([...inHour(-1, 50), ...inHour(24, 50)], NOW, 24, 10)).toBe(0);
  });
});

describe("metaCoverage", () => {
  it("reports covered and window length for both windows", () => {
    const c = metaCoverage([...inHour(0, 10), ...inHour(10, 10)], NOW, 10);
    expect(c).toEqual({ "6h": { covered: 1, of: 6 }, "24h": { covered: 2, of: 24 } });
  });
});

describe("coverageNote", () => {
  const cov = (covered: number, window: "6h" | "24h" = "24h") => ({ "6h": { covered: window === "6h" ? covered : 6, of: 6 }, "24h": { covered: window === "24h" ? covered : 24, of: 24 } });

  it('says "Only 1 h of data in the last 24 h" for a fresh start (singular)', () => {
    expect(coverageNote(cov(1), "24h", 0.8)).toBe("Only 1 h of data in the last 24 h");
  });

  it("uses the plain plural for a gap that is not a fresh start", () => {
    expect(coverageNote(cov(14), "24h", 0.8)).toBe("Only 14 h of data in the last 24 h");
  });

  it("words the 6 h window on its own", () => {
    expect(coverageNote(cov(3, "6h"), "6h", 0.8)).toBe("Only 3 h of data in the last 6 h");
    expect(coverageNote(cov(3, "6h"), "24h", 0.8)).toBeNull(); // the 24 h window is fully covered
  });

  it("is null for full coverage, for exactly the threshold and for unknown coverage", () => {
    expect(coverageNote(cov(24), "24h", 0.8)).toBeNull();
    expect(coverageNote(cov(20), "24h", 0.8)).toBeNull(); // 20 of 24 is above 80% (19.2)
    expect(coverageNote(cov(19), "24h", 0.8)).toBe("Only 19 h of data in the last 24 h");
    expect(coverageNote(cov(12), "24h", 0.5)).toBeNull(); // exactly 50%
    expect(coverageNote(cov(11), "24h", 0.5)).not.toBeNull();
    expect(coverageNote(null, "24h", 0.8)).toBeNull();
    expect(coverageNote(undefined, "6h", 0.8)).toBeNull();
  });

  it("isThin treats unknown as not thin", () => {
    expect(isThin(null, 0.8)).toBe(false);
    expect(isThin({ covered: 1, of: 24 }, 0.8)).toBe(true);
  });
});
