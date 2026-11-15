// pnpm page:check <path> [--port N] [--out DIR] [--keys "Tab,Enter,Escape"] [--watch SELECTOR]...
// Opens one page of a RUNNING local War Room in a headless Chromium with a throwaway profile, at 1240 and 390 px
// (a real context viewport, not a resized window), and writes a full-page screenshot per width, a JSON summary
// and prints it. Read-only: navigate, screenshot, read sizes; the optional --keys script only sends focus/open/close keys.
// Ticket: .scratch/warroom-redesign/issues/11-headless-page-check.md
// Never uses the user's Chrome, the Argus Chrome profile, a `channel` or the 1194 browser build.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OVERFLOW_FAILS } from './warroom-pages.mjs';

export const DEFAULT_PORT = 3100; // scripts/dev-server.mjs PORT (not exported there)
export const WIDTHS = [
  { width: 1240, height: 900, isMobile: false },
  { width: 390, height: 844, isMobile: true },
];
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

// Local URL only: no host argument, no absolute URL, no `//` path.
export function buildUrl(port, pagePath = '/') {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port ${port}`);
  if (typeof pagePath !== 'string' || !pagePath.startsWith('/') || pagePath.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(pagePath) || pagePath.includes('\\')) {
    throw new Error(`path must be a local path like /pipeline, got "${pagePath}"`);
  }
  // `localhost`, not 127.0.0.1: the live War Room (nuxt dev) listens on ::1 only.
  const url = new URL(pagePath, 'http://localhost');
  url.port = String(port);
  return url.href;
}

export function isLocalUrl(url) {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Returns a problem string when `dir` must not receive output, else null.
export function outDirProblem(dir, home = os.homedir()) {
  const resolved = path.resolve(dir);
  const under = (base) => resolved === base || resolved.startsWith(base + path.sep);
  if (under('/tmp')) return '--out must not be under /tmp (tmpfs with a quota)';
  const forbidden = [
    path.join(home, '.local/share/argus'),
    path.join(home, '.config/google-chrome'),
    path.join(home, '.config/chromium'),
    path.join(home, '.config/chrome'),
    path.join(home, 'snap/chromium'),
    path.join(home, '.var/app/com.google.Chrome'),
  ];
  const hit = forbidden.find(under);
  return hit ? `--out must not be inside ${hit} (a browser or Argus profile)` : null;
}

export function slugFor(pagePath) {
  const clean = pagePath.split(/[?#]/)[0].replace(/^\/+|\/+$/g, '');
  const slug = clean.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'home' : slug.slice(0, 80);
}

export function fileNames(slug) {
  return {
    screenshots: Object.fromEntries(WIDTHS.map((w) => [w.width, `${slug}-${w.width}.png`])),
    keyScreenshots: Object.fromEntries(WIDTHS.map((w) => [w.width, `${slug}-${w.width}-keys.png`])),
    json: `${slug}.json`,
  };
}

// Only the Playwright-expected revision of the headless shell, never another one. Returns { path, revision } or null.
export function chooseBrowser(cacheDir, revision) {
  const exe = path.join(cacheDir, `chromium_headless_shell-${revision}`, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
  return fs.existsSync(exe) ? { path: exe, revision: String(revision) } : null;
}

export function expectedRevision() {
  const require = createRequire(import.meta.url);
  const dir = path.dirname(require.resolve('playwright-core'));
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'browsers.json'), 'utf8'));
  const entry = json.browsers.find((b) => b.name === 'chromium-headless-shell');
  if (!entry) throw new Error('playwright-core browsers.json has no chromium-headless-shell');
  return String(entry.revision);
}

export const INSTALL_COMMAND = 'pnpm exec playwright-core install chromium-headless-shell';

// Keyboard steps are focus/open/close keys only. `focus=<css selector>` moves focus (no click). No typing, no clicks.
const ALLOWED_KEYS = new Map(
  ['Tab', 'Shift+Tab', 'Enter', 'Escape', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].map((k) => [k.toLowerCase(), k]),
);
export function parseKeys(spec) {
  if (spec === undefined || spec === '') return [];
  return spec.split(',').map((raw) => {
    const s = raw.trim();
    if (s.toLowerCase().startsWith('focus=')) {
      const selector = s.slice('focus='.length).trim();
      if (selector === '') throw new Error('focus= needs a CSS selector');
      return { kind: 'focus', selector, label: `focus ${selector}` };
    }
    const key = ALLOWED_KEYS.get(s.toLowerCase());
    if (!key) throw new Error(`key "${s}" is not allowed; use ${[...ALLOWED_KEYS.values()].join(', ')} or focus=<selector>`);
    return { kind: 'key', key, label: key };
  });
}

// Pass/fail from a recorded result. `failOnOverflow` is the page's opt-in; overflow is otherwise only a warning.
export function decide(result, { failOnOverflow = false } = {}) {
  const reasons = [];
  const warnings = [];
  for (const w of result.widths) {
    const tag = `${w.width}px`;
    if (typeof w.status !== 'number' || w.status < 200 || w.status > 299) reasons.push(`${tag}: document status ${w.status}`);
    if (w.overflow) (failOnOverflow ? reasons : warnings).push(`${tag}: horizontal overflow (scrollWidth ${w.scrollWidth} > viewport ${w.width})`);
  }
  for (const e of result.consoleErrors) reasons.push(`console error: ${e}`);
  for (const e of result.pageErrors) reasons.push(`page error: ${e}`);
  for (const r of result.failedRequests) reasons.push(`failed request: ${r}`);
  for (const w of result.notes ?? []) warnings.push(w);
  return { exit: reasons.length > 0 ? 1 : 0, reasons, warnings };
}

export function parseArgs(argv) {
  const opts = { path: '/', port: DEFAULT_PORT, out: null, browser: null, keys: '', watch: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--port') opts.port = Number(value());
    else if (a === '--out') opts.out = value();
    else if (a === '--browser') opts.browser = value();
    else if (a === '--keys') opts.keys = value();
    else if (a === '--watch') opts.watch.push(value());
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length > 1) throw new Error(`one path only, got ${positional.length}`);
  if (positional.length === 1) opts.path = positional[0];
  return opts;
}

export function defaultOut(env = process.env) {
  return env.CLAUDE_SCRATCHPAD || path.join(env.TMPDIR || '/var/tmp', 'page-check');
}

async function readFocus(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return { tag: 'body', id: '', role: '', testId: '', text: '' };
    const text = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return { tag: el.tagName.toLowerCase(), id: el.id || '', role: el.getAttribute('role') || '', testId: el.getAttribute('data-test') || '', text };
  });
}

async function runKeys(page, steps, watch) {
  const log = [];
  for (const step of steps) {
    if (step.kind === 'focus') await page.locator(step.selector).first().focus({ timeout: 5000 });
    else await page.keyboard.press(step.key);
    await page.waitForTimeout(500) // lets a close/open transition finish;
    const visible = {};
    for (const sel of watch) visible[sel] = await page.locator(sel).first().isVisible();
    log.push({ step: step.label, focus: await readFocus(page), visible });
  }
  return log;
}

export async function main(argv) {
  let opts;
  let steps;
  let url;
  try {
    opts = parseArgs(argv);
    url = buildUrl(opts.port, opts.path);
    steps = parseKeys(opts.keys);
    const outProblem = outDirProblem(opts.out ?? defaultOut());
    if (outProblem) throw new Error(outProblem);
  } catch (err) {
    console.error(`page:check: ${err.message}`);
    console.error('usage: pnpm page:check <path> [--port N] [--out DIR] [--keys "Tab,Enter,Escape"] [--watch SELECTOR]...');
    return 2;
  }
  const outDir = path.resolve(opts.out ?? defaultOut());

  const cacheDir = path.join(os.homedir(), '.cache', 'ms-playwright');
  let browserPath;
  let revision = 'override';
  if (opts.browser) {
    if (!fs.existsSync(opts.browser)) {
      console.error(`page:check: --browser ${opts.browser} does not exist`);
      return 2;
    }
    browserPath = opts.browser;
  } else {
    const chosen = chooseBrowser(cacheDir, expectedRevision());
    if (!chosen) {
      console.error(`page:check: Chromium headless shell revision ${expectedRevision()} is not installed under ${cacheDir}. Install it once with:\n  ${INSTALL_COMMAND}`);
      return 2;
    }
    browserPath = chosen.path;
    revision = chosen.revision;
  }

  fs.mkdirSync(outDir, { recursive: true });
  process.env.TMPDIR ||= '/var/tmp'; // Playwright's throwaway profile goes under TMPDIR, never /tmp
  const { chromium } = await import('playwright-core');
  const names = fileNames(slugFor(opts.path));
  const result = { url, status: null, widths: [], consoleErrors: [], pageErrors: [], failedRequests: [], browser: null, keys: {}, exit: 0 };
  const notes = [];
  const blocked = new Set();
  let browser;
  let exiting = false;
  const onSignal = (code) => async () => {
    if (exiting) return;
    exiting = true;
    try {
      await browser?.close();
    } finally {
      process.exit(code);
    }
  };
  process.on('SIGINT', onSignal(130));
  process.on('SIGTERM', onSignal(143));

  try {
    browser = await chromium.launch({ executablePath: browserPath, headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    result.browser = `chromium headless shell ${browser.version()} (revision ${revision}) at ${browserPath}`;
    console.log(`browser: ${result.browser}`);
    for (const vp of WIDTHS) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, isMobile: vp.isMobile, hasTouch: vp.isMobile });
      try {
        await context.route('**/*', (route) => {
          const reqUrl = route.request().url();
          if (isLocalUrl(reqUrl) || reqUrl.startsWith('data:') || reqUrl.startsWith('blob:')) return route.continue();
          blocked.add(reqUrl);
          result.failedRequests.push(`blocked non-local request ${reqUrl}`);
          return route.abort();
        });
        const page = await context.newPage();
        page.on('console', (m) => {
          if (m.type() === 'error') result.consoleErrors.push(`[${vp.width}] ${m.text().slice(0, 300)}`);
        });
        page.on('pageerror', (e) => result.pageErrors.push(`[${vp.width}] ${String(e.message).slice(0, 300)}`));
        page.on('response', (r) => {
          if (r.status() >= 400 && isLocalUrl(r.url())) result.failedRequests.push(`[${vp.width}] ${r.status()} ${r.url()}`);
        });
        page.on('requestfailed', (r) => {
          if (!blocked.has(r.url())) result.failedRequests.push(`[${vp.width}] ${r.failure()?.errorText ?? 'failed'} ${r.url()}`);
        });
        const response = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
        try {
          await page.waitForLoadState('networkidle', { timeout: 10000 });
        } catch {
          notes.push(`${vp.width}px: network did not go idle within 10 s`);
        }
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        const status = response ? response.status() : null;
        await page.screenshot({ path: path.join(outDir, names.screenshots[vp.width]), fullPage: true });
        result.widths.push({ width: vp.width, status, scrollWidth, overflow: scrollWidth > vp.width, screenshot: names.screenshots[vp.width] });
        if (steps.length > 0) {
          result.keys[vp.width] = await runKeys(page, steps, opts.watch);
          await page.screenshot({ path: path.join(outDir, names.keyScreenshots[vp.width]), fullPage: true });
        }
      } finally {
        await context.close();
      }
    }
    result.status = result.widths[0]?.status ?? null;
  } catch (err) {
    result.pageErrors.push(`page:check could not finish: ${String(err.message).split('\n')[0]}`);
  } finally {
    exiting = true;
    await browser?.close().catch(() => {});
  }

  result.notes = notes;
  const verdict = decide(result, { failOnOverflow: OVERFLOW_FAILS.includes(opts.path) });
  result.warnings = verdict.warnings;
  result.reasons = verdict.reasons;
  result.exit = verdict.exit;
  delete result.notes;
  fs.writeFileSync(path.join(outDir, names.json), JSON.stringify(result, null, 2) + '\n');

  console.log(`url: ${url}  status: ${result.widths.map((w) => `${w.width}px=${w.status}`).join(' ')}`);
  console.log(`console errors: ${result.consoleErrors.length}  page errors: ${result.pageErrors.length}  failed requests: ${result.failedRequests.length}`);
  for (const r of verdict.reasons) console.log(`FAIL ${r}`);
  for (const w of verdict.warnings) console.log(`WARN ${w}`);
  for (const [width, log] of Object.entries(result.keys)) {
    for (const s of log) {
      const f = s.focus;
      const vis = Object.entries(s.visible).map(([k, v]) => `${k}=${v ? 'visible' : 'hidden'}`).join(' ');
      console.log(`keys ${width}px  ${s.step}: focus ${f.tag}${f.id ? `#${f.id}` : ''}${f.role ? `[role=${f.role}]` : ''}${f.testId ? `[data-test=${f.testId}]` : ''} "${f.text}"${vis ? `  ${vis}` : ''}`);
    }
  }
  for (const w of result.widths) console.log(`screenshot ${w.width}px: ${path.join(outDir, w.screenshot)}`);
  if (steps.length > 0) for (const w of WIDTHS) console.log(`screenshot ${w.width}px after keys: ${path.join(outDir, names.keyScreenshots[w.width])}`);
  console.log(`json: ${path.join(outDir, names.json)}`);
  console.log(`exit ${result.exit}`);
  return result.exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fileURLToPath(pathToFileURL(process.argv[1]))).href) {
  process.exitCode = await main(process.argv.slice(2));
}
