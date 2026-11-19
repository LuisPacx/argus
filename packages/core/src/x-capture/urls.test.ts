import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module, no types
import { isAllowedXUrl } from "./urls.mjs";

const SEARCH = "https://x.com/search?q=" + encodeURIComponent('("GTA VI" OR GTA6) filter:videos min_faves:500 since:2026-11-19_05:00:00_UTC');

describe("isAllowedXUrl", () => {
  it.each([
    [`${SEARCH}&f=top`],
    [`${SEARCH}&f=live`],
    ["https://x.com/search?f=live&q=gta"],
    ["https://x.com/someone/status/2123280111864811617"],
    ["https://x.com/Some_One1/status/2123280111864811617"],
  ])("allows %s", (url) => {
    expect(isAllowedXUrl(url)).toBe(true);
  });

  it.each([
    ["a profile page", "https://x.com/someone"],
    ["the home timeline", "https://x.com/home"],
    ["compose", "https://x.com/compose/post"],
    ["notifications", "https://x.com/notifications"],
    ["a search with no tab", `${SEARCH}`],
    ["a search on another tab", `${SEARCH}&f=user`],
    ["a search with src", `${SEARCH}&f=top&src=typed_query`],
    ["a search with an empty query", "https://x.com/search?q=&f=top"],
    ["a search with a duplicate tab", `${SEARCH}&f=top&f=live`],
    ["a search with a query of 601 characters", `https://x.com/search?q=${"a".repeat(601)}&f=top`],
    ["a post with a path after the ID", "https://x.com/someone/status/2123280111864811617/analytics"],
    ["a post with a short ID", "https://x.com/someone/status/12345"],
    ["a post with a query", "https://x.com/someone/status/2123280111864811617?s=20"],
    ["a post with a handle of 16 characters", "https://x.com/abcdefghijklmnop/status/2123280111864811617"],
    ["http", "http://x.com/search?q=a&f=top"],
    ["another host", "https://twitter.com/search?q=a&f=top"],
    ["a look-alike host", "https://x.com.evil.example/search?q=a&f=top"],
    ["a subdomain", "https://mobile.x.com/search?q=a&f=top"],
    ["userinfo", "https://user:pw@x.com/search?q=a&f=top"],
    ["a port", "https://x.com:8443/search?q=a&f=top"],
    ["a fragment", "https://x.com/search?q=a&f=top#x"],
    ["a trailing-dot host", "https://x.com./search?q=a&f=top"],
    ["javascript:", "javascript:alert(1)"],
    ["a data: URL", "data:text/html,<script>alert(1)</script>"],
    ["a relative path", "/search?q=a&f=top"],
    ["an empty string", ""],
    ["a very long address", `https://x.com/search?q=a&f=top&${"p=1&".repeat(1000)}`],
  ])("refuses %s", (_name, url) => {
    expect(isAllowedXUrl(url)).toBe(false);
  });

  it("refuses what is not text", () => {
    for (const v of [null, undefined, 5, {}, ["https://x.com/search?q=a&f=top"]]) expect(isAllowedXUrl(v)).toBe(false);
  });
});
