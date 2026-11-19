// Restart loop for the long-lived dev processes (War Room, worker), started by scripts/dev-server.mjs.
// Ticket: .scratch/hardening/issues/13-war-room-restarts-after-exit.md
//
// The supervisor is the process group leader (its pid is the pid file), and the child runs in the same group, so
// `dev:stop` still signals one group. dev:stop writes `<run-dir>/<name>.stop` before the SIGTERM; a SIGTERM without
// that marker (something else signalled the group) is logged and ignored, and the child's exit is then restarted.
// Every exit of the child is one line in `<run-dir>/<name>-exits.log`; the counters live in `<run-dir>/<name>-supervisor.json`.
//
// CLI: node scripts/supervise.mjs --name N --run-dir D [--backoff-ms 1000 --max-backoff-ms 30000 --healthy-ms 60000
//        --window-ms 300000 --max-restarts 5] -- command args...
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULTS = { backoffMs: 1_000, maxBackoffMs: 30_000, healthyMs: 60_000, windowMs: 300_000, maxRestarts: 5 };

export const stopFile = (runDir, name) => path.join(runDir, `${name}.stop`);
export const exitsLogFile = (runDir, name) => path.join(runDir, `${name}-exits.log`);
export const stateFile = (runDir, name) => path.join(runDir, `${name}-supervisor.json`);

export function readState(runDir, name) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(runDir, name), 'utf8'));
  } catch {
    return null;
  }
}

// Delay before restart number `consecutive` (0-based) of a run of short-lived children: backoff, 2x backoff, 4x ... up to the cap.
export function backoffDelay(consecutive, backoffMs, maxBackoffMs) {
  return Math.min(maxBackoffMs, backoffMs * 2 ** consecutive);
}

export async function supervise({ name, runDir, command, args = [], cwd, env, ...opts }) {
  const o = { ...DEFAULTS, ...opts };
  const stop = stopFile(runDir, name);
  const exitsLog = exitsLogFile(runDir, name);
  const state = { name, supervisorPid: process.pid, status: 'starting', childPid: null, restarts: 0, startedAt: new Date().toISOString(), lastExit: null };
  let stopping = false;
  let child = null;
  let wake = null;

  const save = () => fs.writeFileSync(stateFile(runDir, name), `${JSON.stringify(state)}\n`);
  const logLine = (text) => fs.appendFileSync(exitsLog, `${new Date().toISOString()} ${name} ${text}\n`);

  const onSignal = (sig) => {
    if (!fs.existsSync(stop)) {
      logLine(`supervisor got ${sig} without a stop marker: ignored, the child restarts if it exits`);
      return;
    }
    stopping = true;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    wake?.();
  };
  const handlers = { SIGTERM: () => onSignal('SIGTERM'), SIGINT: () => onSignal('SIGINT') };
  for (const [sig, fn] of Object.entries(handlers)) process.on(sig, fn);

  fs.mkdirSync(runDir, { recursive: true });
  const recent = []; // restart times inside the window
  let consecutive = 0; // short-lived children in a row
  let code = 0;
  try {
    while (true) {
      const startedMs = Date.now();
      child = spawn(command, args, { cwd, env, stdio: 'inherit' });
      state.status = 'running';
      state.childPid = child.pid ?? null;
      save();
      const result = await new Promise((resolve) => {
        child.once('error', (err) => resolve({ code: null, signal: `spawn-error:${err.code ?? err.message}` }));
        child.once('exit', (c, s) => resolve({ code: c, signal: s }));
      });
      const uptimeMs = Date.now() - startedMs;
      const how = result.signal ? `signal=${result.signal}` : `code=${result.code}`;
      const base = `exit ${how} uptime=${(uptimeMs / 1000).toFixed(1)}s`;
      state.lastExit = { at: new Date().toISOString(), how, uptimeMs };
      state.childPid = null;

      if (stopping) {
        logLine(`${base} action=stopped (dev:stop)`);
        break;
      }
      const now = Date.now();
      while (recent.length && now - recent[0] >= o.windowMs) recent.shift();
      if (recent.length >= o.maxRestarts) {
        state.status = 'gave-up';
        save();
        logLine(`${base} action=giving up: ${o.maxRestarts} restarts within ${o.windowMs / 1000}s`);
        code = 1;
        return code;
      }
      consecutive = uptimeMs >= o.healthyMs ? 0 : consecutive + 1;
      const delay = backoffDelay(consecutive - 1, o.backoffMs, o.maxBackoffMs);
      recent.push(now);
      state.restarts += 1;
      state.status = 'backoff';
      save();
      logLine(`${base} action=restart #${state.restarts} in ${delay}ms`);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delay);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
      if (stopping) {
        logLine('action=stopped (dev:stop) during backoff');
        break;
      }
    }
    fs.rmSync(stateFile(runDir, name), { force: true });
    return code;
  } finally {
    for (const [sig, fn] of Object.entries(handlers)) process.off(sig, fn);
    if (stopping) fs.rmSync(stop, { force: true });
  }
}

function parseCli(argv) {
  const split = argv.indexOf('--');
  const flags = argv.slice(0, split < 0 ? argv.length : split);
  const [command, ...args] = split < 0 ? [] : argv.slice(split + 1);
  const get = (flag) => {
    const i = flags.indexOf(flag);
    return i < 0 ? undefined : flags[i + 1];
  };
  const num = (flag, key) => (get(flag) === undefined ? {} : { [key]: Number(get(flag)) });
  return {
    name: get('--name'),
    runDir: get('--run-dir'),
    command,
    args,
    ...num('--backoff-ms', 'backoffMs'),
    ...num('--max-backoff-ms', 'maxBackoffMs'),
    ...num('--healthy-ms', 'healthyMs'),
    ...num('--window-ms', 'windowMs'),
    ...num('--max-restarts', 'maxRestarts'),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = parseCli(process.argv.slice(2));
  if (!cfg.name || !cfg.runDir || !cfg.command) {
    console.error('usage: node scripts/supervise.mjs --name N --run-dir D [--backoff-ms ..] -- command args...');
    process.exit(2);
  }
  process.exitCode = await supervise({ ...cfg, cwd: process.cwd(), env: process.env });
}
