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

  it("reads the DexScreener budget and the interval, ignoring junk and out-of-range numbers", () => {
    expect(metaConfigFromEnv({ ARGUS_META_DEX_GROUPS: "5", ARGUS_META_DEX_CALLS: "7" })).toMatchObject({ dexGroups: 5, dexMaxCalls: 7 });
    expect(metaConfigFromEnv({ ARGUS_META_DEX_GROUPS: "-1", ARGUS_META_DEX_CALLS: "100000" })).toMatchObject({ dexGroups: META_RULE.dexGroups, dexMaxCalls: META_RULE.dexMaxCalls });
    expect(metaIntervalMinutes({})).toBe(DEFAULT_META_INTERVAL_MINUTES);
    expect(metaIntervalMinutes({ ARGUS_META_INTERVAL_MINUTES: "5" })).toBe(5);
    expect(metaIntervalMinutes({ ARGUS_META_INTERVAL_MINUTES: "0" })).toBe(DEFAULT_META_INTERVAL_MINUTES);
    expect(metaIntervalMinutes({ ARGUS_META_INTERVAL_MINUTES: "x" })).toBe(DEFAULT_META_INTERVAL_MINUTES);
  });
});
