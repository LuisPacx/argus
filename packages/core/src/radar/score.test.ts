import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { at, T0 } from "../testing/radar.ts";
import { PhraseCounter } from "./phrases.ts";
import { isShown, scoreTrend, type ScoreReading } from "./score.ts";

/** The agreement score (spec 5.2, ticket 02). Every figure is the ticket's. */
const feed = (id: string, minutes = 0): ScoreReading => ({ source: `radar:${id}`, trafficMin: 0, at: at(minutes).toISOString() });
const google = (geo: string, trafficMin: number, minutes = 0): ScoreReading => ({ source: `radar:google:${geo}`, trafficMin, at: at(minutes).toISOString() });
const NOW = at(10);

describe("the score", () => {
  it("3 feeds is 60, and is shown", () => {
    const s = scoreTrend([feed("a"), feed("b"), feed("c")], NOW);
    expect(s.total).toBe(60);
    expect(s.parts).toEqual([{ label: "3 independent sources within 3 hours", points: 60 }]);
    expect(isShown(s.total)).toBe(true);
  });

  it("Google alone at 2,000 traffic is 20 and is not shown", () => {
    const s = scoreTrend([google("US", 2_000)], NOW);
    expect(s.total).toBe(20);
    expect(isShown(s.total)).toBe(false);
  });

  it("Google in 3 countries at 25,000 plus one feed is 20 + 20 + 20 + 10 = 70", () => {
    const s = scoreTrend([google("US", 25_000), google("GB", 12_000), google("CA", 5_000), feed("a")], NOW);
    expect(s.total).toBe(70);
    expect(s.parts.map((p) => p.points)).toEqual([40, 20, 10]);
    expect(s.geos).toEqual(["CA", "GB", "US"]);
    expect(s.feeds).toEqual(["radar:a"]);
  });

  it("Google in any number of countries is one source", () => {
    expect(scoreTrend([google("US", 0), google("GB", 0)], NOW).total).toBe(20);
    expect(scoreTrend([google("US", 0), google("GB", 0), google("CA", 0)], NOW).total).toBe(20 + 10); // three countries add 10, not 20 each
  });

  it("5,000 adds 10 and 20,000 adds 20 instead of it, not on top", () => {
    expect(scoreTrend([google("US", 4_999)], NOW).total).toBe(20);
    expect(scoreTrend([google("US", 5_000)], NOW).total).toBe(30);
    expect(scoreTrend([google("US", 19_999)], NOW).total).toBe(30);
    expect(scoreTrend([google("US", 20_000)], NOW).total).toBe(40);
    expect(scoreTrend([google("US", 2_000_000)], NOW).total).toBe(40);
  });

  it("a fifth source adds nothing, and the breakdown says 5 carry it and 4 count", () => {
    const four = scoreTrend([feed("a"), feed("b"), feed("c"), feed("d")], NOW);
    const five = scoreTrend([feed("a"), feed("b"), feed("c"), feed("d"), feed("e")], NOW);
    expect(four.total).toBe(80);
    expect(five.total).toBe(80);
    expect(five.parts[0]!.label).toContain("5 carry it, 4 count");
  });

  it("39 is hidden and 40 is shown", () => {
    expect(isShown(39)).toBe(false);
    expect(isShown(40)).toBe(true);
  });

  it("only readings inside the 3 hours count; a stale one adds nothing", () => {
    const readings = [feed("a", 0), feed("b", 0), feed("c", -200)];
    expect(scoreTrend(readings, at(10)).total).toBe(40); // c is 3 h 30 min old
    expect(scoreTrend(readings, at(10)).since).toBe(at(0).toISOString());
    expect(scoreTrend([feed("a", 0)], at(181)).total).toBe(0);
    expect(scoreTrend([], T0).total).toBe(0);
    expect(scoreTrend([{ source: "radar:a", trafficMin: 0, at: "not a date" }], T0).total).toBe(0);
  });

  it("the slots of tickets 04 and 12 give nothing yet", () => {
    expect(scoreTrend([feed("a")], NOW).parts).toHaveLength(1);
  });
});

describe("the replayed Anthropic IPO fixture (13 feeds)", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/anthropic-ipo.json", import.meta.url), "utf8")) as { items: Array<{ feed: string; minutes: number; title: string }> };

  it("13 feeds in 2.5 hours make the phrase a candidate and a shown Trend at the top of the scale", () => {
    expect(fixture.items).toHaveLength(13);
    const counter = new PhraseCounter();
    for (const it of fixture.items) counter.add(it.feed, it.title, "", at(it.minutes).getTime());
    const now = at(155);
    expect(counter.agreed(now.getTime())).toEqual(expect.arrayContaining(["anthropic", "ipo", "anthropicipo"]));
    const entries = counter.entries("anthropic", now.getTime());
    expect(entries).toHaveLength(13); // the single word is in every headline
    expect(counter.entries("anthropicipo", now.getTime()).length).toBeGreaterThanOrEqual(10); // the two words side by side, in the headlines that put them so
    const s = scoreTrend(entries.map((e) => ({ source: e.feed, trafficMin: 0, at: new Date(e.at).toISOString() })), now);
    expect(s.total).toBe(80);
    expect(isShown(s.total)).toBe(true);
    expect(s.parts[0]!.label).toContain("13 carry it, 4 count");
  });

  it("the same 13 spread over a day are never a candidate", () => {
    const counter = new PhraseCounter();
    fixture.items.forEach((it, i) => counter.add(it.feed, it.title, "", at(i * 120).getTime()));
    for (let m = 0; m <= 13 * 120; m += 30) {
      counter.expire(at(m).getTime());
      expect(counter.agreed(at(m).getTime()), `at ${m}`).not.toContain("anthropic");
    }
  });
});
