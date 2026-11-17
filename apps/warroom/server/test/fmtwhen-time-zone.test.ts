import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * fmtWhen time zone (War Room ticket 16). The server renders fmtWhen in its own zone and the browser hydrates in the viewer's, so the
 * text must not depend on TZ. Each zone gets a fresh import because the Intl formatters are built at module load.
 */
const ORIGINAL_TZ = process.env.TZ;
const loadIn = async (tz: string) => {
  process.env.TZ = tz;
  vi.resetModules();
  return (await import("../../app/utils/format.ts")).fmtWhen;
};

afterEach(() => {
  vi.useRealTimers();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("fmtWhen", () => {
  it("gives the same text in every time zone, labelled UTC", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-17T12:00:00Z"), toFake: ["Date"] });
    const iso = "2026-11-06T23:49:00.000Z";
    const utc = (await loadIn("UTC"))(iso);
    const tokyo = (await loadIn("Asia/Tokyo"))(iso);
    const la = (await loadIn("America/Los_Angeles"))(iso);
    expect(utc).toBe("6 Nov 23:49 UTC");
    expect(tokyo).toBe(utc);
    expect(la).toBe(utc);
  });

  it("decides the year in UTC, not in the host zone", async () => {
    // 2026-12-31T23:30Z is already 2027 in Tokyo; the clock below is 2026 in UTC but 2027 in Tokyo.
    vi.useFakeTimers({ now: Date.parse("2026-12-31T23:30:00Z"), toFake: ["Date"] });
    const fmt = await loadIn("Asia/Tokyo");
    expect(fmt("2026-12-31T22:00:00.000Z")).toBe("31 Dec 22:00 UTC");
    expect(fmt("2025-03-02T10:05:00.000Z")).toBe("2 Mar 2025 10:05 UTC");
  });
});
