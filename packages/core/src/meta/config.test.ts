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

  it("the graduation rule defaults are the Operator's numbers (graduation Meta spec): 10 in 24 h, stay at 5, 6 creators, 3 in 6 h; Watching at 5 or 3 in 6 h", () => {
    expect(META_RULE).toMatchObject({ metaMinGrads: 10, metaStayGrads: 5, metaMinCreators: 6, metaLiveGrads6h: 3, watchMinGrads: 5, watchGrads6h: 3, maxMetas: 3, watching: 3, leaderCalls: 4, stateMaxMinutes: 120 });
    expect(META_RULE).not.toHaveProperty("stayMcapUsd"); // market cap left the rule
    expect(META_RULE).not.toHaveProperty("minCopies");
  });

  it("the exit hysteresis defaults (ADR 0020) are 45 minutes of cooling and a 6 h New Meta re-entry guard; each is bounded and 0 is allowed", () => {
    expect(META_RULE).toMatchObject({ metaExitMinutes: 45, reentryMinutes: 360 });
    expect(metaConfigFromEnv({ ARGUS_META_EXIT_MINUTES: "0", ARGUS_META_REENTRY_MINUTES: "0" })).toMatchObject({ metaExitMinutes: 0, reentryMinutes: 0 });
    expect(metaConfigFromEnv({ ARGUS_META_EXIT_MINUTES: "90", ARGUS_META_REENTRY_MINUTES: "720" })).toMatchObject({ metaExitMinutes: 90, reentryMinutes: 720 });
    expect(metaConfigFromEnv({ ARGUS_META_EXIT_MINUTES: "1441", ARGUS_META_REENTRY_MINUTES: "10081" })).toMatchObject({ metaExitMinutes: 45, reentryMinutes: 360 });
    expect(metaConfigFromEnv({ ARGUS_META_EXIT_MINUTES: "-1", ARGUS_META_REENTRY_MINUTES: "x" })).toMatchObject({ metaExitMinutes: 45, reentryMinutes: 360 });
  });

  it("reads each graduation knob and the other Meta knobs, bounded, and junk keeps the default", () => {
    const c = metaConfigFromEnv({
      ARGUS_META_MIN_GRADS: "12", ARGUS_META_STAY_GRADS: "6", ARGUS_META_GRAD_CREATORS: "8", ARGUS_META_LIVE_GRADS_6H: "4", ARGUS_META_WATCH_MIN_GRADS: "7", ARGUS_META_WATCH_GRADS_6H: "2",
      ARGUS_META_ENTER_MCAP_USD: "2000000", ARGUS_META_MAX_METAS: "2", ARGUS_META_WATCHING: "0", ARGUS_META_LEADER_CALLS: "6", ARGUS_META_STATE_MAX_MINUTES: "60",
    });
    expect(c).toMatchObject({ metaMinGrads: 12, metaStayGrads: 6, metaMinCreators: 8, metaLiveGrads6h: 4, watchMinGrads: 7, watchGrads6h: 2, enterMcapUsd: 2_000_000, maxMetas: 2, watching: 0, leaderCalls: 6, stateMaxMinutes: 60 });
    const junk = metaConfigFromEnv({
      ARGUS_META_MIN_GRADS: "0", ARGUS_META_STAY_GRADS: "-5", ARGUS_META_GRAD_CREATORS: "1001", ARGUS_META_LIVE_GRADS_6H: "x", ARGUS_META_WATCH_MIN_GRADS: "1.5", ARGUS_META_WATCH_GRADS_6H: "",
      ARGUS_META_ENTER_MCAP_USD: "lots", ARGUS_META_MAX_METAS: "99", ARGUS_META_WATCHING: "1.5", ARGUS_META_LEADER_CALLS: "999", ARGUS_META_STATE_MAX_MINUTES: "0",
    });
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

  it("the organic-score line for crediting the list's liquidity is 50 by default, bounded 0 to 100, junk keeps 50", () => {
    expect(META_RULE.topDownMinOrganicScore).toBe(50);
    expect(metaConfigFromEnv({ ARGUS_META_TOPDOWN_MIN_ORGANIC: "70" }).topDownMinOrganicScore).toBe(70);
    expect(metaConfigFromEnv({ ARGUS_META_TOPDOWN_MIN_ORGANIC: "0" }).topDownMinOrganicScore).toBe(0);
    expect(metaConfigFromEnv({ ARGUS_META_TOPDOWN_MIN_ORGANIC: "100" }).topDownMinOrganicScore).toBe(100);
    for (const raw of ["101", "-1", "x", "", "50.5"]) expect(metaConfigFromEnv({ ARGUS_META_TOPDOWN_MIN_ORGANIC: raw }).topDownMinOrganicScore, raw).toBe(50);
  });

  it("a stay above enter keeps both defaults, and stay equal to enter is allowed", () => {
    expect(metaConfigFromEnv({ ARGUS_META_MIN_GRADS: "8", ARGUS_META_STAY_GRADS: "9" })).toMatchObject({ metaMinGrads: 10, metaStayGrads: 5 });
    expect(metaConfigFromEnv({ ARGUS_META_STAY_GRADS: "11" })).toMatchObject({ metaMinGrads: 10, metaStayGrads: 5 });
    expect(metaConfigFromEnv({ ARGUS_META_MIN_GRADS: "6", ARGUS_META_STAY_GRADS: "6" })).toMatchObject({ metaMinGrads: 6, metaStayGrads: 6 });
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
