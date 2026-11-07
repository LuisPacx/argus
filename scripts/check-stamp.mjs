// Check stamps: proof that `pnpm check` passed on a given git TREE. One empty file per tree sha in
// `$(git rev-parse --git-common-dir)/argus-check/`, shared by every worktree and never inside a working tree.
// The pre-push hook (prepush-decision.mjs) reads them to avoid re-running the ~11 min check on code that already passed.
// Threat model: accidents (a forgotten re-check, a stale worktree), not forgery. Anyone who can touch .git can fake a stamp.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export function stampDir(cwd) {
  return path.resolve(cwd, git(cwd, 'rev-parse', '--git-common-dir').trim(), 'argus-check');
}

export function hasStamp(cwd, tree) {
  if (!/^[0-9a-f]{40,64}$/.test(tree)) return false;
  return fs.existsSync(path.join(stampDir(cwd), tree));
}

// Removes stamps older than 30 days.
export function pruneStamps(dir, now = Date.now()) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (now - fs.statSync(file).mtimeMs > MAX_AGE_MS) fs.rmSync(file, { force: true });
  }
}

// Call after a passing check. Stamps HEAD's tree only when the worktree is clean (nothing modified or untracked), because
// only then is HEAD's tree exactly what was tested. Returns the tree sha, or null when nothing was written (dirty tree).
export function stampIfClean(cwd, now = Date.now()) {
  if (git(cwd, 'status', '--porcelain').trim() !== '') return null;
  const tree = git(cwd, 'rev-parse', 'HEAD^{tree}').trim();
  const dir = stampDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, tree), '');
  pruneStamps(dir, now);
  return tree;
}
