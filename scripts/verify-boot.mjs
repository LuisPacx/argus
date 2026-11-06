#!/usr/bin/env node
// One command that proves the worker boots and shuts down cleanly. Verifiers run `pnpm verify:boot`.
// Step 1: `--once` dry run exits 0, logs the brain's argv with the isolation flags, and logs the Build Runner's clone,
// repo-create, claude spawn and deploy commands for an approved Proposal (running none of them), and the Build containers'
// `podman run` lines: every required containment flag present, none of the forbidden ones (--privileged, --network host, a mount of
// the Operator's home, ...). The policy is packages/core/src/containment-policy.ts, shared with `pnpm verify:contain`.
// Step 2: long-running dry run ticks, gets SIGTERM, and exits 0 within 10s.
// Step 3: no process from step 2's process group survives.
// Step 4: the real War Room dev server (own temp DB, port ARGUS_VERIFY_WARROOM_PORT, default 3150) answers 2xx with no Nuxt
// error payload on every page route under apps/warroom/app/pages (`/`, `/narratives`, `/narratives/<id>`, `/proposals/<id>`, ...),
// and no process from its process group survives.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Datastore, clusterNewSignals } from '../packages/core/src/index.ts';
import { checkDryRunOutput } from '../packages/core/src/containment-policy.ts';
import { pageProblem, pageRoutes } from './warroom-pages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_MAIN = path.join(ROOT, 'apps', 'worker', 'src', 'main.ts');
const TICK_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 10_000;
const GROUP_GRACE_MS = 2_000;
const RUN_ONCE_TIMEOUT_MS = 60_000;
const WARROOM_PORT = Number.parseInt(process.env.ARGUS_VERIFY_WARROOM_PORT ?? '3150', 10);
const WARROOM_PAGES = path.join(ROOT, 'apps', 'warroom', 'app', 'pages');
const WARROOM_READY_TIMEOUT_MS = 120_000;
const PAGE_TIMEOUT_MS = 90_000;
const POLL_MS = 50;
const REQUIRED_FLAGS = ['--strict-mcp-config', '--setting-sources project', '--tools'];
const REQUIRED_BUILD_LINES = ['dry-run: git clone', 'repo create boot-build --private', 'dry-run: claude (cwd', '--permission-mode acceptEdits', 'dry-run: wrangler deploy --name boot-build'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

function report(step, ok, detail) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${detail ? `: ${detail}` : ''}`);
}

function workerEnv(dir) {
  return { ...process.env, ARGUS_DB: path.join(dir, 'argus.db'), ARGUS_DATA_DIR: dir, ARGUS_DRY_RUN: '1', ARGUS_BUILD_ROOT: path.join(dir, 'code') };
}

// Seeds one shortlisted Proposal through the core Datastore API, the same path the War Room takes.
// Returns the ids the dynamic War Room pages need.
async function seed(db) {
  const store = Datastore.open(db);
  const p = store.createProposal({
    narrativeSummary: 'n',
    techOneLiner: 't',
    whyNow: 'w',
    name: 'Boot Check',
    ticker: 'BOOT',
    description: 'd',
    evidenceLinks: [],
  });
  store.transition(p.id, 'shortlisted', 'operator');
  // A second Proposal, approved, for the Build Runner's dry run.
  const b = store.createProposal({
    narrativeSummary: 'n',
    techOneLiner: 't',
    whyNow: 'w',
    name: 'Boot Build',
    ticker: 'BUILD',
    description: 'd',
    evidenceLinks: [],
  });
  store.transition(b.id, 'shortlisted', 'operator');
  store.completeSpec(b.id, { path: path.join(path.dirname(db), 'spec.md'), hash: 'h' });
  store.transition(b.id, 'approved', 'operator');
  // One Narrative, for /narratives/<id>.
  store.recordSignals([{ id: 's:1', sourceId: 'rss:a', sourceLabel: 'Feed A', title: 'Boot signal', summary: 's', url: 'https://a.example/1', publishedAt: new Date().toISOString() }]);
  await clusterNewSignals(store, { id: 'boot', dimension: 1, embed: async () => [1] });
  const narrativeId = store.listNarratives()[0]?.id;
  store.close();
  return { proposals: p.id, narratives: narrativeId };
}

// Signal 0 probes existence of the whole group. EPERM still means something is alive.
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function stepOnce(dir) {
  const child = spawn(process.execPath, [WORKER_MAIN, '--once'], {
    cwd: ROOT,
    env: workerEnv(dir),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), RUN_ONCE_TIMEOUT_MS);
  const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
  clearTimeout(timer);

  const line = stdout.split('\n').find((l) => l.includes('[brain] dry-run:')) ?? '';
  const missing = REQUIRED_FLAGS.filter((flag) => !line.includes(flag));
  const missingBuild = REQUIRED_BUILD_LINES.filter((part) => !stdout.includes(part));
  const containment = checkDryRunOutput(stdout, { operatorHome: os.homedir(), mountRoots: [dir] });
  if (code !== 0) {
    report('step 1 once dry-run', false, `exit ${code}; stderr tail: ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
  } else if (!line) {
    report('step 1 once dry-run', false, 'exit 0 but no "[brain] dry-run:" line on stdout');
  } else if (missing.length > 0) {
    report('step 1 once dry-run', false, `dry-run line lacks ${missing.join(', ')}`);
  } else if (missingBuild.length > 0) {
    report('step 1 once dry-run', false, `Build Runner dry-run output lacks: ${missingBuild.join(' | ')}`);
  } else if (containment.length > 0) {
    report('step 1 once dry-run', false, `containment: ${containment.join(' | ')}`);
  } else {
    report('step 1 once dry-run', true, `exit 0; dry-run line has ${REQUIRED_FLAGS.join(', ')}; Build dry-run logs clone, repo create, claude, deploy; podman run lines for egress x2, build, install, bundle meet the containment policy`);
  }
}

