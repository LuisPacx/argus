// pnpm page:check <path> [--port N] [--out DIR] [--keys "Tab,Enter,Escape"] [--watch SELECTOR]...
// Opens one page of a RUNNING local War Room in a headless Chromium with a throwaway profile, at 1240 and 390 px
// (a real context viewport, not a resized window), and writes a full-page screenshot per width, a JSON summary
// and prints it. Read-only: navigate, screenshot, read sizes; the optional --keys script only sends keys from a fixed list.
// Enforced: every request that is not GET or HEAD, or is not to localhost on the chosen port, is aborted and counted as a
// failed request (exit 1). Enter and Space still activate the focused element, so the caller picks focus/open/close targets;
// a state-changing POST/PUT/DELETE it would trigger is blocked, not sent. Service workers are blocked; WebSockets are not intercepted.
// `--seed (--all | <path>...)` instead starts a private War Room on a throwaway DB filled with sample rows (scripts/page-seed.mjs,
// scripts/page-check-server.mjs), checks every path the same way, then stops it and deletes the DB. The JSON says `"seeded": true`.
// Output: unless --out is given, each run writes to its own fresh folder $TMPDIR/page-check/run-XXXXXX (the newest 10 are kept) and prints
// `output folder: <dir>` last, also when the run fails. A seeded run without --port takes a free port from the OS; a plain run checks the
// running War Room on 3100 unless --port says otherwise.
// Ticket: .scratch/warroom-redesign/issues/11-headless-page-check.md, 14-page-check-seed-option.md, .scratch/human-researcher/issues/13-page-check-per-run-output-and-port.md
// Never uses the user's Chrome, the Argus Chrome profile, a `channel` or the 1194 browser build.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OVERFLOW_FAILS } from './warroom-pages.mjs';
import { portBusy, seedPortProblem, startSeededServer, stopAllSeeded } from './page-check-server.mjs';
import { STANDARD_PATHS, expandTokens, pathProblem } from './page-seed.mjs';

export const DEFAULT_PORT = 3100; // scripts/dev-server.mjs PORT (not exported there)
export const WIDTHS = [
  { width: 1240, height: 900, isMobile: false },
  { width: 390, height: 844, isMobile: true },
];
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

