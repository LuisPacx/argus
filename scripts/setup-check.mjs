#!/usr/bin/env node
// `pnpm setup-check`: a preflight for the Operator's setup (human researcher ticket 16). One PASS/WARN/FAIL line per check with a fix hint;
// exits 1 on any FAIL. It starts no browser, makes no model call and never prints a value (paths and booleans only).
// Usage: node scripts/setup-check.mjs [--root <repo dir>]   (--root reads that checkout's .env and .data, e.g. the main one from a worktree)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDotenvArgus } from './dev-env.mjs';
import { cookieState } from './setup-check-cookies.mjs';
import { exitCodeOf, formatLine, mainCheckoutRoot, runChecks } from './setup-check-checks.mjs';

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf('--root');
const ROOT = rootFlag >= 0 ? path.resolve(argv[rootFlag + 1]) : mainCheckoutRoot(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const RUN_DIR = path.join(ROOT, '.data', 'run');

// Same env the worker gets from `pnpm dev:start`: ARGUS_* from the repo-root .env, the shell wins.
const env = withDotenvArgus(process.env, path.join(ROOT, '.env')).env;

function run(bin, args) {
  try {
    return { ok: true, stdout: execFileSync(bin, args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'], env }) };
  } catch (err) {
    return { ok: false, stdout: '', notFound: err.code === 'ENOENT' };
  }
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function pidAlive(name) {
  try {
    const pid = Number.parseInt(fs.readFileSync(path.join(RUN_DIR, name), 'utf8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function answers(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

const checks = await runChecks({ env, home: os.homedir(), root: ROOT, run, exists: fs.existsSync, isExecutable, cookieState, pidAlive, answers });
for (const c of checks) console.log(formatLine(c));
const fails = checks.filter((c) => c.status === 'FAIL').length;
const warns = checks.filter((c) => c.status === 'WARN').length;
console.log(`setup-check:${checks.length - fails - warns} pass, ${warns} warn, ${fails} fail`);
process.exitCode = exitCodeOf(checks);
