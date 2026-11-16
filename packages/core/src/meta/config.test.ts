import { describe, expect, it } from "vitest";
import { DEFAULT_META_INTERVAL_MINUTES, META_RULE, metaConfigFromEnv, metaIntervalMinutes } from "./config.ts";

describe("meta config", () => {
  it("defaults to the ticket's documented rule and budget", () => {
    const c = metaConfigFromEnv({});
    expect(c).toEqual(META_RULE);
    expect(c.rankOrder).toEqual(["creators", "migrationsAfter60s", "marketCapUsd", "tokens"]);
    expect(c.dexMaxCalls).toBeLessThanOrEqual(60); // well under DexScreener's ~300 a minute
  });

  it("the rank order can be changed from the environment, in that one place", () => {
    expect(metaConfigFromEnv({ ARGUS_META_RANK_ORDER: "migrations, creators,tokens" }).rankOrder).toEqual(["migrations", "creators", "tokens"]);
  });

  it("junk in the rank order falls back to the default: unknown, repeated or empty keys", () => {
    for (const junk of ["", "creators,bogus", "creators,creators", " , ", "migrations;creators"])
      expect(metaConfigFromEnv({ ARGUS_META_RANK_ORDER: junk }).rankOrder).toEqual(META_RULE.rankOrder);
  });

  it("theme Metas are on by default and ARGUS_META_THEMES=0 switches them off", () => {
    expect(META_RULE.theme).not.toBeNull();
    expect(metaConfigFromEnv({ ARGUS_META_THEMES: "0" }).theme).toBeNull();
    expect(metaConfigFromEnv({ ARGUS_META_THEMES: "1" }).theme).toEqual(META_RULE.theme);
  });

  it("the market-led rule defaults are the user's numbers (ADR 0014)", () => {
    expect(META_RULE).toMatchObject({ enterMcapUsd: 1_000_000, stayMcapUsd: 500_000, minCopies: 10, maxMetas: 3, watching: 3, leaderCalls: 4, stateMaxMinutes: 120 });
  });

  it("reads each market-led knob, bounded, and junk keeps the default", () => {
    const c = metaConfigFromEnv({ ARGUS_META_ENTER_MCAP_USD: "2000000", ARGUS_META_STAY_MCAP_USD: "750000", ARGUS_META_MIN_COPIES: "12", ARGUS_META_MAX_METAS: "2", ARGUS_META_WATCHING: "0", ARGUS_META_LEADER_CALLS: "6", ARGUS_META_STATE_MAX_MINUTES: "60" });
    expect(c).toMatchObject({ enterMcapUsd: 2_000_000, stayMcapUsd: 750_000, minCopies: 12, maxMetas: 2, watching: 0, leaderCalls: 6, stateMaxMinutes: 60 });
    const junk = metaConfigFromEnv({ ARGUS_META_ENTER_MCAP_USD: "lots", ARGUS_META_STAY_MCAP_USD: "-5", ARGUS_META_MIN_COPIES: "0", ARGUS_META_MAX_METAS: "99", ARGUS_META_WATCHING: "1.5", ARGUS_META_LEADER_CALLS: "999", ARGUS_META_STATE_MAX_MINUTES: "0" });
    expect(junk).toEqual(META_RULE);
  });

  it("the top-down defaults are ADR 0015's: 5 requests a tick, $50,000 liquidity, 100 times, $50,000 volume", () => {
    expect(META_RULE).toMatchObject({ topDownCalls: 5, topDownMinLiquidityUsd: 50_000, topDownMaxCapLiquidityRatio: 100, topDownMinVolumeUsd: 50_000 });
  });

  it("reads each top-down knob, bounded, and junk keeps the default", () => {
    const c = metaConfigFromEnv({ ARGUS_META_TOPDOWN_CALLS: "3", ARGUS_META_TOPDOWN_MIN_LIQ_USD: "80000", ARGUS_META_TOPDOWN_MAX_CAP_LIQ_RATIO: "50", ARGUS_META_TOPDOWN_MIN_VOLUME_USD: "0" });
    expect(c).toMatchObject({ topDownCalls: 3, topDownMinLiquidityUsd: 80_000, topDownMaxCapLiquidityRatio: 50, topDownMinVolumeUsd: 0 });
    expect(metaConfigFromEnv({ ARGUS_META_TOPDOWN_CALLS: "10" }).topDownCalls).toBe(10);
    const junk = metaConfigFromEnv({ ARGUS_META_TOPDOWN_CALLS: "11", ARGUS_META_TOPDOWN_MIN_LIQ_USD: "-5", ARGUS_META_TOPDOWN_MAX_CAP_LIQ_RATIO: "0", ARGUS_META_TOPDOWN_MIN_VOLUME_USD: "1e9" });
    expect(junk).toEqual(META_RULE);
    for (const raw of ["", "x", "1.5", "0", "-1"]) expect(metaConfigFromEnv({ ARGUS_META_TOPDOWN_CALLS: raw }).topDownCalls, raw).toBe(5);
  });

  it("a stay above enter keeps both defaults, and stay equal to enter is allowed", () => {
    expect(metaConfigFromEnv({ ARGUS_META_ENTER_MCAP_USD: "400000", ARGUS_META_STAY_MCAP_USD: "800000" })).toMatchObject({ enterMcapUsd: 1_000_000, stayMcapUsd: 500_000 });
    expect(metaConfigFromEnv({ ARGUS_META_STAY_MCAP_USD: "1500000" })).toMatchObject({ enterMcapUsd: 1_000_000, stayMcapUsd: 500_000 });
    expect(metaConfigFromEnv({ ARGUS_META_ENTER_MCAP_USD: "600000", ARGUS_META_STAY_MCAP_USD: "600000" })).toMatchObject({ enterMcapUsd: 600_000, stayMcapUsd: 600_000 });
  });

  it("reads the DexScreener budget and the interval, ignoring junk and out-of-range numbers", () => {
    expect(metaConfigFromEnv({ ARGUS_META_DEX_GROUPS: "5", ARGUS_META_DEX_CALLS: "7" })).toMatchObject({ dexGroups: 5, dexMaxCalls: 7 });
    expect(metaConfigFromEnv({ ARGUS_META_DEX_GROUPS: "-1", ARGUS_META_DEX_CALLS: "100000" })).toMatchObject({ dexGroups: META_RULE.dexGroups, dexMaxCalls: META_RULE.dexMaxCalls });
    expect(metaIntervalMinutes({})).toBe(DEFAULT_META_INTERVAL_MINUTES);
    expect(metaIntervalMinutes({ ARGUS_META_INTERVAL_MINUTES: "5" })).toBe(5);
    expect(metaIntervalMinutes({ ARGUS_META_INTERVAL_MINUTES: "0" })).toBe(DEFAULT_META_INTERVAL_MINUTES);
    expect(metaIntervalMinutes({ ARGUS_META_INTERVAL_MINUTES: "x" })).toBe(DEFAULT_META_INTERVAL_MINUTES);
  });
});
