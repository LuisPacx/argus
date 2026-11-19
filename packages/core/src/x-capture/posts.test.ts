// Parser on real pages (Moment scanner ticket 01). Two saved real X search pages (a Top and a Latest page for a `filter:videos` query, read 2026-11-19
// read-only through the Argus profile, then scrubbed by scripts/x-scrub-fixture.mjs) are loaded into a real headless browser with a throwaway
// profile (never the Argus one), the in-page collector runs over the bare <article> elements, and the pure parser turns the facts into posts.
// Slow tier (a real browser); it self-skips when the matching headless shell is not installed.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no types
import { chooseBrowser, expectedRevision } from "../../../../scripts/page-check.mjs";
// @ts-expect-error plain .mjs module, no types
import { classify, statusOf } from "./detect.mjs";
// @ts-expect-error plain .mjs module, no types
import { collectArticles, parsePosts, readStatus } from "./posts.mjs";
// @ts-expect-error plain .mjs module, no types
import { gatherFacts } from "./session.mjs";

const found = chooseBrowser(path.join(os.homedir(), ".cache", "ms-playwright"), expectedRevision()) as { path: string } | null;
const FIXTURES = path.join(import.meta.dirname, "..", "moments", "fixtures");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, `${name}.html`), "utf8");

interface Post {
  statusId: string;
  handle: string;
  url: string;
  text: string;
  postedAt: string;
  hasVideo: boolean;
  quotedStatusId: string | null;
  counts: { replies: number | null; reposts: number | null; likes: number | null; bookmarks: number | null; views: number | null };
}

