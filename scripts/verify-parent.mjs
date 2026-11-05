#!/usr/bin/env node
// Proves a commit's new or changed tests fail on its parent. Verifiers run `pnpm verify:parent <commit> [<test file>...]`.
// With no files, uses the *.test.ts files the commit added or changed. Builds a throwaway worktree of <commit>^ under
// .claude/worktrees/, installs deps, overlays the commit's test files (via `git show`), runs vitest, prints a summary and
// removes the worktree. Failures on the parent are the EXPECTED, good result.
// Exit: 0 every file has a failing test on the parent, 1 some file has none, 2 setup error.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_NAME = 'verify-parent-report.json';

// Pure: `git diff --name-status --no-renames` output -> test files added (A) or modified (M).
export function selectTestFiles(nameStatus) {
  return selectTestChanges(nameStatus).map((c) => c.file);
}

// Pure: same selection, keeping the status so callers can tell added files from modified ones.
export function selectTestChanges(nameStatus) {
  const changes = [];
  for (const line of nameStatus.split('\n')) {
    const [status, file] = line.split('\t');
    if ((status === 'A' || status === 'M') && file && file.endsWith('.test.ts')) changes.push({ status, file });
  }
  return changes;
}

// Pure: no-argument mode. Added files must have a failing test on the parent (strict). Modified files are reported as INFO
// only: telling which of their tests are new or changed is not reliable, and their old tests legitimately pass on the parent.
export function splitByStatus(changes) {
  return { strict: changes.filter((c) => c.status === 'A').map((c) => c.file), info: changes.filter((c) => c.status === 'M').map((c) => c.file) };
}

// Pure: the names of the tests (it/test, any modifier) declared in a test file's source.
export function testNames(source) {
  const names = new Set();
  for (const m of (source ?? '').matchAll(/\b(?:it|test)(?:\.\w+)*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)) names.add(m[2]);
  return names;
}

// Pure: vitest JSON report + the repo-relative files we ran -> per-file results, summary text and exit code.
// `parentNames` maps file -> names of the tests already in that file on the parent: those are unchanged by the commit, so
// passing on the parent is expected, not suspicious. Only tests the commit added or renamed are judged.
export function summarize(report, files, root = '', infoFiles = [], parentNames = {}) {
  const byFile = new Map();
  for (const r of report?.testResults ?? []) byFile.set(path.relative(root, r.name), r);
  const lines = [];
  let allFail = true;
  for (const file of [...files, ...infoFiles]) {
    const info = infoFiles.includes(file);
    const r = byFile.get(file);
    const tests = r?.assertionResults ?? [];
    const failed = tests.filter((t) => t.status === 'failed');
    const passed = tests.filter((t) => t.status === 'passed');
    const loadFailure = r?.status === 'failed' && tests.length === 0;
    const ok = failed.length > 0 || loadFailure;
    if (!ok && !info) allFail = false;
    const state = !r ? 'NOT RUN' : loadFailure ? 'file failed to load' : `${failed.length} failed, ${passed.length} passed`;
    const label = info ? 'INFO (modified file, not gating)' : ok ? 'FAILS ON PARENT (good)' : 'NO FAILURE ON PARENT (bad)';
    lines.push(`${label}  ${file}: ${state}`);
    if (!info) {
      for (const t of passed) {
        const unchanged = parentNames[file]?.has(t.title ?? t.fullName);
        lines.push(`    passes on parent (${unchanged ? 'unchanged, expected to pass' : 'suspicious'}): ${t.fullName ?? t.title}`);
      }
    }
  }
  lines.push(
    allFail
      ? 'OK: every file has at least one test that fails on the parent. Parent failures are the EXPECTED, good result.'
      : 'NOT PROVEN: some file has no failing test on the parent. Parent failures are the EXPECTED, good result; passing tests the commit added are suspicious.',
  );
  return { lines, exitCode: allFail ? 0 : 1 };
}

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The child runs in its own process group so cleanup can signal pnpm and every vitest worker below it at once.
let active = null; // { pid, exited: Promise }
function run(cmd, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: 'inherit', detached: true });
    const exited = new Promise((done) => child.on('close', done));
    active = { pid: child.pid, exited };
    child.on('error', reject);
    exited.then((code) => {
      active = null;
      resolve(code);
    });
  });
}

