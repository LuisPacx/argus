import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DexScreenerTrendingSource } from "./dexscreener.ts";
import { loadRssSources } from "./feeds.ts";
import { GitHubTrendingSource } from "./github-trending.ts";
import { GoogleTrendsSource } from "./google-trends.ts";
import { PumpPortalSource } from "./pumpportal.ts";
import { MARKET_SOURCE_IDS, SOURCE_CLASS, SOURCE_CLASS_PREFIX, sourceClass } from "./source-class.ts";

const FEEDS = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..", "config", "rss-feeds.json");

describe("Source class", () => {
  it("market for PumpPortal and DexScreener, context for news, Trends and GitHub", () => {
    expect(sourceClass("pumpportal:events")).toBe("market");
    expect(sourceClass("dexscreener:trending")).toBe("market");
    expect(sourceClass("rss:techcrunch")).toBe("context");
    expect(sourceClass("trends:google")).toBe("context");
    expect(sourceClass("github:trending")).toBe("context");
  });

  it("an unknown or new Source is context until it is declared market", () => {
    expect(sourceClass("telegram:channels")).toBe("context");
    expect(sourceClass("tiktok:trending")).toBe("context");
    expect(sourceClass("")).toBe("context");
  });

  it("every registered Source has an explicit entry (an exact id or an id prefix)", () => {
    const registered = [
      new PumpPortalSource().id,
      new DexScreenerTrendingSource().id,
      new GoogleTrendsSource().id,
      new GitHubTrendingSource().id,
      ...loadRssSources(FEEDS).map((s) => s.id),
    ];
    expect(registered.length).toBeGreaterThan(4);
    for (const id of registered) {
      const explicit = id in SOURCE_CLASS || Object.keys(SOURCE_CLASS_PREFIX).some((p) => id.startsWith(p));
      expect(explicit, `${id} has no entry in source-class.ts`).toBe(true);
    }
  });

  it("the market id list is derived from the one table", () => {
    expect([...MARKET_SOURCE_IDS].sort()).toEqual(["dexscreener:trending", "pumpportal:events"]);
  });
});
