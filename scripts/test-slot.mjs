// Machine-wide test slots: at most SLOTS full suites (`pnpm check`) run at once across every worktree and agent.
// A slot is a file `slot-N.json` created atomically (flag "wx") in one directory on the home disk, holding the holder's
// { pid, startTime, worktree, command, since }. A holder that died (or whose pid was reused) is detected, so a crashed or
// kill -9'd check never keeps a slot: no cleanup step exists or is needed.
// CLI: `node scripts/test-slot.mjs status` (exit 1 when every slot is held) | `wait` (block until one is free, take nothing).
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, rmdirSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SLOTS = 2;
const DEFAULT_TIMEOUT_MS = 45 * 60_000;
const WAIT_REPRINT_MS = 30_000;
const UNREADABLE_GRACE_MS = 5_000; // a slot file that does not parse is "being written" for this long, then stale
const LOCK_STALE_MS = 10_000;

/** Where the slot files live: shared by every worktree, on the home disk, never /tmp. */
export function slotDir(env = process.env) {
  if (env.ARGUS_TEST_SLOT_DIR) return env.ARGUS_TEST_SLOT_DIR;
  const state = env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state');
  return join(state, 'argus', 'test-slots');
}

/**
 * A process's start time (field 22 of /proc/<pid>/stat, in clock ticks since boot), or null when unreadable.
 * Linux only: elsewhere it is null, and a null on either side skips the start-time comparison, leaving only the
 * `process.kill(pid, 0)` liveness check (PID reuse is then not detected, which is acceptable: nothing crashes).
 */
export function readStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // after "(comm)", which may hold spaces
    return fields[19] ?? null; // field 22 overall = index 19 after pid and comm are dropped (state is index 0)
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else
  }
}

/** A holder record is stale when its pid is dead or the pid now belongs to a different process. */
function holderStale(h) {
  if (!Number.isInteger(h.pid) || !pidAlive(h.pid)) return true;
  const now = readStartTime(h.pid);
  return h.startTime != null && now != null && String(h.startTime) !== now;
}

const slotFile = (dir, n) => join(dir, `slot-${n}.json`);

/** The state of one slot: { held: false } or { held: true, holder } (holder may be {} while its file is being written). */
function inspect(dir, n) {
  const file = slotFile(dir, n);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { held: false };
  }
  let holder = null;
  try {
    holder = JSON.parse(raw);
  } catch {
    // empty or partial file: the creator is mid-write, or crashed between create and write
  }
  if (holder && typeof holder === 'object') return holderStale(holder) ? { held: false, stale: true } : { held: true, holder };
  try {
    if (Date.now() - statSync(file).mtimeMs > UNREADABLE_GRACE_MS) return { held: false, stale: true };
  } catch {
    return { held: false };
  }
  return { held: true, holder: {} };
}

/** Every slot with its state. */
export function status(dir = slotDir()) {
  return Array.from({ length: SLOTS }, (_, slot) => ({ slot, ...inspect(dir, slot) }));
}

const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const age = (ms) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};
const holderText = (h) => `${h.worktree ?? '?'} pid ${h.pid ?? '?'} since ${h.since ? clock(h.since) : '?'}`;
const holdersText = (dir) => {
  const held = status(dir).filter((s) => s.held);
  return `${held.length} of ${SLOTS} held: ${held.map((s) => holderText(s.holder)).join(', ')}`;
};

/** Human-readable status plus the exit code `status` uses: 0 when at least one slot is free, 1 when all are held. */
export function formatStatus({ dir = slotDir() } = {}) {
  const all = status(dir);
  const lines = all.map((s) =>
    s.held
      ? `slot ${s.slot}: held by ${s.holder.worktree ?? '?'} (pid ${s.holder.pid ?? '?'}, ${s.holder.command ?? '?'}, ${s.holder.since ? age(s.holder.since) : '?'})`
      : `slot ${s.slot}: free`,
  );
  return { text: lines.join('\n'), code: all.every((s) => s.held) ? 1 : 0 };
}

/** Serialise acquirers with a mkdir lock so reclaiming a stale slot cannot race another reclaimer. */
function withLock(dir, fn) {
  const lock = join(dir, 'lock');
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      mkdirSync(lock);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock); // its holder died inside the lock
      } catch {
        // gone already
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      continue;
    }
    try {
      return fn();
    } finally {
      try {
        rmdirSync(lock);
      } catch {
        // already broken as stale
      }
    }
  }
  throw new Error(`test-slot: could not lock ${lock}`);
}

/** One attempt: returns { slot, release } or null when every slot is held by a live process. */
export function tryAcquire({ dir = slotDir(), worktree = process.cwd(), command = process.argv.slice(1).join(' ') } = {}) {
  // An unusable slot directory is a hard error, never a silent run without a slot: say which directory and how to move it.
  try {
    mkdirSync(dir, { recursive: true });
    return withLock(dir, () => attempt(dir, worktree, command));
  } catch (err) {
    if (err.message?.startsWith('test-slot:')) throw err;
    throw new Error(`test-slot: cannot use the slot directory ${dir} (${err.code ?? err.message}); make it writable or set ARGUS_TEST_SLOT_DIR to a writable directory`);
  }
}

