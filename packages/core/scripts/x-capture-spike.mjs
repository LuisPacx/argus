#!/usr/bin/env node
// Phase 3 ticket 05: X capture spike. A throwaway experiment, not the daily job.
//
// Opens the dedicated Argus Chrome directory as a Playwright persistent context
// (system Google Chrome, no bundled browser), loads a few public X pages
// read-only, saves what it finds, and stops at the first login wall, challenge,
// lock, own-account suspension or rate limit. It never posts, likes, follows,
// replies or messages: it only calls page.goto, mouse wheel scrolls and reads.
//
// Usage:
//   node x-capture-spike.mjs --mode headless|headed-virtual \
//     [--profiles a,b] [--tickers BONK,WIF] [--dir <chrome dir>] [--out <dir>]
//   node x-capture-spike.mjs --check-lock --dir <dir>     (lock test only, no browser)
//
// Modes: "headless" = Chrome --headless (new headless). "headed-virtual" = the
// full headed browser on Chrome's headless Ozone platform (no display server,
// because Xvfb is not installed here), so X sees a headed Chrome.
//
// Artefacts (raw HTML, screenshots, result JSON) go under ~/.cache/argus-scratch/x-spike/,
// never into git. Cookie values are never read or printed.

import { chromium } from "playwright-core";
import { captureAll, classify, statusOf } from "../src/x-capture/detect.mjs";
import { mkdirSync, readlinkSync, existsSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : dflt;
};
const DIR = flag("dir", process.env.ARGUS_CHROME_DIR ?? join(homedir(), ".local/share/argus/chrome"));
const MODE = flag("mode", "headless");
const PROFILES = String(flag("profiles", "pumpdotfun,bonk_inu,dogecoin,argus_spike_nx_7q2k9z")).split(",");
const TICKERS = String(flag("tickers", "BONK,WIF")).split(",");
const OUT_ROOT = flag("out", join(homedir(), ".cache/argus-scratch/x-spike"));
const CHROME = process.env.ARGUS_CHROME_BIN ?? "/usr/bin/google-chrome";
const MAX_LOADS = 16; // hard cap on page loads for one run

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (lo, hi) => lo + Math.random() * (hi - lo);

// One process per directory. Chrome's SingletonLock is a symlink "host-pid".
export function lockHolder(dir) {
  const lock = join(dir, "SingletonLock");
  let target;
  try {
    target = readlinkSync(lock);
  } catch {
    return null;
  }
  const pid = Number(target.split("-").pop());
  if (!Number.isInteger(pid)) return { pid: null, alive: false, stale: true };
  try {
    process.kill(pid, 0);
    return { pid, alive: true, stale: false };
  } catch (e) {
    return { pid, alive: e.code === "EPERM", stale: e.code !== "EPERM" };
  }
}

function assertDirSafe(dir) {
  const st = statSync(dir);
  const mode = st.mode & 0o777;
  if (mode !== 0o700) throw new Error(`refusing: ${dir} has mode ${mode.toString(8)}, expected 700`);
  if (dir.startsWith(process.cwd()) && existsSync(join(process.cwd(), ".git"))) {
    throw new Error("refusing: the Chrome directory must be outside the repository");
  }
  return mode.toString(8);
}

const holder = lockHolder(DIR);
if (holder?.alive) {
  console.error(`REFUSED: a Chrome process (pid ${holder.pid}) already holds ${DIR}. One process per directory.`);
  process.exit(3);
}
if (flag("check-lock", false)) {
  console.log(holder ? `stale lock (pid ${holder.pid} not running)` : "no lock");
  process.exit(0);
}
const dirMode = assertDirSafe(DIR);

// Detection facts are gathered here; classification and the stop loop live in ../src/x-capture/detect.mjs.

async function detect(page) {
  const url = page.url();
  const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  const has = async (sel) => (await page.locator(sel).count().catch(() => 0)) > 0;
  const loggedIn = await has('[data-testid="AppTabBar_Home_Link"], [data-testid="SideNav_AccountSwitcher_Button"]');
  const hasChallengeWidget = await has('iframe[src*="arkoselabs"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [data-testid="ocfEnterTextTextInput"]');
  const hasLoginButton = await has('[data-testid="loginButton"], [data-testid="signupButton"], a[href="/login"]');
  const signals = classify({ url, text, loggedIn, hasLoginButton, hasChallengeWidget });
  return { url, loggedIn, signals, text };
}

const parseCount = (s) => {
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/([\d.]+)\s*([KMB]?)/i);
  if (!m) return null;
  return Math.round(Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase()] ?? 1));
};