// Local URL only: no host argument, no absolute URL, no `//` path.
export function buildUrl(port, pagePath = '/') {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port ${port}`);
  if (typeof pagePath !== 'string' || !pagePath.startsWith('/') || pagePath.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(pagePath) || pagePath.includes('\\') || /[\u0000-\u001f\u007f]/.test(pagePath)) {
    throw new Error(`path must be a local path like /pipeline, got "${pagePath}"`);
  }
  // `localhost`, not 127.0.0.1: the live War Room (nuxt dev) listens on ::1 only.
  const url = new URL(pagePath, 'http://localhost');
  url.port = String(port);
  if (url.hostname !== 'localhost' || url.port !== String(port) || url.protocol !== 'http:') throw new Error(`path "${pagePath}" does not stay on localhost:${port}`);
  return url.href;
}

// A local URL; with `port`, only that port (the War Room being checked).
export function isLocalUrl(url, port) {
  try {
    const u = new URL(url);
    return LOCAL_HOSTS.has(u.hostname) && (port === undefined || u.port === String(port));
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

// `withQuery`: keep the query and fragment in the name (seeded runs check `/` and `/?kind=meme` side by side).
export function slugFor(pagePath, withQuery = false) {
  const clean = (withQuery ? pagePath : pagePath.split(/[?#]/)[0]).replace(/^\/+|\/+$/g, '');
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
  const opts = { path: '/', paths: [], port: DEFAULT_PORT, out: null, browser: null, keys: '', watch: [], seed: false, all: false };
  const positional = [];
  let portGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--port') {
      opts.port = Number(value());
      portGiven = true;
    } else if (a === '--seed') opts.seed = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--out') opts.out = value();
    else if (a === '--browser') opts.browser = value();
    else if (a === '--keys') opts.keys = value();
    else if (a === '--watch') opts.watch.push(value());
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else positional.push(a);
  }
  if (opts.seed) {
    if (opts.all && positional.length > 0) throw new Error('--all checks the standard set; give --all or paths, not both');
    if (!opts.all && positional.length === 0) throw new Error('--seed needs one or more paths, or --all');
    if (!portGiven) opts.port = null; // main() asks the OS for a free port
    else {
      const portProblem = seedPortProblem(opts.port);
      if (portProblem) throw new Error(portProblem);
    }
    opts.paths = opts.all ? [...STANDARD_PATHS] : positional;
    opts.path = opts.paths[0];
    return opts;
  }
  if (opts.all) throw new Error('--all needs --seed');
  if (positional.length > 1) throw new Error(`one path only, got ${positional.length}`);
  if (positional.length === 1) opts.path = positional[0];
  opts.paths = [opts.path];
  return opts;
}

export const KEEP_RUNS = 10; // run folders kept under the base; older ones are removed at the start of a run
export const RUN_PREFIX = 'run-';

export function outBase(env = process.env) {
  return path.join(env.TMPDIR || '/var/tmp', 'page-check');
}

// Removes all but the newest `keep` run folders under `base`, never `current`. Returns the removed names.
export function pruneRuns(base, current, keep = KEEP_RUNS) {
  let names;
  try {
    names = fs.readdirSync(base).filter((n) => n.startsWith(RUN_PREFIX) && path.join(base, n) !== current);
  } catch {
    return [];
  }
  const dated = names.flatMap((n) => {
    try {
      const st = fs.statSync(path.join(base, n));
      return st.isDirectory() ? [{ n, t: st.mtimeMs }] : [];
    } catch {
      return [];
    }
  });
  dated.sort((a, b) => b.t - a.t);
  const doomed = dated.slice(Math.max(0, keep - 1)).map((d) => d.n); // the current run takes one of the `keep` places
  for (const n of doomed) fs.rmSync(path.join(base, n), { recursive: true, force: true });
  return doomed;
}

// A fresh folder for this run (fs.mkdtemp, so two runs never share one); older runs are pruned.
export function makeRunDir(base = outBase()) {
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, RUN_PREFIX));
  pruneRuns(base, dir);
  return dir;
}

// A port the OS says is free right now (listen on 0), never the live War Room's.
export async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    if (port !== DEFAULT_PORT) return port;
  }
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

const USAGE = 'usage: pnpm page:check <path> [--port N] [--out DIR] [--keys "Tab,Enter,Escape"] [--watch SELECTOR]...\n       pnpm page:check --seed (--all | <path>...) [--port N] [--out DIR]   (private War Room on sample data; paths may use {tech} {metaMeme} {newsMeme} {hostile} {angle} {topicMeme})';

export async function main(argv) {
  let opts;
  let steps;
  try {
    opts = parseArgs(argv);
    // Seeded paths may hold {tokens}; check the shape with a stand-in id now, fill the real ids once the fixture exists.
    for (const p of opts.paths) {
      if (opts.seed) {
        const problem = pathProblem(p);
        if (problem) throw new Error(problem);
        buildUrl(opts.port ?? DEFAULT_PORT, expandTokens(p));
      } else buildUrl(opts.port, p);
    }
    steps = parseKeys(opts.keys);
    const outProblem = outDirProblem(opts.out ?? outBase());
    if (outProblem) throw new Error(outProblem);
  } catch (err) {
    console.error(`page:check: ${err.message}`);
    console.error(USAGE);
    return 2;
  }

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

  process.env.TMPDIR ||= '/var/tmp'; // Playwright's throwaway profile goes under TMPDIR, never /tmp
  // --out is used as given (never pruned); otherwise a fresh run-XXXXXX folder under $TMPDIR/page-check, older runs pruned to KEEP_RUNS.
  let outDir;
  if (opts.out) {
    outDir = path.resolve(opts.out);
    fs.mkdirSync(outDir, { recursive: true });
  } else outDir = makeRunDir();
  if (opts.seed && opts.port === null) opts.port = await freePort();
  const { chromium } = await import('playwright-core');
  const state = { browser: null, signalled: false };
  const onSignal = (code) => async () => {
    if (state.signalled) return;
    state.signalled = true;
    console.log(`output folder: ${outDir}`);
    try {
      await state.browser?.close();
    } finally {
      try {
        await stopAllSeeded(); // the private server, its process group and its DB dir
      } finally {
        process.exit(code);
      }
    }
  };
  process.on('SIGINT', onSignal(130));
  process.on('SIGTERM', onSignal(143));

  let server = null;
  let exit = 0;
  try {
    let pagePaths = opts.paths;
    let seed = null;
    if (opts.seed) {
      try {
        server = await startSeededServer({ port: opts.port, now: new Date() });
      } catch (err) {
        console.error(`page:check: ${err.message}`);
        return err.refusal ? 2 : 1;
      }
      seed = { dir: server.dir, port: server.port, pgid: server.pgid, counts: server.counts };
      console.log(`seed: dir ${seed.dir}  port ${seed.port}  pgid ${seed.pgid}  rows written ${Object.entries(seed.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
      pagePaths = opts.paths.map((p) => expandTokens(p, server.ids));
    }
    for (const pagePath of pagePaths) {
      exit = Math.max(exit, await checkOne({ opts, pagePath, seed, browserPath, revision, outDir, steps, chromium, state }));
    }
  } finally {
    if (server) {
      await server.stop();
      const busy = await portBusy(server.port);
      const left = fs.existsSync(server.dir);
      console.log(`seed cleanup: port ${server.port} ${busy ? 'STILL IN USE' : 'free'}, dir ${left ? 'STILL THERE' : 'removed'}`);
      if (busy || left) exit = 1;
    }
    console.log(`output folder: ${outDir}`); // also on a failing run
  }
  return exit;
}