// SIGTERM the whole group, wait for the child to exit (SIGKILL the group after 10 s).
async function stopActive() {
  if (!active) return;
  const { pid, exited } = active;
  const signalGroup = (sig) => {
    try {
      process.kill(-pid, sig);
    } catch {}
  };
  signalGroup('SIGTERM');
  const timedOut = await Promise.race([exited.then(() => false), sleep(10_000).then(() => true)]);
  if (timedOut) {
    signalGroup('SIGKILL');
    await Promise.race([exited, sleep(5_000)]);
  }
}

async function main() {
  const [commitArg, ...fileArgs] = process.argv.slice(2);
  if (!commitArg) {
    console.error('usage: node scripts/verify-parent.mjs <commit> [<test file>...]');
    return 2;
  }
  let wt = null;
  let created = false;
  let cleaning = null;
  const cleanup = () => (cleaning ??= doCleanup());
  const doCleanup = async () => {
    await stopActive();
    if (created) {
      let r;
      for (let attempt = 0; attempt < 5; attempt++) {
        r = spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: ROOT, encoding: 'utf8' });
        if (r.status === 0) break;
        await sleep(1000);
      }
      if (r.status !== 0) console.error(`WARNING: could not remove worktree ${wt}: ${r.stderr.trim()}`);
      created = false;
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      cleanup().finally(() => process.exit(2));
    });
  }
  try {
    const commit = git(['rev-parse', '--verify', `${commitArg}^{commit}`]).trim();
    const short = commit.slice(0, 7);
    const parent = git(['rev-parse', '--verify', `${commit}^`]).trim();
    // Explicit files are all strict. With no files, added files are strict and modified files are INFO only.
    const { strict: files, info: infoFiles } =
      fileArgs.length > 0 ? { strict: fileArgs, info: [] } : splitByStatus(selectTestChanges(git(['diff', '--name-status', '--no-renames', parent, commit])));
    if (files.length + infoFiles.length === 0) {
      console.error(`no test files (*.test.ts) added or changed in ${short}`);
      return 2;
    }
    wt = path.join(ROOT, '.claude', 'worktrees', `verify-parent-${short}`);
    if (fs.existsSync(wt)) {
      console.error(`refusing: ${wt} already exists`);
      wt = null;
      return 2;
    }
    console.log(`verify-parent: ${short} vs parent ${parent.slice(0, 7)}; files: ${[...files, ...infoFiles].join(', ')}`);
    git(['worktree', 'add', '--detach', wt, parent]);
    created = true;
    const installCode = await run('pnpm', ['install', '--frozen-lockfile'], wt, { ...process.env, CI: 'true' });
    if (installCode !== 0) {
      console.error(`pnpm install failed (exit ${installCode})`);
      return 2;
    }
    for (const f of [...files, ...infoFiles]) {
      const content = git(['show', `${commit}:${f}`], { maxBuffer: 64 * 1024 * 1024 });
      fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
      fs.writeFileSync(path.join(wt, f), content);
    }
    const reportPath = path.join(wt, REPORT_NAME);
    await run('pnpm', ['exec', 'vitest', 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`, ...files, ...infoFiles], wt);
    if (!fs.existsSync(reportPath)) {
      console.error('vitest produced no JSON report');
      return 2;
    }
    // Tests already declared in each file on the parent are unchanged by the commit (a file new in the commit has none).
    const parentNames = {};
    for (const f of files) {
      const r = spawnSync('git', ['show', `${parent}:${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      parentNames[f] = testNames(r.status === 0 ? r.stdout : '');
    }
    const { lines, exitCode } = summarize(JSON.parse(fs.readFileSync(reportPath, 'utf8')), files, wt, infoFiles, parentNames);
    console.log('\n=== verify-parent summary ===');
    for (const l of lines) console.log(l);
    return exitCode;
  } catch (err) {
    console.error(`setup error: ${err.message}`);
    return 2;
  } finally {
    await cleanup();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
