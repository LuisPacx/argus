import { describe, expect, it } from "vitest";
import { cleanSpelling, momentQueries, parseTopic, sinceStamp, TopicRefused, type MomentTopic } from "./query.ts";
// @ts-expect-error plain .mjs module, no types
import { isAllowedXUrl } from "../x-capture/urls.mjs";

const GTA: MomentTopic = { label: "GTA VI", startsAt: "2026-11-19T05:00:00Z", spellings: ["GTA VI", "GTA 6", "GTA6"] };

describe("momentQueries", () => {
  it("builds the group B query of the manual scan, once for Top and once for Latest", () => {
    const [top, live] = momentQueries(GTA);
    expect(top).toEqual({ id: "top", query: '("GTA VI" OR "GTA 6" OR GTA6) filter:videos min_faves:500 since:2026-11-19_05:00:00_UTC', url: expect.any(String) });
    expect(live!.id).toBe("live");
    expect(live!.query).toBe(top!.query);
    expect(new URL(top!.url).searchParams.get("q")).toBe(top!.query);
    expect(new URL(top!.url).searchParams.get("f")).toBe("top");
    expect(new URL(live!.url).searchParams.get("f")).toBe("live");
  });

  it("formats since: as 2026-11-19_05:00:00_UTC, in UTC", () => {
    expect(sinceStamp(new Date("2026-11-19T05:00:00Z"))).toBe("2026-11-19_05:00:00_UTC");
    expect(sinceStamp(new Date("2026-01-02T23:04:05Z"))).toBe("2026-01-02_23:04:05_UTC");
    expect(sinceStamp(new Date("2026-11-19T05:00:00+03:00"))).toBe("2026-11-19_02:00:00_UTC");
  });

  it("produces addresses the scanner's own allowlist accepts", () => {
    for (const t of momentQueries(GTA)) expect(isAllowedXUrl(t.url)).toBe(true);
  });

  it("a hostile topic gets no operator but the literals: no from:, no minus, no parentheses beyond the one pair, every word cut", () => {
    const hostile: MomentTopic = {
      label: "x",
      startsAt: "2026-11-19T05:00:00Z",
      spellings: [
        'GTA VI from:someone -filter:links min_faves:0 "x" OR (y)',
        "y".repeat(10_000),
        "A\u0000B‮C\nD\tE",
        "from:evil -x (a OR b) until:2030-01-01 lang:fr",
        "OR", // only an operator word: dropped
        "-:()\"'", // only operators and marks: dropped
      ],
    };
    const [q] = momentQueries(hostile);
    const query = q!.query;
    expect(query).not.toMatch(/from:|until:|lang:/);
    expect(query.slice(0, query.indexOf(") filter:videos"))).not.toContain("-"); // the date in since: has hyphens; the topic's words have none
    expect(query.match(/\(/g)).toHaveLength(1);
    expect(query.match(/\)/g)).toHaveLength(1);
    // The whole query is one list with no colon and no parenthesis of its own, then the three literals and nothing else.
    expect(query).toMatch(/^\([^():]+\) filter:videos min_faves:500 since:2026-11-19_05:00:00_UTC$/);
    for (const part of query.slice(1, query.indexOf(")")).split(" OR ")) expect(part.replaceAll('"', "").length).toBeLessThanOrEqual(40);
    expect(query).not.toContain("\u0000");
    expect(query).not.toContain("‮");
    expect(query.length).toBeLessThan(400);
    // every spelling that survives is a plain phrase: no stray quote inside the quotes
    const list = query.slice(1, query.indexOf(") filter:videos"));
    for (const part of list.split(" OR ")) expect(part.replaceAll('"', "")).toMatch(/^[\p{L}\p{Nd}#$ ]+$/u);
  });

  it("operator words inside a spelling are dropped, so OR, AND and NOT only appear as the list's own OR", () => {
    expect(cleanSpelling("cats OR dogs")).toBe("cats dogs");
    expect(cleanSpelling("cats and dogs not birds")).toBe("cats dogs birds");
    const [q] = momentQueries({ ...GTA, spellings: ["a OR b -c", "or"] });
    expect(q!.query).toBe('("a b c") filter:videos min_faves:500 since:2026-11-19_05:00:00_UTC');
  });

  it("keeps a # and a $ and letters of any script", () => {
    expect(cleanSpelling("#GTA6")).toBe("#GTA6");
    expect(cleanSpelling("$ROCKSTAR")).toBe("$ROCKSTAR");
    expect(cleanSpelling("ГТА 6")).toBe("ГТА 6");
  });

  it("a spelling that cleans to empty is dropped; none left is a refusal", () => {
    expect(cleanSpelling("---")).toBe("");
    expect(cleanSpelling("#")).toBe("");
    expect(() => momentQueries({ ...GTA, spellings: ["---", "()", "OR"] })).toThrow(TopicRefused);
    expect(() => momentQueries({ ...GTA, spellings: [] })).toThrow(/no spelling/);
    expect(() => momentQueries({ label: "", startsAt: "2026-11-19T05:00:00Z", spellings: [] })).toThrow(TopicRefused);
    expect(() => momentQueries({ ...GTA, spellings: undefined as unknown as string[] })).toThrow(TopicRefused);
  });

  it("refuses a start time that is not an ISO time ending in Z", () => {
    for (const startsAt of ["", "2026-11-19", "2026-11-19T05:00:00", "yesterday", "2026-13-45T99:00:00Z", "2026-11-19T05:00:00+02:00"]) {
      expect(() => momentQueries({ ...GTA, startsAt }), startsAt).toThrow(TopicRefused);
    }
  });

  it("reads at most the first 6 spellings, then drops repeats", () => {
    const [q] = momentQueries({ ...GTA, spellings: ["a", "a", "A", "b", "c", "d", "e", "f", "g", "h"] });
    expect(q!.query.slice(1, q!.query.indexOf(")")).split(" OR ")).toEqual(["a", "A", "b", "c", "d"]);
  });
});

describe("parseTopic (ARGUS_MOMENT_TOPIC)", () => {
  const json = (o: unknown) => JSON.stringify(o);
  it("reads the GTA VI topic of the ticket", () => {
    expect(parseTopic(json(GTA))).toEqual(GTA);
  });

  it("unset or empty is no topic", () => {
    expect(parseTopic(undefined)).toBeNull();
    expect(parseTopic("  ")).toBeNull();
  });

  it("refuses what is not a valid topic", () => {
    for (const raw of ["not json", "[]", "7", "null", json({ ...GTA, extra: 1 }), json({ ...GTA, label: "" }), json({ ...GTA, startsAt: "soon" }), json({ ...GTA, spellings: [] }), json({ ...GTA, spellings: "GTA" }), json({ ...GTA, spellings: ["-"] }), json({ ...GTA, spellings: ["a", "b", "c", "d", "e", "f", "g"] })]) {
      expect(() => parseTopic(raw), raw).toThrow(TopicRefused);
    }
  });

  it("cleans what it keeps: the label to one line of 60 characters and the spellings to plain words", () => {
    const t = parseTopic(json({ label: `Big\nTopic ${"x".repeat(200)}`, startsAt: "2026-11-19T05:00:00Z", spellings: ["from:me GTA", "GTA"] }))!;
    expect(t.label).not.toContain("\n");
    expect(t.label.length).toBeLessThanOrEqual(60);
    expect(t.spellings).toEqual(["from me GTA", "GTA"]);
  });
});
