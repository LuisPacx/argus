// Reading a post out of an X search page (Moment scanner ticket 01). Two halves:
//  - `collectArticles`: runs INSIDE the page and returns plain facts per bare <article> (X no longer serves data-testid="tweet").
//    It only reads the DOM. It is serialised into the page by Playwright, so it must not use anything outside its own body.
//  - `parsePosts` and `readStatus`: pure functions over those facts, testable without a browser.
// The page is third-party text end to end: every string is cut here and again when stored.

import { parseCounts } from "../moments/counts.ts";
import { isStatusId, statusIdTime } from "../moments/status-id.ts";

const MAX_ARTICLES = 60;

// In-page collector. Facts per article, in page order. A quoted post is drawn as an article inside its quoter: the inner one is skipped,
// and its status link shows up among the outer article's links.
export function collectArticles() {
  const STATUS_HREF = /^\/[A-Za-z0-9_]{1,15}\/status\/\d{15,19}$/;
  const PROFILE_HREF = /^\/[A-Za-z0-9_]{1,15}$/;
  const COUNTS_LABEL = /(repl|repost|like|bookmark|view)/i;
  const out = [];
  for (const article of document.querySelectorAll("article")) {
    if (out.length >= 60) break;
    if (article.parentElement && article.parentElement.closest("article")) continue;
    const statusLinks = [];
    let handle = null;
    for (const a of article.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      if (STATUS_HREF.test(href)) {
        if (!statusLinks.includes(href)) statusLinks.push(href);
      } else if (handle === null && PROFILE_HREF.test(href)) {
        handle = href.slice(1);
      }
    }
    let countsLabel = null;
    for (const g of article.querySelectorAll('[role="group"][aria-label]')) {
      const label = g.getAttribute("aria-label") || "";
      if (COUNTS_LABEL.test(label)) {
        countsLabel = label.slice(0, 500);
        break;
      }
    }
    const body = article.querySelector("div[lang]");
    const innerText = (article.innerText || "").slice(0, 4000);
    out.push({
      statusLinks: statusLinks.slice(0, 6),
      handle,
      innerText,
      bodyText: ((body && body.innerText) || "").slice(0, 2000),
      countsLabel,
      hasVideo: article.querySelector("video") !== null,
      promoted: innerText.split("\n").some((line) => line.trim() === "Ad" || line.trim() === "Promoted"),
    });
  }
  return out;
}

const STATUS_LINK_RE = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{15,19})$/;

// Facts -> posts. Skips a promoted article and one with no status link of its author. Never throws on odd facts.
// A post: { statusId, handle, url, text, postedAt (ISO), hasVideo, quotedStatusId, counts }. Counts are null where X showed no figure.
export function parsePosts(facts) {
  const posts = [];
  const skipped = { promoted: 0, noStatusLink: 0 };
  for (const f of Array.isArray(facts) ? facts.slice(0, MAX_ARTICLES) : []) {
    if (f === null || typeof f !== "object") {
      skipped.noStatusLink++;
      continue;
    }
    if (f.promoted === true) {
      skipped.promoted++;
      continue;
    }
    const links = (Array.isArray(f.statusLinks) ? f.statusLinks : []).map((l) => (typeof l === "string" ? STATUS_LINK_RE.exec(l) : null)).filter((m) => m !== null);
    const author = typeof f.handle === "string" ? f.handle.toLowerCase() : null;
    const main = links.find((m) => author === null || m[1].toLowerCase() === author);
    if (!main || !isStatusId(main[2])) {
      skipped.noStatusLink++;
      continue;
    }
    const postedAt = statusIdTime(main[2]);
    if (postedAt === null) {
      skipped.noStatusLink++;
      continue;
    }
    const quoted = links.find((m) => m[2] !== main[2]);
    const body = typeof f.bodyText === "string" && f.bodyText.trim() !== "" ? f.bodyText : typeof f.innerText === "string" ? f.innerText : "";
    posts.push({
      statusId: main[2],
      handle: main[1],
      url: `https://x.com/${main[1]}/status/${main[2]}`,
      text: body.slice(0, 2000),
      postedAt: postedAt.toISOString(),
      hasVideo: f.hasVideo === true,
      quotedStatusId: quoted ? quoted[2] : null,
      counts: parseCounts(f.countsLabel),
    });
  }
  return { posts, skipped };
}

// What a loaded page was, given the facts the scanner gathered. `signals` are detect.mjs signals (a STOP signal wins, as in statusOf);
// `articleCount` is how many <article> elements the page had; `emptyState` is whether X said there were no results.
// A page with no article and no "no results" text is `selectors_found_nothing`, a different thing from `ok` with zero posts.
// So is a page that had articles but yielded no post and no promoted skip: the markup moved.
export function readStatus({ stopStatus, articleCount, parsed, emptyState }) {
  if (stopStatus !== "ok") return stopStatus;
  if (articleCount === 0) return emptyState ? "ok" : "selectors_found_nothing";
  if (parsed.posts.length === 0 && parsed.skipped.promoted === 0) return "selectors_found_nothing";
  return "ok";
}
