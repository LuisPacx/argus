import { afterEach, describe, expect, it, vi } from "vitest";
import { fmtWhen } from "../../app/utils/format.ts";
import { whyView } from "../../app/utils/why.ts";

/**
 * fmtWhen time zone (War Room ticket 16). Same pattern as the relative times (ticket 15): with a clock of 0 (server render and first client
 * render) the text is fixed UTC and does not depend on the host zone; once the clock is set it is the viewer's zone. TZ is pinned per case.
 */
const ORIGINAL_TZ = process.env.TZ;
const iso = "2026-11-06T23:49:00.000Z";
const NOW = Date.parse("2026-11-17T12:00:00Z");

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("fmtWhen", () => {
  it("with clock 0 gives the same UTC text in every host zone", () => {
    const out = ["UTC", "Asia/Tokyo", "America/Sao_Paulo"].map((tz) => {
      process.env.TZ = tz;
      return fmtWhen(iso, 0);
    });
    expect(out).toEqual(["6 Nov 23:49 UTC", "6 Nov 23:49 UTC", "6 Nov 23:49 UTC"]);
  });

  it("with a real clock gives the viewer's zone with a zone hint", () => {
    process.env.TZ = "America/Sao_Paulo";
    expect(fmtWhen(iso, NOW)).toBe("6 Nov 20:49 GMT-3");
    process.env.TZ = "Asia/Tokyo";
    expect(fmtWhen(iso, NOW)).toBe("7 Nov 08:49 GMT+9");
  });

  it("shows the year when it is not the current one in the viewer's zone", () => {
    process.env.TZ = "Asia/Tokyo";
    expect(fmtWhen("2025-03-02T10:05:00.000Z", NOW)).toBe("2 Mar 2025 19:05 GMT+9");
    // 2026-12-31T22:00Z is already 2027 in Tokyo: not the current year when the clock reads 2026 there.
    expect(fmtWhen("2026-12-31T22:00:00.000Z", Date.parse("2026-12-31T12:00:00Z"))).toBe("1 Jan 2027 07:00 GMT+9");
  });

  it("returns empty text for a bad date", () => {
    expect(fmtWhen("nope", 0)).toBe("");
    expect(fmtWhen("nope", NOW)).toBe("");
  });

  it("whyView carries the full timestamp beside the text", () => {
    const input = { reason: "", interaction: "", evidenceLinks: [], score: null, signals: [{ title: "t", sourceLabel: "s", url: "https://e.com", publishedAt: iso }] };
    expect(whyView(input).signals[0]).toMatchObject({ when: "6 Nov 23:49 UTC", whenIso: iso });
    process.env.TZ = "America/Sao_Paulo";
    expect(whyView(input, NOW).signals[0]?.when).toBe("6 Nov 20:49 GMT-3");
  });
});