function attempt(dir, worktree, command) {
  {
    for (let slot = 0; slot < SLOTS; slot++) {
      const state = inspect(dir, slot);
      if (state.held) continue;
      const file = slotFile(dir, slot);
      if (state.stale) rmSync(file, { force: true });
      let fd;
      try {
        fd = openSync(file, 'wx');
      } catch (err) {
        if (err.code === 'EEXIST') continue;
        throw err;
      }
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, startTime: readStartTime(process.pid), worktree, command, since: Date.now() }));
      } finally {
        closeSync(fd);
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          const mine = JSON.parse(readFileSync(file, 'utf8'));
          if (mine.pid === process.pid) rmSync(file, { force: true }); // never delete a slot someone reclaimed from us
        } catch {
          // already gone
        }
      };
      return { slot, release };
    }
    return null;
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const envTimeout = () => Number(process.env.ARGUS_TEST_SLOT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

async function pollUntil(attempt, { dir, timeoutMs, pollMs, onWait, sleep, label }) {
  const limit = timeoutMs ?? envTimeout();
  const start = Date.now();
  let lastPrinted = -Infinity;
  for (;;) {
    const got = attempt();
    if (got) return got;
    if (Date.now() - start >= limit) {
      throw new Error(`${label}: timed out after ${Math.round(limit / 1000)}s waiting for a test slot (${holdersText(dir)})`);
    }
    if (Date.now() - lastPrinted >= WAIT_REPRINT_MS) {
      onWait(`${label}: waiting for a test slot (${holdersText(dir)})`);
      lastPrinted = Date.now();
    }
    await sleep(pollMs);
  }
}

/** Wait for a slot and take it. Prints a visible line (onWait) when it has to wait; rejects on timeout naming the holders. */
export async function acquire({ dir = slotDir(), timeoutMs, pollMs = 2000, onWait = console.log, sleep = realSleep, label = 'check', ...who } = {}) {
  return pollUntil(() => tryAcquire({ dir, ...who }), { dir, timeoutMs, pollMs, onWait, sleep, label });
}

/** Block until some slot is free, taking nothing. */
export async function waitForFree({ dir = slotDir(), timeoutMs, pollMs = 2000, onWait = console.log, sleep = realSleep, label = 'test-slot' } = {}) {
  return pollUntil(() => (status(dir).some((s) => !s.held) ? true : null), { dir, timeoutMs, pollMs, onWait, sleep, label });
}

/**
 * Start a step as the leader of its own process group, so the step and everything it spawns (pnpm does not forward
 * signals, so vitest/tsc are grandchildren) can be signalled and awaited as one group by `killTree`.
 * Because the group is detached it no longer receives the terminal's Ctrl-C: whoever holds the slot must forward signals.
 * Resolves `closed` with the exit code (1 when it could not start or died by signal).
 */
export function spawnStep(command, args, options = {}) {
  const child = spawn(command, args, { ...options, detached: true });
  const closed = new Promise((resolve) => {
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
  return { child, closed };
}

const groupAlive = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

async function groupGone(pgid, ms, sleep) {
  const deadline = Date.now() + ms;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
  return true;
}

/**
 * Signal a step's whole process group and resolve once no process of it is left: `signal` first, then SIGKILL after
 * `graceMs` for anything that ignored it. Never rejects; gives up (resolves) if even SIGKILL leaves something after 5 s.
 */
export async function killTree(child, signal = 'SIGTERM', { graceMs = 5000, sleep = realSleep } = {}) {
  const pgid = child.pid;
  if (!pgid) return;  const send = (sig) => {
    try {
      process.kill(-pgid, sig);
    } catch {
      // group already gone
    }
  };
  send(signal);
  if (await groupGone(pgid, graceMs, sleep)) return;
  send('SIGKILL');
  await groupGone(pgid, 5000, sleep);
}

/**
 * Acquire, and guarantee release on process exit, an uncaught error and SIGINT/SIGTERM/SIGHUP.
 * On a signal `onSignal(name)` runs first and is awaited (e.g. `killTree` of the running step, so the slot is not
 * released while the suite is still running); then the slot is released and the process exits 128+signal.
 */
export async function holdSlot({ onSignal, ...opts } = {}) {
  const got = await acquire(opts);
  const signals = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
  let signalled = false;
  const handlers = Object.entries(signals).map(([name, num]) => {
    const handler = async () => {
      if (signalled) return; // a second signal while the tree is being stopped changes nothing
      signalled = true;
      try {
        await onSignal?.(name);
      } finally {
        got.release();
        process.exit(128 + num);
      }
    };
    process.on(name, handler);
    return [name, handler];
  });
  const onExit = () => got.release();
  process.on('exit', onExit); // also runs after an uncaught error
  const release = () => {
    for (const [name, handler] of handlers) process.off(name, handler);
    process.off('exit', onExit);
    got.release();
  };
  return { slot: got.slot, release };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === 'status') {
    const { text, code } = formatStatus();
    console.log(text);
    process.exit(code);
  } else if (cmd === 'wait') {
    try {
      await waitForFree();
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  } else {
    console.error('usage: node scripts/test-slot.mjs status | wait');
    process.exit(2);
  }
}
