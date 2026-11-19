import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRssSources } from "../sources/feeds.ts";
import { tempDir } from "../testing/temp.ts";
import { loadRadarFeeds } from "./feeds.ts";

/** The radar's own feed list (ticket 02): `config/radar-feeds.json`, apart from `config/rss-feeds.json` (ADR 0016 decision 1). */
const root = new URL("../../../../", import.meta.url);
const radarPath = new URL("config/radar-feeds.json", root).pathname;
const rssPath = new URL("config/rss-feeds.json", root).pathname;

describe("config/radar-feeds.json", () => {
  const feeds = loadRadarFeeds(radarPath);

  it("holds about 30 feeds, each with a unique radar: id, a label and an https url", () => {
    expect(feeds.length).toBeGreaterThanOrEqual(25);
    expect(feeds.length).toBeLessThanOrEqual(40);
    expect(new Set(feeds.map((f) => f.id)).size).toBe(feeds.length);
    expect(new Set(feeds.map((f) => f.url)).size).toBe(feeds.length);
    for (const f of feeds) {
      expect(f.id, f.id).toMatch(/^radar:[a-z0-9][a-z0-9-]*$/);
      expect(f.id.startsWith("radar:google"), f.id).toBe(false); // that prefix is the Google countries'
      expect(f.url, f.id).toMatch(/^https:\/\//);
      expect(f.label, f.id).not.toBe("");
    }
  });

  it("is in the four groups of the ticket, none of them empty", () => {
    const groups = new Set(feeds.map((f) => f.group));
    expect([...groups].sort()).toEqual(["entertainment", "gaming", "sport", "upcoming"]);
    for (const g of groups) expect(feeds.filter((f) => f.group === g).length, g).toBeGreaterThanOrEqual(4);
  });

  it("has at most 2 feeds on one host, so one publisher cannot be most of an agreement", () => {
    const byHost = new Map<string, number>();
    for (const f of feeds) {
      const host = new URL(f.url).hostname.replace(/^(www|feeds)\./, "");
      byHost.set(host, (byHost.get(host) ?? 0) + 1);
    }
    for (const [host, n] of byHost) expect(n, host).toBeLessThanOrEqual(2);
  });
});

describe("config/rss-feeds.json is untouched", () => {
  const text = readFileSync(rssPath, "utf8");

  it("is byte-identical to its state before ticket 02", () => {
    expect(createHash("sha256").update(text).digest("hex")).toBe("c999ced0ef6aecda3b7110ec0fd57b82ab18047bdb2ce42bd36043e313fb7519");
  });

  it("holds no radar feed: no radar: id and no radar feed's address", () => {
    expect(text).not.toContain("radar:");
    for (const f of loadRadarFeeds(radarPath)) expect(text, f.id).not.toContain(f.url);
  });

  it("registers the same Narrative sources as before: 13 rss: feeds, none of the radar's", () => {
    const sources = loadRssSources(rssPath);
    expect(sources).toHaveLength(13);
    expect(sources.every((s) => s.id.startsWith("rss:"))).toBe(true);
  });
});

describe("loading a list", () => {
  const load = (content: unknown) => {
    const file = path.join(tempDir("radar-feeds-"), "feeds.json");
    writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
    return () => loadRadarFeeds(file);
  };
  const ok = { id: "radar:ign", label: "IGN", url: "https://ign.example/feed" };

  it("accepts a plain list", () => {
    expect(load([ok])()).toEqual([{ ...ok, group: "" }]);
  });

  it.each([
    ["not a list", { feeds: [] }, /JSON array/],
    ["a duplicate id", [ok, ok], /duplicate/],
    ["an id without the radar: prefix", [{ ...ok, id: "rss:ign" }], /radar:/],
    ["an id in the Google countries' prefix", [{ ...ok, id: "radar:google:US" }], /id like/],
    ["an upper-case id", [{ ...ok, id: "radar:IGN" }], /id like/],
    ["an http url", [{ ...ok, url: "http://ign.example/feed" }], /https/],
    ["a file url", [{ ...ok, url: "file:///etc/passwd" }], /https/],
    ["no label", [{ ...ok, label: "" }], /label/],
    ["more than 40 feeds", Array.from({ length: 41 }, (_, i) => ({ ...ok, id: `radar:f${i}` })), /over the cap/],
  ])("refuses %s", (_name, content, message) => {
    expect(load(content)).toThrow(message);
  });
});
