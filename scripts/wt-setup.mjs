// Installs dependencies in an agent worktree that has none (`pnpm wt:setup`, also a SubagentStart/SessionStart hook).
// No-op unless the directory is inside <repo>/.claude/worktrees/<name> and that worktree has no node_modules,
// so the main checkout is never touched. Offline install only; a failure warns and exits 0 (never blocks the agent).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = `${path.sep}.claude${path.sep}worktrees${path.sep}`;

// The worktree root containing dir, or null when no install is needed.
export function worktreeToInstall(dir, exists = fs.existsSync) {
  const resolved = path.resolve(dir);
  const at = resolved.indexOf(MARKER);
  if (at < 0) return null;
  const name = resolved.slice(at + MARKER.length).split(path.sep)[0];
  if (!name) return null;
  const root = resolved.slice(0, at + MARKER.length) + name;
  if (!exists(path.join(root, 'package.json'))) return null;
  if (exists(path.join(root, 'node_modules'))) return null;
  return root;
}

function defaultInstall(root) {
  const r = spawnSync('pnpm', ['install', '--offline', '--frozen-lockfile'], { cwd: root, stdio: ['ignore', process.stderr, process.stderr] });
  return r.status === 0;
}

export function setup(dir, { exists = fs.existsSync, install = defaultInstall, warn = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const root = worktreeToInstall(dir, exists);
  if (!root) return 'skipped';
  if (install(root)) return 'installed';
  warn(`wt-setup: pnpm install --offline --frozen-lockfile failed in ${root}; run "pnpm install --frozen-lockfile" (online) there`);
  return 'failed';
}

function hookCwd() {
  if (process.stdin.isTTY) return process.cwd();
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
