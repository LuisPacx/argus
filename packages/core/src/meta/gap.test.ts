import { describe, expect, it } from "vitest";
import { windowGap } from "./gap.ts";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

describe("windowGap", () => {
  it("is null with no gaps, a gap before the window, or a blip under 5 minutes", () => {
    expect(windowGap([], NOW, 24)).toBeNull();
    expect(windowGap([{ startedAt: at(40), endedAt: at(30) }], NOW, 24)).toBeNull();
    expect(windowGap([{ startedAt: at(3), endedAt: new Date(NOW - 3 * 3_600_000 + 60_000).toISOString() }], NOW, 24)).toBeNull();
  });

  it("reports the last gap and the whole hours of the window it leaves", () => {
    const g = windowGap([{ startedAt: at(10), endedAt: at(6) }], NOW, 24);
    expect(g).toEqual({ from: at(10), to: at(6), covered: 20, of: 24, endedAt: at(6) });
  });

  it("clips a gap that began before the window and does not count overlapping gaps twice", () => {
    expect(windowGap([{ startedAt: at(30), endedAt: at(20) }], NOW, 24)).toMatchObject({ covered: 20, from: at(30) });
    const g = windowGap([{ startedAt: at(10), endedAt: at(6) }, { startedAt: at(8), endedAt: at(4) }], NOW, 24);
    expect(g).toMatchObject({ covered: 18, to: at(4), endedAt: at(4) });
  });

  it("an open gap runs to now and has no end for the counter", () => {
    expect(windowGap([{ startedAt: at(2), endedAt: null }], NOW, 24)).toEqual({ from: at(2), to: null, covered: 22, of: 24, endedAt: null });
  });
});
