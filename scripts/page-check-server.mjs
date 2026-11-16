// The private War Room `pnpm page:check --seed` checks: a throwaway DB under ~/.cache/argus-scratch (home disk, never /tmp), filled by
// scripts/page-seed.mjs through the Datastore API, and the Nuxt dev server on its own port with that DB, as its own process group.
// `stop()` kills the group by PID (never by name), waits for the port to be free and removes the DB dir. Never touches the live DB,
// the live War Room (port 3100) or `.env` (ARGUS_NO_DOTENV). Same pattern as verify-boot step 4; verify-boot is left as it is.
// Ticket: .scratch/warroom-redesign/issues/14-page-check-seed-option.md
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLiveDb } from './live-db-guard.mjs';
import { seedDatastore } from './page-seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SEED_DEFAULT_PORT = 3217;
export const LIVE_PORT = 3100; // scripts/dev-server.mjs PORT
const READY_TIMEOUT_MS = 120_000;
const GRACE_MS = 6_000;
const POLL_MS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const seedBase = (home = os.homedir()) => path.join(home, '.cache', 'argus-scratch');
export const seedDirFor = (base, pid = process.pid) => path.join(base, `page-seed-${pid}`);

// Returns a problem string when a seeded run must not use `port`, else null.
export function seedPortProblem(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return `bad port ${port}`;
  if (port === LIVE_PORT) return `--seed must not use port ${LIVE_PORT}: that is the live War Room`;
  return null;
}

// Returns a problem string when `dbPath` is (or links to) a live DB, or is not under the home-disk scratch base, else null.
export function seedDbProblem(dbPath, liveDbs, base = seedBase()) {
  if (isLiveDb(dbPath, liveDbs)) return `seed DB ${dbPath} is the live database`;
  const resolved = path.resolve(dbPath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return `seed DB ${dbPath} is not under ${base}`;
  if (resolved.startsWith('/tmp/')) return 'seed DB must not be under /tmp';
  return null;
}

export const liveDbPaths = (env = process.env) => [env.ARGUS_DB, path.join(ROOT, '.data', 'argus.db')];

function listening(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// Something on any loopback address would be mistaken for our server.
export async function portBusy(port) {
  for (const host of ['127.0.0.1', '::1']) if (await listening(port, host)) return true;
  return false;
}

async function get(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return res.status;
  } catch {
    return 0;
  }
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Every seeded server still running, so a signal handler can stop them all (also while one is still booting).
const active = new Set();
export const stopAllSeeded = () => Promise.all([...active].map((stop) => stop()));

// Creates the DB dir and DB, seeds it with `now`, starts the server and waits until it answers.
// Returns { dir, port, pgid, ids, counts, stop }. On any failure it cleans up after itself and throws.
export async function startSeededServer({ port = SEED_DEFAULT_PORT, now, base = seedBase(), liveDbs = liveDbPaths() }) {
  // A refusal (exit 2) writes nothing: no dir, no DB, no process.
  const refuse = (message) => Object.assign(new Error(message), { refusal: true });
  const portProblem = seedPortProblem(port);
  if (portProblem) throw refuse(portProblem);
  const dir = seedDirFor(base);
  const dbPath = path.join(dir, 'argus.db');
  const dbProblem = seedDbProblem(dbPath, liveDbs, base);
  if (dbProblem) throw refuse(dbProblem);
  if (await portBusy(port)) throw refuse(`port ${port} is already in use; pass --port with a free port`);

  fs.mkdirSync(dir, { recursive: true });
  let pgid = null;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (pgid !== null) {
      try {
        process.kill(-pgid, 'SIGTERM');
      } catch {
        // Already gone.
      }
      const deadline = Date.now() + GRACE_MS;
      while (groupAlive(pgid) && Date.now() < deadline) await sleep(POLL_MS);
      if (groupAlive(pgid)) {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {
          // Exited between the check and the kill.
        }
      }
      const freeBy = Date.now() + GRACE_MS;
      while ((await portBusy(port)) && Date.now() < freeBy) await sleep(POLL_MS);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    active.delete(stop);
  };
  active.add(stop);

  try {
    const { Datastore } = await import('../packages/core/src/index.ts');
    const store = Datastore.open(dbPath);
    let seeded;
    try {
      seeded = await seedDatastore(store, now);
    } finally {
      store.close();
    }
    if (stopped) throw new Error('stopped by a signal before the server started');
    // Nuxt/vite leave a `nuxt-vite-*` dir in TMPDIR when stopped by a signal: give the server its own, inside the dir that is removed.
    const serverTmp = path.join(dir, 'tmp');
    fs.mkdirSync(serverTmp);
    const logFile = path.join(dir, 'warroom.log');
    const logFd = fs.openSync(logFile, 'a');
    const child = spawn('pnpm', ['--dir', ROOT, '--filter', '@argus/warroom', 'exec', 'nuxt', 'dev', '--port', String(port), '--strictPort'], {
      cwd: ROOT,
      // ARGUS_NO_DOTENV: never the operator's .env. TMPDIR: inside the throwaway dir, never /tmp.
      env: { ...process.env, ARGUS_DB: dbPath, ARGUS_DATA_DIR: dir, ARGUS_NO_DOTENV: '1', TMPDIR: serverTmp },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    fs.closeSync(logFd);
    pgid = child.pid;
    let exited = false;
    child.on('exit', () => (exited = true));
    const tail = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-3).join(' | ');
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let up = false;
    while (!up && !exited && !stopped && Date.now() < deadline) {
      const status = await get(`http://localhost:${port}/_nuxt/`);
      up = status !== 0 && status !== 503; // Nuxt answers 503 while it loads the app
      if (!up) await sleep(500);
    }
    if (!up) throw new Error(`dev server not up within ${READY_TIMEOUT_MS / 1000}s; log tail: ${tail()}`);
    if (exited || !fs.readFileSync(logFile, 'utf8').includes(`:${port}`)) throw new Error(`dev server did not bind port ${port}; log tail: ${tail()}`);
    return { dir, port, pgid, ids: seeded.ids, counts: seeded.counts, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}
