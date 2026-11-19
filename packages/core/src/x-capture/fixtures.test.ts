import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no types
import { changedByScrub, HASH_FILE, readHashes } from "../../scripts/x-scrub-fixture.mjs";
// @ts-expect-error plain .mjs module, no types
import { handleHash, scrubPage } from "./scrub.mjs";

// The saved X pages in `moments/fixtures` are real pages of a logged-in account. Before they were committed the scrub removed the account's nav,
// account switcher, profile link and every script; this test proves nothing of that is left, and that the scrub script finds nothing more to change.
const FIXTURES = path.join(import.meta.dirname, "..", "moments", "fixtures");
const pages = readdirSync(FIXTURES).filter((f) => f.endsWith(".html"));

describe("the committed fixtures are safe", () => {
  it("there are a Top page and a Latest page, and nothing else is in the folder but the handle hashes", () => {
    expect(pages.sort()).toEqual(["search-latest-videos.html", "search-top-videos.html"]);
    expect(readdirSync(FIXTURES).filter((f) => !f.endsWith(".html")).sort()).toEqual([HASH_FILE]);
  });

  it("the scrub script finds nothing left to change in any of them", () => {
    expect(changedByScrub(FIXTURES)).toEqual([]);
    for (const f of pages) {
      const html = readFileSync(path.join(FIXTURES, f), "utf8");
      expect(scrubPage(html).html === html, f).toBe(true);
    }
  });

  it.each(pages)("%s has no nav, no account switcher, no script and no cookie name", (f) => {
    const html = readFileSync(path.join(FIXTURES, f), "utf8");
    expect(html).not.toMatch(/<script|<nav|<style|<link|<iframe|<form|<input/i);
    expect(html).not.toMatch(/Account menu|AccountSwitcher|AppTabBar|aria-label="Primary"|aria-label="Profile"|SideNav_/);
    expect(html).not.toMatch(/\b(auth_token|ct0|twid|csp-nonce|sentry-trace)\b/);
    expect(html).not.toMatch(/\s(?:src|srcset|style|class|id)="/);
    expect(html).toContain("<article");
  });

  it.each(pages)("%s holds no handle of the Argus account (compared by hash: this test never knows the handle)", (f) => {
    const html = readFileSync(path.join(FIXTURES, f), "utf8");
    const hashes = new Set<string>(readHashes(FIXTURES));
    expect(hashes.size).toBeGreaterThan(0); // the scrub recorded the handle it removed
    const tokens = new Set(html.match(/[A-Za-z0-9_]{1,15}/g) ?? []);
    expect(tokens.size).toBeGreaterThan(100);
    for (const t of tokens) expect(hashes.has(handleHash(t)), `a token of ${f} is a recorded handle`).toBe(false);
  });

  it("the handle hashes file is a list of 12-character hex prefixes", () => {
    const hashes = readHashes(FIXTURES) as string[];
    expect(hashes.length).toBeGreaterThan(0);
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("the scrub", () => {
  const RAW = `<!doctype html><html><head><meta name="csp-nonce" content="abc"><title>(1) search</title><script>window.__STATE__={"auth_token":"secret","ct0":"x","twid":"u=1"}</script><style>.a{}</style></head>
<body><nav aria-label="Primary"><a aria-label="Home" href="/home">Home</a><a aria-label="Profile" href="/Some_Account">Profile</a></nav>
<button aria-label="Account menu"><div>Display Name</div><div>@Some_Account</div></button>
<main><header><h1>search</h1></header><article class="c" id="r1" style="x" data-testid="gone"><a href="/other/status/2123280111864811617">1m</a>
<div lang="en" dir="auto">hello some_account and @SOME_ACCOUNT</div><img src="https://pbs.twimg.com/x.jpg" srcset="y 1x" alt="@other"><svg viewBox="0 0 1 1" role="img" aria-label="icon"><path d="M0 0"/></svg>
<div role="group" aria-label="1 replies, 2 reposts, 3 likes, 4 bookmarks, 5 views"></div><!-- note --><script>x()</script></article></main><aside>Who to follow</aside></body></html>`;

  it("keeps the posts column and drops the rest, and says which handle it removed (by hash only)", () => {
    const r = scrubPage(RAW);
    expect(r.html).toContain("<article");
    expect(r.html).toContain('aria-label="1 replies, 2 reposts, 3 likes, 4 bookmarks, 5 views"');
    expect(r.html).toContain('href="/other/status/2123280111864811617"');
    expect(r.html).not.toMatch(/<script|<nav|<style|<aside|<img[^>]*src|srcset|class=|id=|data-testid|<!--|auth_token|ct0|twid|csp-nonce|Account menu|Display Name|Who to follow|<path/);
    expect(r.html.toLowerCase()).not.toContain("some_account");
    expect(r.html).toContain("hello argus_account and @argus_account");
    expect(r.handleHashes).toEqual([handleHash("Some_Account")]);
    expect(handleHash("SOME_ACCOUNT")).toBe(handleHash("some_account"));
    expect(r.replaced).toBe(2);
    expect(JSON.stringify(r.handleHashes)).not.toContain("Some_Account");
  });

  it("is idempotent: a scrubbed page scrubs to itself", () => {
    const once = scrubPage(RAW);
    expect(scrubPage(once.html).html).toBe(once.html);
  });

  it("refuses a page with no main column instead of guessing", () => {
    expect(() => scrubPage("<html><body><div>nothing</div></body></html>")).toThrow(/no <main>/);
  });

  it("the scrubbed fixture folder has no raw page: nothing in it is bigger than the scrubbed pages", () => {
    for (const f of pages) expect(statSync(path.join(FIXTURES, f)).size).toBeLessThan(200_000);
  });
});
