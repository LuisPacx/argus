// The browser half of the Moment scanner: opens the dedicated Chrome directory the way the capture spike does (system Google Chrome,
// headed on Chrome's headless Ozone platform, no display server) and loads one allowed address at a time. It calls goto, mouse-wheel
// scrolls and page reads, nothing else: no input, no form, no new address.

import { chromium } from "playwright-core";
import { collectArticles } from "./posts.mjs";

// In-page: the facts `classify` needs. The text is the page WITHOUT its posts: a post that says "sign in to X" or "are you a robot" is
// third-party text and must not read as a login wall or a challenge. Runs inside the page, so it uses nothing outside its own body.
export function gatherFacts() {
  const has = (sel) => document.querySelector(sel) !== null;
  let text = "";
  if (document.body) {
    const clone = document.body.cloneNode(true);
    for (const el of clone.querySelectorAll("article, script, style, noscript")) el.remove();
    text = (clone.textContent || "").replace(/\s+/g, " ").slice(0, 20000);
  }
  return {
    text,
    // X's test ids are gone from the logged-in page (seen 2026-11-19); the account menu and the primary nav are what is there now.
    loggedIn: has('[aria-label="Account menu"], nav[aria-label="Primary"], [data-testid="AppTabBar_Home_Link"], [data-testid="SideNav_AccountSwitcher_Button"]'),
    hasLoginButton: has('[data-testid="loginButton"], [data-testid="signupButton"], a[href="/login"], a[href="/i/flow/login"]'),
    hasChallengeWidget: has('iframe[src*="arkoselabs"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [data-testid="ocfEnterTextTextInput"]'),
    articleCount: document.querySelectorAll("article").length,
    emptyState: /no results for/i.test(text),
  };
}

// Loads `url` in `page`, scrolls at most `scrolls` times with the wheel, and returns the facts of the page and the articles seen.
// X draws a long list in pieces, so the articles are read after the load and after each scroll and merged by their first status link.
export async function loadPage(page, url, { scrolls, sleep, jitter }) {
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForSelector('article, a[href="/login"], nav[aria-label="Primary"]', { timeout: 20_000 }).catch(() => {});
  await sleep(jitter(1500, 3500));
  const seen = new Map();
  const take = async () => {
    for (const a of await page.evaluate(collectArticles)) seen.set(a.statusLinks[0] ?? `none-${seen.size}`, a);
  };
  await take();
  for (let i = 0; i < Math.min(scrolls, 3); i++) {
    await page.mouse.wheel(0, jitter(500, 900));
    await sleep(jitter(1200, 2500));
    await take();
  }
  const facts = await page.evaluate(gatherFacts);
  return { ...facts, url: page.url(), httpStatus: resp ? resp.status() : null, articles: [...seen.values()] };
}

// Opens the persistent context on `dir` and returns { load(url, opts), close() }. The caller has checked the lock and the directory.
export async function openSession({ dir, chromeBin, sleep, jitter }) {
  const env = { ...process.env };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  const context = await chromium.launchPersistentContext(dir, {
    executablePath: chromeBin,
    headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--window-size=1366,900", "--ozone-platform=headless"],
    env,
    ignoreDefaultArgs: ["--enable-automation"],
    viewport: { width: 1366, height: 900 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    load: (url, opts) => loadPage(page, url, { sleep, jitter, ...opts }),
    close: () => context.close(),
  };
}