// One page at both widths in one browser. Returns the exit code (0 or 1) and writes the screenshots and the JSON.
async function checkOne({ opts, pagePath, seed, browserPath, revision, outDir, steps, chromium, state }) {
  const url = buildUrl(opts.port, pagePath);
  const names = fileNames(slugFor(pagePath, opts.seed));
  const result = { url, ...(seed ? { seeded: true, seed } : {}), status: null, widths: [], consoleErrors: [], pageErrors: [], failedRequests: [], browser: null, keys: {}, exit: 0 };
  const notes = [];
  const blocked = new Set();
  let browser;

  try {
    browser = await chromium.launch({ executablePath: browserPath, headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    state.browser = browser;
    result.browser = `chromium headless shell ${browser.version()} (revision ${revision}) at ${browserPath}`;
    console.log(`browser: ${result.browser}`);
    for (const vp of WIDTHS) {
      // serviceWorkers 'block': a service worker's requests would bypass the route handler. WebSockets are not intercepted by route().
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, isMobile: vp.isMobile, hasTouch: vp.isMobile, serviceWorkers: 'block' });
      try {
        await context.route('**/*', (route) => {
          const req = route.request();
          const reqUrl = req.url();
          if (reqUrl.startsWith('data:') || reqUrl.startsWith('blob:')) return route.continue();
          if (!isLocalUrl(reqUrl, opts.port)) {
            blocked.add(reqUrl);
            result.failedRequests.push(`blocked request outside localhost:${opts.port}: ${reqUrl}`);
            return route.abort();
          }
          if (req.method() !== 'GET' && req.method() !== 'HEAD') {
            blocked.add(reqUrl);
            result.failedRequests.push(`blocked ${req.method()} (read-only check): ${reqUrl}`);
            return route.abort();
          }
          return route.continue();
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
    await browser?.close().catch(() => {});
    state.browser = null;
  }

  result.notes = notes;
  const verdict = decide(result, { failOnOverflow: OVERFLOW_FAILS.includes(pagePath) || (Boolean(seed) && pagePath.split(/[?#]/)[0] !== '/pipeline') }); // the seed holds a hostile card: overflow there is a bug, except /pipeline, which scrolls sideways on purpose
  result.warnings = verdict.warnings;
  result.reasons = verdict.reasons;
  result.exit = verdict.exit;
  delete result.notes;
  fs.writeFileSync(path.join(outDir, names.json), JSON.stringify(result, null, 2) + '\n');

  console.log(`url: ${url}${seed ? '  (seeded)' : ''}  status: ${result.widths.map((w) => `${w.width}px=${w.status}`).join(' ')}`);
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
