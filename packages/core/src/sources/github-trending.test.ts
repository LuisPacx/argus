import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GitHubTrendingSource } from "./github-trending.ts";

const fixture = readFileSync(join(import.meta.dirname, "../fixtures", "github-search.json"), "utf8");
const source = (body: string, extra: { now?: () => Date; log?: (m: string) => void } = {}) => new GitHubTrendingSource({ fetchText: async () => body, ...extra });

describe("GitHubTrendingSource", () => {
  it("has a stable id and a label", () => {
    const s = source("");
    expect([s.id, s.label]).toEqual(["github:trending", "GitHub trending"]);
  });

  it("normalizes the recorded search response, dropping malformed entries and unsafe links", async () => {
    const signals = await source(fixture).poll();
    expect(signals).toEqual([
      {
        id: "github:trending:octo-labs/agent-forge",
        sourceId: "github:trending",
        sourceLabel: "GitHub trending",
        title: "octo-labs/agent-forge",
        summary: "New on GitHub, 4,210 stars, 310 forks, TypeScript. Build autonomous coding agents in an afternoon",
        url: "https://github.com/octo-labs/agent-forge",
        publishedAt: "2026-11-02T09:15:00.000Z",
      },
      {
        id: "github:trending:someone/tiny-db",
        sourceId: "github:trending",
        sourceLabel: "GitHub trending",
        title: "someone/tiny-db",
        summary: "New on GitHub, 980 stars, 12 forks.",
        url: "https://github.com/someone/tiny-db",
        publishedAt: "2026-11-04T18:00:00.000Z",
      },
      {
        id: "github:trending:evil/javascript-link",
        sourceId: "github:trending",
        sourceLabel: "GitHub trending",
        title: "evil/javascript-link",
        summary: "New on GitHub, 500 stars, 1 forks, Rust. bad link",
        url: "",
        publishedAt: "2026-11-03T00:00:00.000Z",
      },
    ]);
  });

  it("gives a repo the same id on every poll", async () => {
    const a = await source(fixture).poll();
    const b = await source(fixture).poll();
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
  });

  it("asks the public search API for repos created in the last 7 days, most starred first", async () => {
    const fetchText = vi.fn(async (_url: string) => fixture);
    await new GitHubTrendingSource({ fetchText, now: () => new Date("2026-11-06T12:00:00Z") }).poll();
    const url = new URL(fetchText.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe("https://api.github.com/search/repositories");
    expect(url.searchParams.get("q")).toBe("created:>2026-10-30");
    expect(url.searchParams.get("sort")).toBe("stars");
    expect(url.searchParams.get("order")).toBe("desc");
  });

  it("returns no Signals for a genuinely empty result", async () => {
    expect(await source('{"total_count":0,"items":[]}').poll()).toEqual([]);
  });

  it("fails loudly, and logs, when the response layout changed", async () => {
    const log = vi.fn();
    await expect(source('{"results":[]}', { log }).poll()).rejects.toThrow(/unexpected search response/);
    await expect(source("<html>rate limited</html>", { log }).poll()).rejects.toThrow();
    expect(log).toHaveBeenCalled();
  });

  it("fails loudly when entries exist but none can be read", async () => {
    const log = vi.fn();
    await expect(source('{"total_count":2,"items":[{"x":1},{"y":2}]}', { log }).poll()).rejects.toThrow(/none of 2/);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/layout/));
  });
});
