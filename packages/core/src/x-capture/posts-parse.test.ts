import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module, no types
import { parsePosts, readStatus } from "./posts.mjs";

// The pure half of the reader: facts (what the in-page collector returns) to posts. Synthetic facts only, no real page.
const ID = "2123280111864811617";
const facts = (over: Record<string, unknown> = {}) => ({
  statusLinks: [`/alice/status/${ID}`],
  handle: "alice",
  innerText: "Alice\n@alice\n1h\nhello",
  bodyText: "hello",
  countsLabel: "1 reply, 2 reposts, 3 likes, 4 bookmarks, 5 views",
  hasVideo: true,
  promoted: false,
  ...over,
});

describe("parsePosts", () => {
  it("makes a post of an article: handle, status ID, link, time from the ID, counts", () => {
    const { posts, skipped } = parsePosts([facts()]);
    expect(skipped).toEqual({ promoted: 0, noStatusLink: 0 });
    expect(posts).toEqual([
      {
        statusId: ID,
        handle: "alice",
        url: `https://x.com/alice/status/${ID}`,
        text: "hello",
        postedAt: "2026-11-19T05:00:01.962Z",
        hasVideo: true,
        quotedStatusId: null,
        counts: { replies: 1, reposts: 2, likes: 3, bookmarks: 4, views: 5 },
      },
    ]);
  });

  it("skips a promoted article and an article with no status link of its own author", () => {
    const { posts, skipped } = parsePosts([facts({ promoted: true }), facts({ statusLinks: [] }), facts({ statusLinks: ["/bob/status/2123280111864811618"] }), facts()]);
    expect(posts).toHaveLength(1);
    expect(skipped).toEqual({ promoted: 1, noStatusLink: 2 });
  });

  it("takes the author's own link as the post and the other one as the quoted post", () => {
    const { posts } = parsePosts([facts({ statusLinks: ["/bob/status/2123280111864811000", `/alice/status/${ID}`] })]);
    expect(posts[0]).toMatchObject({ statusId: ID, quotedStatusId: "2123280111864811000" });
  });

  it("a figure the label does not carry is null, not 0; a missing label gives all nulls", () => {
    expect(parsePosts([facts({ countsLabel: "7 replies, 9 likes" })]).posts[0]!.counts).toEqual({ replies: 7, reposts: null, likes: 9, bookmarks: null, views: null });
    expect(parsePosts([facts({ countsLabel: null })]).posts[0]!.counts).toEqual({ replies: null, reposts: null, likes: null, bookmarks: null, views: null });
  });

  it("falls back to the whole article's text when there is no body text, and cuts long text", () => {
    expect(parsePosts([facts({ bodyText: "", innerText: "whole" })]).posts[0]!.text).toBe("whole");
    expect(parsePosts([facts({ bodyText: "x".repeat(10_000) })]).posts[0]!.text).toHaveLength(2000);
  });

  it("does not throw on odd facts: null, text, a bad link, a too-short ID, a handle that is not a handle", () => {
    const odd = [null, "x", 7, {}, facts({ statusLinks: ["javascript:alert(1)", "/alice/status/12345", `/alice/status/${ID}/photo/1`] }), facts({ handle: "not a handle!" }), facts({ statusLinks: "nope" })];
    const { posts, skipped } = parsePosts(odd);
    expect(posts).toEqual([]);
    expect(skipped.noStatusLink).toBe(7);
    expect(parsePosts(undefined)).toEqual({ posts: [], skipped: { promoted: 0, noStatusLink: 0 } });
    expect(parsePosts("nope")).toEqual({ posts: [], skipped: { promoted: 0, noStatusLink: 0 } });
  });

  it("reads at most 60 articles", () => {
    expect(parsePosts(Array.from({ length: 200 }, () => facts())).posts).toHaveLength(60);
  });
});

describe("readStatus", () => {
  const ok = { posts: [{}], skipped: { promoted: 0, noStatusLink: 0 } };
  const empty = { posts: [], skipped: { promoted: 0, noStatusLink: 0 } };
  it("passes a STOP or other status through", () => {
    expect(readStatus({ stopStatus: "login_wall", articleCount: 5, parsed: ok, emptyState: false })).toBe("login_wall");
    expect(readStatus({ stopStatus: "not_found", articleCount: 0, parsed: empty, emptyState: false })).toBe("not_found");
  });
  it("is ok with posts, ok with zero posts only when X said no results, otherwise selectors_found_nothing", () => {
    expect(readStatus({ stopStatus: "ok", articleCount: 3, parsed: ok, emptyState: false })).toBe("ok");
    expect(readStatus({ stopStatus: "ok", articleCount: 0, parsed: empty, emptyState: true })).toBe("ok");
    expect(readStatus({ stopStatus: "ok", articleCount: 0, parsed: empty, emptyState: false })).toBe("selectors_found_nothing");
    expect(readStatus({ stopStatus: "ok", articleCount: 4, parsed: empty, emptyState: false })).toBe("selectors_found_nothing");
  });
});
