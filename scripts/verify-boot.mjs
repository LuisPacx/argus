#!/usr/bin/env node
// One command that proves the worker boots and shuts down cleanly. Verifiers run `pnpm verify:boot`.
// Step 1: `--once` dry run exits 0, logs the brain's argv with the isolation flags, and logs the Build Runner's clone,
// repo-create, claude spawn and deploy commands for an approved Proposal (running none of them), and the Build containers'
// `podman run` lines: every required containment flag present, none of the forbidden ones (--privileged, --network host, a mount of
// the Operator's home, ...). The policy is packages/core/src/containment-policy.ts, shared with `pnpm verify:contain`.
// Step 2: long-running dry run ticks, gets SIGTERM, and exits 0 within 10s.
// Step 3: no process from step 2's process group survives.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Datastore } from '../packages/core/src/index.ts';
import { checkDryRunOutput } from '../packages/core/src/containment-policy.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_MAIN = path.join(ROOT, 'apps', 'worker', 'src', 'main.ts');
const TICK_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 10_000;
const GROUP_GRACE_MS = 2_000;
const RUN_ONCE_TIMEOUT_MS = 60_000;
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
function seed(db) {
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
  store.close();
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
  const containment = checkDryRunOutput(stdout, { operatorHome: os.homedir() });
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-verify-boot-'));
let pgid = null;
try {
  seed(path.join(dir, 'argus.db'));
  await stepOnce(dir);
  pgid = await stepLongRunning(dir);
  await stepNoSurvivors(pgid);
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

const ok = results.length === 3 && results.every(Boolean);
console.log(`${ok ? 'PASS' : 'FAIL'} verify:boot overall`);
process.exit(ok ? 0 : 1);
