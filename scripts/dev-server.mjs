#!/usr/bin/env node
// Single controlled path for the War Room dev server.
// Usage: node scripts/dev-server.mjs start|stop|status
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_DIR = path.join(ROOT, '.data', 'run');
const PID_FILE = path.join(RUN_DIR, 'warroom-dev.pid');
const LOG_FILE = path.join(RUN_DIR, 'warroom-dev.log');
const PORT = 3100;
const URL = `http://localhost:${PORT}/`;
const START_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 10_000;
const POLL_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
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

function removePidFile() {
  fs.rmSync(PID_FILE, { force: true });
}

function tailLog(lines) {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-lines).join('\n');
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

async function terminate(pid) {
  if (!alive(pid, true)) return;
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

async function start() {
  const existing = readPid();
  if (existing && alive(existing, true)) {
    console.log(`already running (pid ${existing})`);
    return 0;
  }
  removePidFile();

  fs.mkdirSync(RUN_DIR, { recursive: true });
  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(
    'pnpm',
    ['--filter', '@argus/warroom', 'exec', 'nuxt', 'dev', '--port', String(PORT)],
    { cwd: ROOT, detached: true, stdio: ['ignore', logFd, logFd] },
  );
  fs.closeSync(logFd);
  child.unref();
  fs.writeFileSync(PID_FILE, `${child.pid}\n`);

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await answers()) {
      console.log(`up on http://localhost:${PORT} (pid ${child.pid})`);
      return 0;
    }
    if (!alive(child.pid, true)) break;
    await sleep(POLL_MS);
  }

  console.error(`War Room did not answer on port ${PORT} within ${START_TIMEOUT_MS / 1000}s. Last 20 log lines:`);
  console.error(tailLog(20));
  // Do not leave a half-started server running.
  await terminate(child.pid);
  removePidFile();
  return 1;
}

async function stop() {
  const pid = readPid();
  if (!pid || !alive(pid, true)) {
    removePidFile();
    console.log('not running');
    return 0;
  }
  await terminate(pid);
  removePidFile();
  console.log('stopped');
  return 0;
}

function status() {
  const pid = readPid();
  console.log(pid && alive(pid, true) ? `running (pid ${pid}) on ${PORT}` : 'not running');
  return 0;
}

const commands = { start, stop, status };
const command = process.argv[2];
if (!commands[command]) {
  console.error('usage: node scripts/dev-server.mjs start|stop|status');
  process.exit(2);
}
process.exitCode = await commands[command]();
