#!/usr/bin/env node
// Single controlled path for the dev processes: the War Room dev server and the worker.
// Usage: node scripts/dev-server.mjs start|stop|status [warroom|worker|all]   (default: all)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dotenvLine, withDotenvArgus } from './dev-env.mjs';
import { listLocks, lockStatusLine, onPath, wrapCommand } from './inhibit.mjs';
import { exitsLogFile, readState, stateFile, stopFile } from './supervise.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_DIR = path.join(ROOT, '.data', 'run');
const WARROOM_PID_FILE = path.join(RUN_DIR, 'warroom-dev.pid');
const WARROOM_LOG_FILE = path.join(RUN_DIR, 'warroom-dev.log');
const WORKER_PID_FILE = path.join(RUN_DIR, 'worker.pid');
const WORKER_LOG_FILE = path.join(RUN_DIR, 'worker.log');
const PORT = 3100;
const URL = `http://localhost:${PORT}/`;
const START_TIMEOUT_MS = 90_000;
const WORKER_START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const POLL_MS = 500;
const TARGETS = ['warroom', 'worker', 'all'];

// ARGUS_* from the repo-root .env, shell wins; both processes get the same environment.
const DOTENV = withDotenvArgus(process.env, path.join(ROOT, '.env'));
const CHILD_ENV = DOTENV.env;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Each long-lived process runs under `systemd-inhibit` (blocks lid-close and sleep). The PID
// file holds the group leader, and stop signals the whole group, so the wrapper is never
// signalled alone. The lock ends with the process, on stop or crash.
const INHIBIT_AVAILABLE = onPath();
let warned = false;
function inhibited(command, args, why) {
  const wrapped = wrapCommand(command, args, `${why}; lid close and sleep are blocked until it stops`, INHIBIT_AVAILABLE);
  if (wrapped.warning && !warned) {
    warned = true;
    console.warn(wrapped.warning);
  }
  return wrapped;
}

function readPid(pidFile) {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Signal 0 only probes existence. The group probe checks the whole process
// group, which is the unit this script starts and stops.
function alive(pid, group = false) {
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function removePidFile(pidFile) {
  fs.rmSync(pidFile, { force: true });
}

function tailLog(logFile, lines) {
  try {
    return fs.readFileSync(logFile, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

// Ready means a 2xx. Nuxt answers 503 while it is still loading the app.
async function answers() {
  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

// The worker logs `[worker] tick <ISO time>` at the start of every tick. Only
// output written after this start counts, so an old log cannot fake readiness.
function workerTicked(fromOffset) {
  try {
    const text = fs.readFileSync(WORKER_LOG_FILE).subarray(fromOffset).toString('utf8');
    return /^\[worker\] tick /m.test(text);
  } catch {
    return false;
  }
}

// The supervisor (scripts/supervise.mjs) is the group leader. It only stays down for a SIGTERM that follows its stop marker,
// so every intended stop writes the marker first.
async function terminate(pid, name) {
  if (!alive(pid, true)) return;
  fs.writeFileSync(stopFile(RUN_DIR, name), '');
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline && alive(pid, true)) await sleep(POLL_MS);
  if (alive(pid, true)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group exited between the check and the kill.
    }
  }
}

// Starts `cmd` under scripts/supervise.mjs in its own process group (pgid === child.pid); the supervisor restarts it after any exit.
function spawnSupervised(name, cmd, logFd) {
  fs.rmSync(stopFile(RUN_DIR, name), { force: true });
  fs.rmSync(stateFile(RUN_DIR, name), { force: true });
  const args = [path.join(ROOT, 'scripts', 'supervise.mjs'), '--name', name, '--run-dir', RUN_DIR, '--', cmd.command, ...cmd.args];
  return spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: ['ignore', logFd, logFd], env: CHILD_ENV });
}

async function warroomStart(tag) {
  const existing = readPid(WARROOM_PID_FILE);
  if (existing && alive(existing, true)) {
    console.log(`${tag}already running (pid ${existing})`);
    return 0;
  }
  removePidFile(WARROOM_PID_FILE);

  fs.mkdirSync(RUN_DIR, { recursive: true });
  const logFd = fs.openSync(WARROOM_LOG_FILE, 'a');
  const cmd = inhibited('pnpm', ['--filter', '@argus/warroom', 'exec', 'nuxt', 'dev', '--port', String(PORT)], 'argus War Room is running');
  const child = spawnSupervised('warroom', cmd, logFd);
  fs.closeSync(logFd);
  child.unref();
  fs.writeFileSync(WARROOM_PID_FILE, `${child.pid}\n`);

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await answers()) {
      console.log(`${tag}up on http://localhost:${PORT}/ (pid ${child.pid})`);
      return 0;
    }
    if (!alive(child.pid, true)) break;
    await sleep(POLL_MS);
  }

  console.error(`${tag}War Room did not answer on port ${PORT} within ${START_TIMEOUT_MS / 1000}s. Last 20 log lines:`);
  console.error(tailLog(WARROOM_LOG_FILE, 20));
  // Do not leave a half-started server running.
  await terminate(child.pid, 'warroom');
  removePidFile(WARROOM_PID_FILE);
  return 1;
}