async function extractProfile(page) {
  return page.evaluate(() => {
    const t = (sel) => document.querySelector(sel)?.innerText?.trim() ?? null;
    const link = (suffix) => [...document.querySelectorAll("a")].find((a) => a.getAttribute("href")?.endsWith(suffix))?.innerText?.trim() ?? null;
    return {
      displayName: t('[data-testid="UserName"]')?.split("\n")[0] ?? null,
      bio: t('[data-testid="UserDescription"]'),
      joined: t('[data-testid="UserJoinDate"]'),
      followers: link("/verified_followers") ?? link("/followers"),
      following: link("/following"),
    };
  });
}

async function extractPosts(page, limit) {
  return page.evaluate((limit) => {
    const out = [];
    for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
      if (out.length >= limit) break;
      const group = a.querySelector('[role="group"]')?.getAttribute("aria-label") ?? "";
      out.push({
        text: a.querySelector('[data-testid="tweetText"]')?.innerText ?? null,
        time: a.querySelector("time")?.getAttribute("datetime") ?? null,
        counts: group,
      });
    }
    return out;
  }, limit);
}

const runId = new Date().toISOString().replace(/[:.]/g, "-") + `-${MODE}`;
const outDir = join(OUT_ROOT, runId);
mkdirSync(outDir, { recursive: true, mode: 0o700 });

const headless = MODE === "headless";
const args = ["--no-first-run", "--no-default-browser-check", "--window-size=1366,900"];
if (MODE === "headed-virtual") args.push("--ozone-platform=headless");
const env = { ...process.env };
if (MODE === "headed-virtual") {
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
}

console.log(`mode=${MODE} dir=${DIR} (mode ${dirMode}) out=${outDir}`);
const context = await chromium.launchPersistentContext(DIR, {
  executablePath: CHROME,
  headless,
  args,
  env,
  ignoreDefaultArgs: ["--enable-automation"],
  viewport: { width: 1366, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());

const targets = [
  ...PROFILES.map((h) => ({ kind: "profile", key: h, url: `https://x.com/${h}` })),
  ...TICKERS.map((s) => ({ kind: "search", key: `$${s}`, url: `https://x.com/search?q=${encodeURIComponent("$" + s)}&src=typed_query&f=live` })),
];

let captured = 0;
let loads = 0;
let stopped = null;
let results = [];
try {
  ({ results, loads, stopped } = await captureAll(
    targets,
    async (tg) => {
    const started = Date.now();
    const rec = { kind: tg.kind, key: tg.key, mode: MODE, at: new Date().toISOString() };
    {
      const resp = await page.goto(tg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
      rec.httpStatus = resp?.status() ?? null;
      await page
        .waitForSelector('[data-testid="UserName"], article[data-testid="tweet"], [data-testid="emptyState"], [data-testid="loginButton"]', { timeout: 20000 })
        .catch(() => {});
      await sleep(jitter(1500, 3500));
      for (let i = 0; i < 2; i++) {
        await page.mouse.wheel(0, jitter(500, 900));
        await sleep(jitter(1200, 2500));
      }
      const d = await detect(page);
      rec.finalUrl = d.url.replace(/\?.*/, "");
      rec.loggedIn = d.loggedIn;
      rec.signals = d.signals;
      rec.elapsedMs = Date.now() - started;
      const base = join(outDir, `${captured++}-${tg.kind}-${tg.key.replace(/\W/g, "_")}`);
      writeFileSync(`${base}.html`, await page.content(), { mode: 0o600 });
      await page.screenshot({ path: `${base}.png` }).catch(() => {});
      rec.status = statusOf(d.signals);
      if (rec.status === "ok") {
        if (tg.kind === "profile") {
          const p = await extractProfile(page);
          rec.profile = { ...p, followersN: parseCount(p.followers), followingN: parseCount(p.following) };
        }
        rec.posts = await extractPosts(page, 10);
        const needle = tg.key.replace(/^\$/, "").toLowerCase();
        rec.mentions = rec.posts.filter((p) => p.text?.toLowerCase().includes(needle)).length;
      }
    }
    console.log(`${rec.kind} ${rec.key}: ${rec.status} signals=${(rec.signals ?? []).join(",") || "-"} posts=${rec.posts?.length ?? 0} ${rec.elapsedMs ?? ""}ms`);
    return rec;
    },
    { maxLoads: MAX_LOADS, pause: () => sleep(jitter(9000, 22000)) },
  ));
  if (stopped) console.log(`STOP on ${stopped}: no retry. Report to the Operator.`);
} finally {
  await context.close();
  writeFileSync(join(outDir, "results.json"), JSON.stringify({ mode: MODE, loads, stopped, results }, null, 2), { mode: 0o600 });
}
console.log(`loads=${loads} stopped=${stopped ?? "no"} results=${join(outDir, "results.json")}`);
process.exit(stopped ? 2 : 0);
