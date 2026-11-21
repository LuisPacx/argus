// The checks behind `pnpm doctor` (human researcher ticket 16). Pure logic over injected dependencies, so tests use fakes.
// A check is { status: 'PASS' | 'WARN' | 'FAIL', name, detail, fix? }. Details carry paths and booleans only, never a value from the
// environment, a cookie or the Claude login (the login status is read only for its `loggedIn` boolean).
import path from 'node:path';

export const DEFAULT_CHROME_BIN = '/usr/bin/google-chrome';
export const PORT = 3100;

export const defaultChromeDir = (home) => path.join(home, '.local', 'share', 'argus', 'chrome');
export const chromeDirOf = (env, home) => env.ARGUS_CHROME_DIR || defaultChromeDir(home);
export const chromeBinOf = (env) => env.ARGUS_CHROME_BIN || DEFAULT_CHROME_BIN;
export const claudeBinOf = (env) => env.ARGUS_CLAUDE_BIN || 'claude';
// The worker's own default, relative to apps/worker; resolved against the repo root here.
export const dbPathOf = (env, root) => path.resolve(root, 'apps', 'worker', env.ARGUS_DB ?? '../../.data/argus.db');

const result = (status, name, detail, fix) => ({ status, name, detail, ...(fix ? { fix } : {}) });

// deps: { env, home, root, run(bin, args) -> { ok, stdout, notFound }, exists(p), isExecutable(p), cookieState(dir) -> true | false | null,
//         pidAlive(file) -> boolean, answers(url) -> Promise<boolean> }
export function checkClaude(deps) {
  const bin = claudeBinOf(deps.env);
  const r = deps.run(bin, ['auth', 'status', '--json']);
  if (r.notFound) return result('FAIL', 'Claude CLI', `not found (${bin})`, 'install Claude Code, or set ARGUS_CLAUDE_BIN to its path');
  let loggedIn = null;
  try {
    loggedIn = JSON.parse(r.stdout).loggedIn;
  } catch {
    // Not JSON: an old claude without `auth status`, or an error.
  }
  if (loggedIn === true) return result('PASS', 'Claude CLI', `found (${bin}), logged in (checked with auth status, no model call)`);
  if (loggedIn === false) return result('FAIL', 'Claude CLI', `found (${bin}) but not logged in`, 'run: claude auth login');
  return result('WARN', 'Claude CLI', `found (${bin}) but login could not be checked for free`, 'run: claude auth status, and claude auth login if it says logged out');
}

export function checkChromeDir(deps) {
  const dir = chromeDirOf(deps.env, deps.home);
  if (deps.exists(dir)) return result('PASS', 'Argus Chrome profile', `exists (${dir})`);
  return result('FAIL', 'Argus Chrome profile', `missing (${dir})`, `create it by opening Chrome once on it and logging in to X: ${chromeBinOf(deps.env)} --user-data-dir=${dir} https://x.com/login (then close that window)`);
}

export function checkChromeBin(deps) {
  const bin = chromeBinOf(deps.env);
  if (deps.isExecutable(bin)) return result('PASS', 'Chrome binary', `found (${bin})`);
  return result('FAIL', 'Chrome binary', `not found or not executable (${bin})`, 'install Google Chrome, or set ARGUS_CHROME_BIN to its path');
}

export function checkXLogin(deps) {
  const dir = chromeDirOf(deps.env, deps.home);
  if (!deps.exists(dir)) return result('WARN', 'X login', 'cannot tell: the Chrome profile is missing', 'fix the Chrome profile check first');
  const state = deps.cookieState(dir);
  const login = `log in to x.com once: ${chromeBinOf(deps.env)} --user-data-dir=${dir} https://x.com/login (then close that window)`;
  if (state === true) return result('PASS', 'X login', 'an X auth cookie is in the profile (read-only check, Chrome not started)');
  if (state === false) return result('FAIL', 'X login', 'no X auth cookie in the profile', login);
  return result('WARN', 'X login', 'cannot tell (cookie store missing or busy, Chrome not started)', `if X reading fails: ${login}`);
}

export function checkDatabase(deps) {
  const db = dbPathOf(deps.env, deps.root);
  if (deps.exists(db)) return result('PASS', 'Database', `exists (${db})`);
  if (deps.exists(path.dirname(db))) return result('WARN', 'Database', `not created yet (${db}); the worker creates it on first start`, 'run pnpm dev:start');
  return result('FAIL', 'Database', `its folder is missing (${path.dirname(db)})`, 'check ARGUS_DB, or run pnpm install and pnpm dev:start from the repo root');
}

export async function checkRunning(deps) {
  const warroomUp = (await deps.answers(`http://localhost:${PORT}/`)) || deps.pidAlive('warroom-dev.pid');
  const workerUp = deps.pidAlive('worker.pid');
  const hint = 'run pnpm dev:start';
  return [
    warroomUp ? result('PASS', 'War Room', `running on port ${PORT}`) : result('WARN', 'War Room', `not running on port ${PORT}`, hint),
    workerUp ? result('PASS', 'Worker', 'running') : result('WARN', 'Worker', 'not running (research requests wait until it runs)', hint),
  ];
}

export function checkResearchTick(deps) {
  const on = (deps.env.ARGUS_RESEARCH_TICK ?? '').trim() === '1';
  if (on) return result('WARN', 'ARGUS_RESEARCH_TICK', 'on: this starts the old automatic judge and propose loop every 30 minutes, which spends Claude quota', 'remove ARGUS_RESEARCH_TICK from .env; Operator research does not need it');
  return result('PASS', 'ARGUS_RESEARCH_TICK', 'off (Operator research does not need it)');
}

export async function runChecks(deps) {
  return [
    checkClaude(deps),
    checkChromeDir(deps),
    checkChromeBin(deps),
    checkXLogin(deps),
    checkDatabase(deps),
    ...(await checkRunning(deps)),
    checkResearchTick(deps),
  ];
}

export const formatLine = (c) => `${c.status} ${c.name}: ${c.detail}${c.fix ? ` -> ${c.fix}` : ''}`;
export const exitCodeOf = (checks) => (checks.some((c) => c.status === 'FAIL') ? 1 : 0);