// Returns the worker's process group id, or null if it never started.
async function stepLongRunning(dir) {
  // Direct child, no shell: `detached` makes it a process-group leader, so pgid === pid.
  const child = spawn(process.execPath, [WORKER_MAIN], {
    cwd: ROOT,
    env: workerEnv(dir),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pgid = child.pid;
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stdout += d));
  let exitCode;
  let exited = false;
  const exitedP = new Promise((resolve) =>
    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
      resolve(code);
    }),
  );

  const tickDeadline = Date.now() + TICK_TIMEOUT_MS;
  while (!stdout.includes('[worker] tick ') && !exited && Date.now() < tickDeadline) await sleep(POLL_MS);
  if (!stdout.includes('[worker] tick ')) {
    report('step 2 SIGTERM shutdown', false, exited ? `worker exited ${exitCode} before its first tick` : `no tick within ${TICK_TIMEOUT_MS / 1000}s`);
    if (!exited) child.kill('SIGTERM');
    await Promise.race([exitedP, sleep(EXIT_TIMEOUT_MS)]);
    return pgid;
  }

  const sentAt = Date.now();
  child.kill('SIGTERM');
  const timeout = sleep(EXIT_TIMEOUT_MS).then(() => 'timeout');
  const outcome = await Promise.race([exitedP.then(() => 'exited'), timeout]);
  if (outcome === 'timeout') {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Group already gone.
    }
    await exitedP;
    report('step 2 SIGTERM shutdown', false, `worker did not exit within ${EXIT_TIMEOUT_MS / 1000}s of SIGTERM; group SIGKILLed`);
  } else {
    const elapsed = Date.now() - sentAt;
    if (exitCode === 0 && elapsed <= EXIT_TIMEOUT_MS) {
      const stopped = stdout.includes('[worker] stopped') ? ', logged "[worker] stopped"' : ', no "[worker] stopped" line';
      report('step 2 SIGTERM shutdown', true, `tick seen, SIGTERM, exit 0 in ${elapsed} ms${stopped}`);
    } else {
      report('step 2 SIGTERM shutdown', false, `exit ${exitCode} after ${elapsed} ms`);
    }
  }
  return pgid;
}

async function stepNoSurvivors(pgid) {
  const deadline = Date.now() + GROUP_GRACE_MS;
  while (groupAlive(pgid) && Date.now() < deadline) await sleep(POLL_MS);
  if (!groupAlive(pgid)) {
    report('step 3 no survivors', true, `no process left in group ${pgid}`);
    return;
  }
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // Exited between the check and the kill.
  }
  report('step 3 no survivors', false, `process group ${pgid} still alive; SIGKILLed`);
}

