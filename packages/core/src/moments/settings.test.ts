import { describe, expect, it } from "vitest";
import { momentSettingsFromEnv } from "./settings.ts";

const TOPIC = JSON.stringify({ label: "GTA VI", startsAt: "2026-11-19T05:00:00Z", spellings: ["GTA VI", "GTA 6", "GTA6"] });

describe("momentSettingsFromEnv", () => {
  it("is off by default and needs no topic then, even a broken one", () => {
    expect(momentSettingsFromEnv({})).toEqual({ enabled: false, intervalMinutes: 30, loadsPerDay: 100, topic: null });
    expect(momentSettingsFromEnv({ ARGUS_MOMENT_TOPIC: "not json", ARGUS_MOMENTS: "0" }).enabled).toBe(false);
    for (const v of ["true", "yes", "on", " 1", "2"]) expect(momentSettingsFromEnv({ ARGUS_MOMENTS: v }).enabled, v).toBe(false);
  });

  it("is on only for the exact string 1, with a valid topic", () => {
    const s = momentSettingsFromEnv({ ARGUS_MOMENTS: "1", ARGUS_MOMENT_TOPIC: TOPIC });
    expect(s).toMatchObject({ enabled: true, intervalMinutes: 30, loadsPerDay: 100, topic: { label: "GTA VI" } });
    expect(() => momentSettingsFromEnv({ ARGUS_MOMENTS: "1" })).toThrow(/needs ARGUS_MOMENT_TOPIC/);
    expect(() => momentSettingsFromEnv({ ARGUS_MOMENTS: "1", ARGUS_MOMENT_TOPIC: "{}" })).toThrow(/label/);
  });

  it("ARGUS_MOMENT_LOADS_PER_DAY can only lower the cap: 500 and 150 are errors, 50 lowers it", () => {
    expect(() => momentSettingsFromEnv({ ARGUS_MOMENT_LOADS_PER_DAY: "500" })).toThrow(/ARGUS_MOMENT_LOADS_PER_DAY/);
    expect(() => momentSettingsFromEnv({ ARGUS_MOMENT_LOADS_PER_DAY: "150" })).toThrow(/can only lower/);
    expect(() => momentSettingsFromEnv({ ARGUS_MOMENT_LOADS_PER_DAY: "0" })).toThrow();
    expect(() => momentSettingsFromEnv({ ARGUS_MOMENT_LOADS_PER_DAY: "many" })).toThrow();
    expect(momentSettingsFromEnv({ ARGUS_MOMENT_LOADS_PER_DAY: "50" }).loadsPerDay).toBe(50);
    expect(momentSettingsFromEnv({ ARGUS_MOMENT_LOADS_PER_DAY: "100" }).loadsPerDay).toBe(100);
    expect(momentSettingsFromEnv({ ARGUS_MOMENT_LOADS_PER_DAY: "" }).loadsPerDay).toBe(100);
  });

  it("ARGUS_MOMENT_INTERVAL_MIN is 30 by default and at least 15", () => {
    expect(momentSettingsFromEnv({ ARGUS_MOMENT_INTERVAL_MIN: "15" }).intervalMinutes).toBe(15);
    expect(momentSettingsFromEnv({ ARGUS_MOMENT_INTERVAL_MIN: "60" }).intervalMinutes).toBe(60);
    for (const v of ["14", "0", "-5", "1.5", "soon", "99999"]) expect(() => momentSettingsFromEnv({ ARGUS_MOMENT_INTERVAL_MIN: v }), v).toThrow(/ARGUS_MOMENT_INTERVAL_MIN/);
  });
});
