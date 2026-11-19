import { describe, expect, it } from "vitest";
import { NO_COUNTS, parseCounts } from "./counts.ts";

describe("parseCounts", () => {
  it("reads the real aria-label of the notes", () => {
    expect(parseCounts("44 replies, 39 reposts, 185 likes, 4 bookmarks, 18856 views")).toEqual({ replies: 44, reposts: 39, likes: 185, bookmarks: 4, views: 18856 });
  });

  it("reads the labels of the saved search pages", () => {
    expect(parseCounts("7 replies, 47 reposts, 549 likes, 86 bookmarks, 17827 views")).toEqual({ replies: 7, reposts: 47, likes: 549, bookmarks: 86, views: 17827 });
  });

  it("gives null for a figure that is not shown, never 0", () => {
    expect(parseCounts("44 replies, 39 reposts, 185 likes, 4 bookmarks")).toEqual({ replies: 44, reposts: 39, likes: 185, bookmarks: 4, views: null });
    expect(parseCounts("0 replies, 0 reposts, 3 likes").bookmarks).toBeNull();
    expect(parseCounts("0 replies, 0 reposts, 3 likes").replies).toBe(0); // a real zero stays zero
  });

  it("reads the K, M and B forms and thousands commas", () => {
    expect(parseCounts("1.2K likes")).toMatchObject({ likes: 1200 });
    expect(parseCounts("3M views")).toMatchObject({ views: 3_000_000 });
    expect(parseCounts("2.5B views").views).toBe(2_500_000_000);
    expect(parseCounts("18,856 views, 1,204 likes")).toMatchObject({ views: 18856, likes: 1204 });
  });

  it("reads singular words", () => {
    expect(parseCounts("1 reply, 1 repost, 1 like, 1 bookmark, 1 view")).toEqual({ replies: 1, reposts: 1, likes: 1, bookmarks: 1, views: 1 });
  });

  it.each(["", "Seek slider", "Verified account", "hello world", "likes", "views 5", ", , ,", "NaN views", "Infinity likes"])("gives all nulls for %j", (text) => {
    expect(parseCounts(text)).toEqual(NO_COUNTS);
  });

  it("gives all nulls for text that is not text, or a label over 500 characters", () => {
    expect(parseCounts(undefined)).toEqual(NO_COUNTS);
    expect(parseCounts(5)).toEqual(NO_COUNTS);
    expect(parseCounts(`${"1 like, ".repeat(100)}`)).toEqual(NO_COUNTS);
  });

  it("keeps the first figure of a word and ignores a repeat", () => {
    expect(parseCounts("5 likes, 9 likes").likes).toBe(5);
  });

  it("stays fast on a long run of digits and commas", () => {
    const t = Date.now();
    parseCounts(`${"9,".repeat(240)} views`);
    expect(Date.now() - t).toBeLessThan(500);
  });
});
