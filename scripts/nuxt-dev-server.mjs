// Shared by scripts/verify-boot.mjs (step 4) and scripts/page-check-server.mjs: start the War Room's Nuxt dev server as its own process
// group, wait until it answers on its port, and stop the group by PID (never by name). The callers differ only in env, port, log file,
// how long they let the group take to stop, and what they do around it; those stay parameters.
// Ticket: .scratch/warroom-redesign/issues/18-dedupe-verify-boot.md
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Signal 0 probes existence of the whole group. EPERM still means something is alive.
export function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// GET that never throws: status 0 means no answer (body holds the error message).
export async function httpGet(url, timeoutMs) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return { status: 0, body: String(err.message ?? err) };
  }
}

// Env for a throwaway dev server: its own build dir under `dir` (see apps/warroom/nuxt.config.ts). Nuxt keeps one dev lock per
// build dir, so a second `nuxt dev` on the shared .nuxt exits 1 ("Another Nuxt dev server is already running") while the live War
// Room runs, and would rewrite the live server's build output.
export const privateBuildEnv = (env, dir) => ({ ...env, ARGUS_NUXT_BUILD_DIR: path.join(dir, 'nuxt') });

export const logTail = (logFile) => fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-20).join(' | ');

// Spawns `nuxt dev --strictPort` for @argus/warroom in a new process group (pgid === pid), stdout and stderr appended to `logFile`.
// Returns { pgid, hasExited() }.
export function spawnNuxtDev({ root, port, env, logFile }) {
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn('pnpm', ['--dir', root, '--filter', '@argus/warroom', 'exec', 'nuxt', 'dev', '--port', String(port), '--strictPort'], {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  let exited = false;
  child.on('exit', () => (exited = true));
  return { pgid: child.pid, hasExited: () => exited };
}

// Waits until the server answers (Nuxt answers 503 while it loads the app), the process exits, `cancelled()` is true or the timeout
// passes. Then confirms from the server's own log that it bound `port` (--strictPort makes another port an exit, not a fallback).
// Returns null when up, else a problem string.
export async function waitForNuxtReady({ port, logFile, hasExited, timeoutMs, cancelled = () => false }) {
  const deadline = Date.now() + timeoutMs;
  let up = false;
  while (!up && !hasExited() && !cancelled() && Date.now() < deadline) {
    const { status } = await httpGet(`http://localhost:${port}/_nuxt/`, 2_000);
    up = status !== 0 && status !== 503;
    if (!up) await sleep(500);
  }
  if (!up) return `dev server not up within ${timeoutMs / 1000}s; log tail: ${logTail(logFile)}`;
  if (hasExited() || !fs.readFileSync(logFile, 'utf8').includes(`:${port}`)) return `dev server did not bind port ${port}; log tail: ${logTail(logFile)}`;
  return null;
}

// SIGTERM the group, wait up to `graceMs` for it to go, then SIGKILL. Returns true when SIGKILL was needed.
export async function stopGroup(pgid, graceMs, pollMs = 100) {
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  const deadline = Date.now() + graceMs;
  while (groupAlive(pgid) && Date.now() < deadline) await sleep(pollMs);
  if (!groupAlive(pgid)) return false;
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // Exited between the check and the kill.
  }
  return true;
}
