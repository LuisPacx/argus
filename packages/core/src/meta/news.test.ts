import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import { META_RULE } from "./config.ts";
import { headlineNamesKey, matchingNews, newsForKeys } from "./news.ts";
import type { ContextHeadline } from "./store.ts";

const NOW = new Date("2026-11-12T15:00:00.000Z");
const head = (title: string, over: Partial<ContextHeadline> = {}): ContextHeadline => ({ sourceId: "rss:wired", sourceLabel: "Wired", title, url: "https://example.com/a", publishedAt: "2026-11-12T12:00:00.000Z", ...over });

describe("headlineNamesKey", () => {
  it("matches headlines that name the subject, whatever the case, punctuation or possessive", () => {
    for (const t of ["Nvidia CEO Jensen Huang says AI demand is up", "JENSEN HUANG: a keynote", "Jensen's keynote draws crowds", "Why Jensen? Because chips"]) expect(headlineNamesKey(t, "jensen"), t).toBe(true);
  });

  it("does not match an unrelated headline, a part of a longer word, or a generic or too-short key", () => {
    expect(headlineNamesKey("Fed holds rates steady", "jensen")).toBe(false);
    expect(headlineNamesKey("Jensenville council votes", "jensen")).toBe(false);
    expect(headlineNamesKey("A new cat café opens", "cat")).toBe(false); // generic
    expect(headlineNamesKey("The new thing", "new")).toBe(false);
    expect(headlineNamesKey("Big news from AI labs", "ai")).toBe(false);
    expect(headlineNamesKey("GPU prices", "gpu")).toBe(false); // under the minimum key length
    expect(headlineNamesKey("anything", "")).toBe(false);
  });

  it("matches multi-word keys as adjacent words and a joined key as one word or two", () => {
    expect(headlineNamesKey("Ni Hao greetings spread online", "ni hao")).toBe(true);
    expect(headlineNamesKey("Hao Ni is unrelated", "ni hao")).toBe(false);
    expect(headlineNamesKey("Nihao trend", "ni hao")).toBe(true);
    expect(headlineNamesKey("GTA 6 trailer lands", "gta6")).toBe(true);
    expect(headlineNamesKey("GTA6 delayed", "gta6")).toBe(true);
  });

  it("handles a 10,000-character headline and regexp metacharacters without building a pattern, in linear time", () => {
    const long = `${"word ".repeat(2_000)}Jensen`;
    const started = performance.now();
    expect(headlineNamesKey(long, "jensen")).toBe(false); // read only up to a bounded prefix: a bounded cost, not a hang
    expect(headlineNamesKey(`${"a".repeat(10_000)}!`, "jensen")).toBe(false);
    expect(headlineNamesKey("(a+)+$ .* [x] \\ Jensen", "jensen")).toBe(true);
    expect(headlineNamesKey("(a+)+$ Jensen", "(a+)+$ jensen")).toBe(false); // a key is normalised text, never a pattern
    expect(headlineNamesKey(`${"(".repeat(10_000)}jensen`, "jensen")).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("matchingNews", () => {
  it("keeps the matches in the given (newest first) order, one line per story, at most five", () => {
    const news = [
      head("Jensen Huang on stage", { sourceLabel: "A" }),
      head("Unrelated story"),
      head("Jensen Huang on stage", { sourceLabel: "B" }),
      ...[1, 2, 3, 4, 5, 6].map((n) => head(`Jensen update ${n}`)),
    ];
    const out = matchingNews(news, "jensen");
    expect(out.map((n) => n.title)).toEqual(["Jensen Huang on stage", "Jensen update 1", "Jensen update 2", "Jensen update 3", "Jensen update 4"]);
    expect(out[0]!.sourceLabel).toBe("A");
  });
});

describe("newsForKeys: context only, last 24 h", () => {
  it("reads context-class Signals only (never a launchpad Signal), inside the window, newest first", () => {
    const store = Datastore.open(":memory:");
    const sig = (id: string, sourceId: string, title: string, publishedAt: string) => ({ id, sourceId, sourceLabel: sourceId, title, summary: "", url: "https://example.com/x", publishedAt });
    store.recordSignals([
      sig("rss:1", "rss:wired", "Jensen Huang keynote", "2026-11-12T10:00:00.000Z"),
      sig("rss:2", "rss:wired", "Jensen at CES", "2026-11-12T13:00:00.000Z"),
      sig("rss:old", "rss:wired", "Jensen from two days ago", "2026-11-10T13:00:00.000Z"),
      sig("rss:future", "rss:wired", "Jensen tomorrow", "2026-11-13T13:00:00.000Z"),
      sig("pp:1", "pumpportal:events", "New token on pump: Jensen ($JENSEN)", "2026-11-12T14:00:00.000Z"),
      sig("trends:1", "trends:google", "jensen huang", "2026-11-12T11:00:00.000Z"),
    ]);
    const out = newsForKeys(store, ["jensen"], NOW, META_RULE).get("jensen")!;
    expect(out.map((n) => n.title)).toEqual(["Jensen at CES", "jensen huang", "Jensen Huang keynote"]);
  });

  it("makes no read for no keys", () => {
    let reads = 0;
    expect(newsForKeys({ contextHeadlines: () => (reads++, []) }, [], NOW).size).toBe(0);
    expect(reads).toBe(0);
  });
});
