import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore } from "./datastore.ts";
import { ingestSources } from "./ingest.ts";
import { loadRssSources } from "./sources/feeds.ts";
import { RssSource } from "./sources/rss.ts";
import type { Signal, Source } from "./sources/source.ts";
import { tempDir } from "./testing/temp.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const feed = (id: string, xml: string) => new RssSource({ id, label: id.toUpperCase(), url: `https://${id}.example/feed`, fetchText: async () => xml });
const sig = (n: number, over: Partial<Signal> = {}): Signal => ({
  id: `s:${n}`,
  sourceId: "s",
  sourceLabel: "S",
  title: `t${n}`,
  summary: "",
  url: `https://e.example/${n}`,
  publishedAt: `2026-06-${String(10 + n).padStart(2, "0")}T00:00:00.000Z`,
  ...over,
});

describe("Signals in the Datastore", () => {
  it("stores Signals and lists the latest first", () => {
    const ds = Datastore.open(":memory:");
    expect(ds.recordSignals([sig(1), sig(3), sig(2)])).toBe(3);
    expect(ds.latestSignals().map((s) => s.title)).toEqual(["t3", "t2", "t1"]);
    expect(ds.latestSignals()[0]).toEqual({ ...sig(3), ingestedAt: expect.any(String) });
  });

  it("does not store a Signal seen again, within a batch or across polls", () => {
    const ds = Datastore.open(":memory:");
    expect(ds.recordSignals([sig(1), sig(1)])).toBe(1);
    expect(ds.recordSignals([sig(1), sig(2)])).toBe(1);
    expect(ds.recordSignals([sig(1), sig(2)])).toBe(0);
    expect(ds.latestSignals()).toHaveLength(2);
  });

  it("keeps the first observation when an item comes back changed", () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals([sig(1)]);
    ds.recordSignals([sig(1, { title: "edited" })]);
    expect(ds.latestSignals().map((s) => s.title)).toEqual(["t1"]);
  });

  it("limits the list", () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals([sig(1), sig(2), sig(3)]);
    expect(ds.latestSignals(2).map((s) => s.title)).toEqual(["t3", "t2"]);
  });

  it("migrates an existing database additively and repeatedly", () => {
    const dir = tempDir("argus-signals-");
    const path = join(dir, "argus.db");
    const first = Datastore.open(path);
    const p = first.createProposal({ narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: "Cat", ticker: "CAT", description: "d", evidenceLinks: [] });
    first.recordSignals([sig(1)]);
    first.close();
    const again = Datastore.open(path);
    expect(again.getProposal(p.id)?.name).toBe("Cat");
    expect(again.latestSignals()).toHaveLength(1);
    again.close();
  });
});

describe("ingestSources", () => {
  it("stores every Source's Signals and stores nothing twice on the next poll", async () => {
    const ds = Datastore.open(":memory:");
    const sources = [feed("tech", fixture("tech-news.rss.xml")), feed("other", fixture("other-feed.rss.xml"))];
    const lines: string[] = [];
    expect(await ingestSources(ds, sources, (l) => lines.push(l))).toEqual({ stored: 5, failed: 0 });
    expect(await ingestSources(ds, sources, (l) => lines.push(l))).toEqual({ stored: 0, failed: 0 });
    expect(ds.latestSignals(50)).toHaveLength(5);
  });

  it("logs a failing feed and still ingests the others", async () => {
    const ds = Datastore.open(":memory:");
    const broken: Source = {
      id: "broken",
      label: "Broken",
      poll: async () => {
        throw new Error("RSS fetch failed: 503 Service Unavailable");
      },
    };
    const lines: string[] = [];
    const result = await ingestSources(ds, [broken, feed("other", fixture("other-feed.rss.xml"))], (l) => lines.push(l));
    expect(result).toEqual({ stored: 1, failed: 1 });
    expect(lines.join("\n")).toContain("broken");
    expect(lines.join("\n")).toContain("503");
    expect(ds.latestSignals().map((s) => s.sourceId)).toEqual(["other"]);
  });

});

describe("loadRssSources (the feed list is data)", () => {
  const write = (json: unknown) => {
    const path = join(tempDir("argus-feeds-"), "rss-feeds.json");
    writeFileSync(path, typeof json === "string" ? json : JSON.stringify(json));
    return path;
  };

  it("builds an RSS Source per entry", () => {
    const sources = loadRssSources(write([{ id: "rss:a", label: "A", url: "https://a.example/feed" }, { id: "rss:b", label: "B", url: "http://b.example/rss" }]));
    expect(sources.map((s) => [s.id, s.label])).toEqual([["rss:a", "A"], ["rss:b", "B"]]);
  });

  it.each([
    ["not JSON", "{"],
    ["not an array", { id: "a" }],
    ["a missing label", [{ id: "rss:a", url: "https://a.example/f" }]],
    ["a non-http url", [{ id: "rss:a", label: "A", url: "file:///etc/passwd" }]],
    ["a duplicate id", [{ id: "rss:a", label: "A", url: "https://a.example/f" }, { id: "rss:a", label: "B", url: "https://b.example/f" }]],
  ])("rejects %s", (_name, json) => {
    expect(() => loadRssSources(write(json))).toThrow();
  });
});
