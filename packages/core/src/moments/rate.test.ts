import { describe, expect, it } from "vitest";
import { isRising, recentRate, viewsPerHour } from "./rate.ts";
import { statusIdTime } from "./status-id.ts";

const at = (hhmm: string) => new Date(`2026-11-19T${hhmm}:00Z`);

describe("viewsPerHour", () => {
  it("120,000 views on a post 2 h old is 60,000 an hour, and rising", () => {
    const rate = viewsPerHour(120_000, at("10:00"), at("12:00"));
    expect(rate).toBeCloseTo(60_000, 5);
    expect(isRising(rate, null)).toBe(true);
  });

  it("15,000 views on a post 10 minutes old does not rate (age and views floors)", () => {
    expect(viewsPerHour(15_000, at("10:00"), at("10:10"))).toBeNull();
    expect(viewsPerHour(30_000, at("10:00"), at("10:10"))).toBeNull(); // young, though enough views
    expect(viewsPerHour(15_000, at("10:00"), at("12:00"))).toBeNull(); // old enough, too few views
  });

  it("a post 29 minutes old does not rate; at 30 minutes it does", () => {
    expect(viewsPerHour(50_000, at("10:00"), new Date(at("10:00").getTime() + 29 * 60_000))).toBeNull();
    expect(viewsPerHour(50_000, at("10:00"), new Date(at("10:00").getTime() + 30 * 60_000))).toBeCloseTo(100_000, 5);
  });

  it("null views never rate, and neither does NaN", () => {
    expect(viewsPerHour(null, at("10:00"), at("14:00"))).toBeNull();
    expect(viewsPerHour(Number.NaN, at("10:00"), at("14:00"))).toBeNull();
    expect(isRising(null, null)).toBe(false);
  });

  it("a post that is dated after the reading does not rate", () => {
    expect(viewsPerHour(100_000, at("12:00"), at("10:00"))).toBeNull();
  });
});

describe("FelpsCrypto's Area 51 clip (gta6-post-release.md)", () => {
  const posted = statusIdTime("2123359908179415231")!; // 10:17 UTC
  const first = { at: at("13:55"), views: 148_000 };
  const second = { at: at("15:10"), views: 638_000 };

  it("is not rising by the average at 13:55 (about 41K an hour)", () => {
    const avg = viewsPerHour(first.views, posted, first.at)!;
    expect(Math.round(avg / 1000)).toBe(41);
    expect(isRising(avg, null)).toBe(false);
  });

  it("is rising by the recent rate at 15:10 (about 390K an hour)", () => {
    const recent = recentRate(first, second, posted)!;
    expect(Math.round(recent / 10_000) * 10).toBe(390);
    expect(isRising(viewsPerHour(second.views, posted, second.at), recent)).toBe(true);
  });
});

describe("recentRate", () => {
  const posted = at("10:00");
  it("needs both readings to show views, 15 minutes between them and no fall in the count", () => {
    expect(recentRate({ at: at("12:00"), views: null }, { at: at("13:00"), views: 90_000 }, posted)).toBeNull();
    expect(recentRate({ at: at("12:00"), views: 50_000 }, { at: at("13:00"), views: null }, posted)).toBeNull();
    expect(recentRate({ at: at("12:00"), views: 50_000 }, { at: at("12:10"), views: 90_000 }, posted)).toBeNull(); // 10 minutes apart
    expect(recentRate({ at: at("12:00"), views: 90_000 }, { at: at("13:00"), views: 80_000 }, posted)).toBeNull(); // went down
    expect(recentRate({ at: at("12:00"), views: 50_000 }, { at: at("12:15"), views: 90_000 }, posted)).toBeCloseTo(160_000, 5);
  });

  it("does not rate a post that is under the floor at the later reading", () => {
    expect(recentRate({ at: at("10:05"), views: 1_000 }, { at: at("10:25"), views: 15_000 }, posted)).toBeNull();
  });
});

describe("isRising", () => {
  it("is the bar of 50,000 an hour on either rate", () => {
    expect(isRising(49_999, null)).toBe(false);
    expect(isRising(50_000, null)).toBe(true);
    expect(isRising(null, 50_000)).toBe(true);
    expect(isRising(10, 49_999)).toBe(false);
  });
});