async function workerStart(tag) {
  const existing = readPid(WORKER_PID_FILE);
  if (existing && alive(existing, true)) {
    console.log(`${tag}already running (pid ${existing})`);
    return 0;
  }
  removePidFile(WORKER_PID_FILE);

  fs.mkdirSync(RUN_DIR, { recursive: true });
  const fromOffset = fs.existsSync(WORKER_LOG_FILE) ? fs.statSync(WORKER_LOG_FILE).size : 0;
  const logFd = fs.openSync(WORKER_LOG_FILE, 'a');
  const cmd = inhibited('pnpm', ['--filter', '@argus/worker', 'start'], 'argus worker is running');
  const child = spawnSupervised('worker', cmd, logFd);
  fs.closeSync(logFd);
  child.unref();
  fs.writeFileSync(WORKER_PID_FILE, `${child.pid}\n`);

  const deadline = Date.now() + WORKER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (workerTicked(fromOffset)) {
      console.log(`${tag}up, first tick logged in .data/run/worker.log (pid ${child.pid})`);
      return 0;
    }
    if (!alive(child.pid, true)) break;
    await sleep(POLL_MS);
  }

  console.error(`${tag}worker did not log a tick within ${WORKER_START_TIMEOUT_MS / 1000}s. Last 20 log lines:`);
  console.error(tailLog(WORKER_LOG_FILE, 20));
  await terminate(child.pid, 'worker');
  removePidFile(WORKER_PID_FILE);
  return 1;
}

async function stopOne(pidFile, tag, name) {
  const pid = readPid(pidFile);
  if (!pid || !alive(pid, true)) {
    removePidFile(pidFile);
    console.log(`${tag}not running`);
    return 0;
  }
  await terminate(pid, name);
  removePidFile(pidFile);
  console.log(`${tag}stopped`);
  return 0;
}

// Restart count and last exit come from the supervisor's state file (absent for a process started before supervision).
function supervisorDetail(name) {
  const s = readState(RUN_DIR, name);
  if (!s) return '';
  const last = s.lastExit ? `, last exit ${s.lastExit.how} at ${s.lastExit.at} after ${(s.lastExit.uptimeMs / 1000).toFixed(0)}s` : '';
  return `; restarts: ${s.restarts}${last}; exit log: ${path.relative(ROOT, exitsLogFile(RUN_DIR, name))}`;
}

function statusOne(pidFile, tag, detail, name) {
  const pid = readPid(pidFile);
  if (pid && alive(pid, true)) {
    console.log(`${tag}running (pid ${pid})${detail}${supervisorDetail(name)}`);
  } else {
    const gaveUp = readState(RUN_DIR, name)?.status === 'gave-up';
    console.log(`${tag}not running${gaveUp ? `; supervisor gave up after repeated exits${supervisorDetail(name)}` : ''}`);
  }
  return 0;
}

const TARGET_FNS = {
  warroom: {
    start: (tag) => warroomStart(tag),
    stop: (tag) => stopOne(WARROOM_PID_FILE, tag, 'warroom'),
    status: (tag) => statusOne(WARROOM_PID_FILE, tag, ` on ${PORT}`, 'warroom'),
  },
  worker: {
    start: (tag) => workerStart(tag),
    stop: (tag) => stopOne(WORKER_PID_FILE, tag, 'worker'),
    status: (tag) => statusOne(WORKER_PID_FILE, tag, '', 'worker'),
  },
};

// `all` starts the War Room first, then the worker, and stops in reverse order.
// A failed start stops the sequence so the worker is never left behind a dead War Room.
async function run(command, target) {
  const multi = target === 'all';
  const tagFor = (name) => (multi ? `${name}: ` : '');
  const names = multi ? ['warroom', 'worker'] : [target];
  if (command === 'stop') names.reverse();

  let code = 0;
  for (const name of names) {
    const rc = await TARGET_FNS[name][command](tagFor(name));
    code = Math.max(code, rc);
    if (rc !== 0 && command === 'start') break;
  }
  return code;
}

const [command, target = 'all'] = process.argv.slice(2);
if (!['start', 'stop', 'status'].includes(command) || !TARGETS.includes(target)) {
  console.error('usage: node scripts/dev-server.mjs start|stop|status [warroom|worker|all]');
  process.exit(2);
}
if (command === 'start') console.log(dotenvLine(DOTENV));
process.exitCode = await run(command, target);
if (command === 'status') console.log(lockStatusLine(INHIBIT_AVAILABLE, INHIBIT_AVAILABLE ? listLocks() : null));