async function get(url, timeoutMs) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return { status: 0, body: String(err.message ?? err) };
  }
}

// Starts the real War Room dev server on its own DB, GETs every page route, then stops it and checks nothing survives.
async function stepWarroom(dir, ids) {
  const base = `http://localhost:${WARROOM_PORT}`;
  // Something already listening on any loopback address would be mistaken for our server.
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    if ((await get(`http://${host}:${WARROOM_PORT}/`, 2_000)).status !== 0) {
      report('step 4 War Room pages', false, `port ${WARROOM_PORT} already answers on ${host}; set ARGUS_VERIFY_WARROOM_PORT to a free port`);
      return;
    }
  }
  const logFile = path.join(dir, 'warroom.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn('pnpm', ['--dir', ROOT, '--filter', '@argus/warroom', 'exec', 'nuxt', 'dev', '--port', String(WARROOM_PORT), '--strictPort'], {
    cwd: ROOT,
    // ARGUS_NO_DOTENV: /api/research reads the config from the environment; never the operator's .env (CODING_STANDARDS rule 16).
    env: { ...process.env, ARGUS_DB: path.join(dir, 'argus.db'), ARGUS_DATA_DIR: dir, ARGUS_NO_DOTENV: '1' },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  const pgid = child.pid;
  let exited = false;
  child.on('exit', () => (exited = true));
  try {
    // Nuxt answers 503 while it loads the app; anything else means the server is up.
    const readyDeadline = Date.now() + WARROOM_READY_TIMEOUT_MS;
    let up = false;
    while (!up && !exited && Date.now() < readyDeadline) {
      const { status } = await get(`${base}/_nuxt/`, 2_000);
      up = status !== 0 && status !== 503;
      if (!up) await sleep(500);
    }
    if (!up) {
      const tail = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-3).join(' | ');
      report('step 4 War Room pages', false, `dev server not up within ${WARROOM_READY_TIMEOUT_MS / 1000}s; log tail: ${tail}`);
      return;
    }
    // --strictPort makes a different port an exit, not a fallback; confirm from the server's own log that it is on ours.
    if (exited || !fs.readFileSync(logFile, 'utf8').includes(`:${WARROOM_PORT}`)) {
      report('step 4 War Room pages', false, `dev server did not bind port ${WARROOM_PORT}; log tail: ${fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-3).join(' | ')}`);
      return;
    }
    const routes = pageRoutes(WARROOM_PAGES, ids);
    const problems = [];
    for (const route of routes) {
      const { status, body } = await get(`${base}${route}`, PAGE_TIMEOUT_MS);
      const problem = status === 0 ? `no answer (${body})` : pageProblem(status, body);
      if (problem) problems.push(`GET ${route}: ${problem}`);
    }
    if (problems.length > 0) report('step 4 War Room pages', false, problems.join(' | '));
    else report('step 4 War Room pages', true, `${routes.join(', ')} all answered 2xx with no Nuxt error payload`);
  } finally {
    try {
      process.kill(-pgid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    const deadline = Date.now() + GROUP_GRACE_MS * 3;
    while (groupAlive(pgid) && Date.now() < deadline) await sleep(POLL_MS);
    if (groupAlive(pgid)) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        // Exited between the check and the kill.
      }
      report('step 4 War Room stop', false, `process group ${pgid} ignored SIGTERM; SIGKILLed`);
    }
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-verify-boot-'));
let pgid = null;
try {
  const ids = await seed(path.join(dir, 'argus.db'));
  await stepOnce(dir);
  pgid = await stepLongRunning(dir);
  await stepNoSurvivors(pgid);
  await stepWarroom(dir, ids);
} catch (err) {
  report('setup', false, err.message);
} finally {
  if (pgid !== null && groupAlive(pgid)) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

const ok = results.length === 4 && results.every(Boolean);
console.log(`${ok ? 'PASS' : 'FAIL'} verify:boot overall`);
process.exit(ok ? 0 : 1);
