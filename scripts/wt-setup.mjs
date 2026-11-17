// Installs dependencies in an agent worktree that has none (`pnpm wt:setup`, also a SubagentStart/SessionStart hook).
// No-op unless the directory is inside <repo>/.claude/worktrees/<name> and that worktree has no node_modules,
// so the main checkout is never touched. Offline install only; a failure warns and exits 0 (never blocks the agent).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MARKER = `${path.sep}.claude${path.sep}worktrees${path.sep}`;

// This repo's main checkout, from the script's own location (the script may itself live in one of its worktrees).
function ownRepoRoot() {
  const real = fs.realpathSync(path.resolve(fileURLToPath(import.meta.url), '..', '..'));
  const at = real.indexOf(MARKER);
  return at < 0 ? real : real.slice(0, at);
}

// The worktree root containing dir, or null when no install is needed. Only real directories directly under
// <repoRoot>/.claude/worktrees count: symlinks, `..` escapes and other repos' worktrees are never installed into.
export function worktreeToInstall(dir, repoRoot = ownRepoRoot()) {
  let base;
  let real;
  try {
    base = path.join(fs.realpathSync(repoRoot), '.claude', 'worktrees');
    real = fs.realpathSync(path.resolve(dir));
  } catch {
    return null;
  }
  if (!real.startsWith(base + path.sep)) return null;
  const name = real.slice(base.length + 1).split(path.sep)[0];
  const root = path.join(base, name);
  try {
    if (fs.lstatSync(root).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  if (!fs.existsSync(path.join(root, 'package.json'))) return null;
  if (fs.existsSync(path.join(root, 'node_modules'))) return null;
  return root;
}

function defaultInstall(root) {
  const r = spawnSync('pnpm', ['install', '--offline', '--frozen-lockfile'], { cwd: root, stdio: ['ignore', process.stderr, process.stderr] });
  return r.status === 0;
}

export function setup(dir, { repoRoot = ownRepoRoot(), install = defaultInstall, warn = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const root = worktreeToInstall(dir, repoRoot);
  if (!root) return 'skipped';
  if (install(root)) return 'installed';
  warn(`wt-setup: pnpm install --offline --frozen-lockfile failed in ${root}; run "pnpm install --frozen-lockfile" (online) there`);
  return 'failed';
}

function hookCwd() {
  if (!process.argv.includes('--hook') || process.stdin.isTTY) return process.cwd();
  try {
    const cwd = JSON.parse(fs.readFileSync(0, 'utf8')).cwd;
    return typeof cwd === 'string' && cwd ? cwd : process.cwd();
  } catch {
    return process.cwd();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setup(hookCwd());
  process.exit(0);
}
