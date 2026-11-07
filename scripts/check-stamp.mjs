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

// HEAD's tree and whether the worktree is clean (nothing modified or untracked) right now.
export function snapshot(cwd) {
  return { clean: git(cwd, 'status', '--porcelain').trim() === '', tree: git(cwd, 'rev-parse', 'HEAD^{tree}').trim() };
}

// Why a passing check must not be stamped, or null if it may. `before` is the snapshot taken BEFORE the check started: only
// a tree that was clean at the start and is the same clean tree at the end is exactly what was tested.
export function unstampableReason(before, after) {
  if (!before.clean) return 'worktree was dirty when the check started';
  if (!after.clean) return 'worktree changed during the check';
  if (before.tree !== after.tree) return 'HEAD changed during the check';
  return null;
}

// Call after a passing check, with the snapshot taken before it started. Returns the tree sha, or null when nothing was written.
export function stampIfClean(cwd, before, now = Date.now()) {
  if (unstampableReason(before, snapshot(cwd))) return null;
  const tree = before.tree;
  const dir = stampDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, tree), '');
  pruneStamps(dir, now);
  return tree;
}