let browser: Browser;
let page: Page;
beforeAll(async () => {
  if (!found) return;
  browser = await chromium.launch({ executablePath: found.path, headless: true });
  page = await (await browser.newContext()).newPage();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const readPage = async (html: string) => {
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  const facts = (await page.evaluate(collectArticles)) as unknown[];
  const gathered = (await page.evaluate(gatherFacts)) as { articleCount: number; emptyState: boolean; text: string; loggedIn: boolean };
  return { facts, gathered, parsed: parsePosts(facts) as { posts: Post[]; skipped: { promoted: number; noStatusLink: number } } };
};

describe.skipIf(!found)("the collector and parser on the two saved search pages", () => {
  it("reads every post of the Top page: handle, status ID, time from the ID, counts, and a video", async () => {
    const { parsed, gathered } = await readPage(fixture("search-top-videos"));
    expect(gathered.articleCount).toBe(10);
    expect(parsed.posts).toHaveLength(10);
    expect(parsed.skipped).toEqual({ promoted: 0, noStatusLink: 0 });
    const aiverse = parsed.posts.find((p) => p.handle === "AIVersePlay")!;
    expect(aiverse).toMatchObject({
      statusId: "2123371841851125955",
      url: "https://x.com/AIVersePlay/status/2123371841851125955",
      hasVideo: true,
      quotedStatusId: null,
      counts: { replies: 71, reposts: 824, likes: 17203, bookmarks: 8976, views: 630782 },
    });
    expect(aiverse.postedAt.slice(0, 16)).toBe("2026-11-19T11:04"); // the notes: 11:04 UTC
    expect(aiverse.text).toContain("side mission");
    const gta = parsed.posts.find((p) => p.handle === "GTAmemesSOL")!;
    expect(gta.counts).toEqual({ replies: 222, reposts: 1280, likes: 37404, bookmarks: 3543, views: 2121748 });
    // a post that quotes another carries the quoted post's ID, never its own
    const konsey = parsed.posts.find((p) => p.handle === "konseytr")!;
    expect(konsey.quotedStatusId).toBe("2123394601893433614");
    expect(konsey.statusId).toBe("2123401760676962761");
    for (const p of parsed.posts) {
      expect(p.statusId).toMatch(/^\d{15,19}$/);
      expect(p.handle).toMatch(/^[A-Za-z0-9_]{1,15}$/);
      expect(Date.parse(p.postedAt)).toBeGreaterThan(Date.parse("2026-11-19T05:00:00Z"));
      expect(p.counts.views).not.toBeNull();
      expect(p.counts.likes).not.toBeNull();
    }
  });

  it("reads the Latest page, and skips the quoted post that X draws as an article inside its quoter", async () => {
    const { parsed, gathered } = await readPage(fixture("search-latest-videos"));
    expect(gathered.articleCount).toBe(12); // 11 posts and one nested article
    expect(parsed.posts).toHaveLength(11);
    const gameRoll = parsed.posts.find((p) => p.handle === "GameRoll_")!;
    expect(gameRoll.quotedStatusId).toBe("2117405080383320313");
    expect(parsed.posts.some((p) => p.handle === "videotech")).toBe(false);
    expect(parsed.posts.map((p) => p.statusId).sort()).toEqual([...new Set(parsed.posts.map((p) => p.statusId))].sort());
    // newest first on the Latest tab
    const times = parsed.posts.map((p) => Date.parse(p.postedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("the page is `ok`, and a logged-in page that says nothing alarming raises no STOP signal", async () => {
    const { gathered, parsed } = await readPage(fixture("search-top-videos"));
    // The saved page was scrubbed down to its main column, so it has no account menu: classify it as the scanner does, with the page's own facts plus a logged-in nav.
    const signals = classify({ url: "https://x.com/search?q=x&f=top", text: gathered.text, loggedIn: true, hasLoginButton: false, hasChallengeWidget: false });
    expect(signals).toEqual([]);
    expect(readStatus({ stopStatus: statusOf(signals), articleCount: gathered.articleCount, parsed, emptyState: gathered.emptyState })).toBe("ok");
  });

  it("a post that says 'sign in to X' or 'are you a robot' is not a login wall or a challenge: the posts' text is left out of the page text", async () => {
    const html = fixture("search-top-videos").replace("<main>", '<main><article><div lang="en" dir="auto">Sign in to X. Are you a robot? Your account has been locked. Rate limit exceeded</div><a href="/x/status/2123371841851125900">1m</a></article>');
    const { gathered, parsed } = await readPage(html);
    expect(gathered.text).not.toMatch(/sign in to x|are you a robot|locked|rate limit/i);
    expect(classify({ url: "https://x.com/search?q=x&f=top", text: gathered.text, loggedIn: true })).toEqual([]);
    expect(parsed.posts.some((p) => p.text.includes("Sign in to X"))).toBe(true);
  });

  it("gatherFacts: a minimal logged-in page is logged in and raises no signal; a logged-out page with a nav is a login wall", async () => {
    const article = '<article><a href="/a/status/2123371841851125900">1m</a></article>';
    const loggedIn = await readPage(`<!doctype html><html><body><nav aria-label="Primary"><a href="/home">Home</a></nav><button aria-label="Account menu">me</button><main>${article}</main></body></html>`);
    const facts = (g: unknown) => g as { loggedIn: boolean; hasLoginButton: boolean; text: string };
    expect(facts(loggedIn.gathered)).toMatchObject({ loggedIn: true, hasLoginButton: false });
    expect(classify({ url: "https://x.com/search?q=x&f=top", ...facts(loggedIn.gathered) })).toEqual([]);
    // logged out, yet the page still has a Primary nav (and even an account-menu-like button): the login link decides
    for (const wall of ['<a href="/login">Log in</a>', '<a href="/i/flow/login">Sign in</a>', '<a data-testid="signupButton" href="/i/flow/signup">Sign up</a>']) {
      const out = await readPage(`<!doctype html><html><body><nav aria-label="Primary"><a href="/home">Home</a></nav><button aria-label="Account menu">x</button>${wall}<main>${article}</main></body></html>`);
      expect(facts(out.gathered), wall).toMatchObject({ loggedIn: false, hasLoginButton: true });
      expect(statusOf(classify({ url: "https://x.com/search?q=x&f=top", ...facts(out.gathered) })), wall).toBe("login_wall");
    }
    // a logged-out page with no nav at all is a wall too
    const bare = await readPage(`<!doctype html><html><body><main>${article}</main></body></html>`);
    expect(statusOf(classify({ url: "https://x.com/search?q=x&f=top", ...facts(bare.gathered) }))).toBe("login_wall");
  });

  it("a page with no article and no 'no results' text is `selectors_found_nothing`; with the empty-state text it is `ok` with zero posts", async () => {
    const none = await readPage("<!doctype html><html><body><main><div>something X changed</div></main></body></html>");
    expect(none.gathered.articleCount).toBe(0);
    expect(readStatus({ stopStatus: "ok", articleCount: none.gathered.articleCount, parsed: none.parsed, emptyState: none.gathered.emptyState })).toBe("selectors_found_nothing");
    const empty = await readPage("<!doctype html><html><body><main><div>No results for &quot;gta&quot;</div></main></body></html>");
    expect(empty.gathered.emptyState).toBe(true);
    expect(readStatus({ stopStatus: "ok", articleCount: 0, parsed: empty.parsed, emptyState: empty.gathered.emptyState })).toBe("ok");
  });

  it("articles that yield no post (the markup moved) are `selectors_found_nothing` too", async () => {
    const moved = await readPage("<!doctype html><html><body><main><article><div>no links here</div></article><article><span>nor here</span></article></main></body></html>");
    expect(moved.gathered.articleCount).toBe(2);
    expect(moved.parsed.posts).toEqual([]);
    expect(moved.parsed.skipped.noStatusLink).toBe(2);
    expect(readStatus({ stopStatus: "ok", articleCount: 2, parsed: moved.parsed, emptyState: false })).toBe("selectors_found_nothing");
  });

  it("a promoted article (an 'Ad' line) is skipped, and a page of only promoted posts is not 'found nothing'", async () => {
    const html = `<!doctype html><html><body><main><article><a href="/promo_acct">p</a><div>Promoted</div><a href="/promo_acct/status/2123371841851125900">1m</a></article></main></body></html>`;
    const r = await readPage(html);
    expect(r.parsed.posts).toEqual([]);
    expect(r.parsed.skipped.promoted).toBe(1);
    expect(readStatus({ stopStatus: "ok", articleCount: 1, parsed: r.parsed, emptyState: false })).toBe("ok");
  });
});
