// Decides whether the pre-push hook may skip `pnpm check`: only when EVERY file changed by EVERY pushed ref is a note.
// Exit 0 = skip the check; anything else (exit 1, a crash, any doubt) = run it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { hasStamp } from './check-stamp.mjs';

const ZERO = /^0+$/;

// A note is anything under .scratch/ or any *.md file, EXCEPT under .claude/: tests and the Brain read
// .claude/skills/*/SKILL.md at runtime (judge.test, propose.test, the judge/propose passes, ApiBrain), so a SKILL.md edit
// can break the suite and is never skippable.
export function isDocsPath(file) {
  if (file.startsWith('.claude/')) return false;
  return file.startsWith('.scratch/') || file.endsWith('.md');
}

// Parses git's pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>` per line. Throws on a malformed line.
export function parseRefLines(stdin) {
  return stdin
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length !== 4) throw new Error(`unparseable ref line: ${line}`);
      const [localRef, localSha, remoteRef, remoteSha] = parts;
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

const short = (sha) => sha.slice(0, 10);

// git = { mergeBase(sha) -> sha | null, changedFiles(from, to) -> string[],
//         rangeCommits(from, to) -> commit shas in from..to, tip first, treeOf(commit) -> tree sha,
//         hasStamp(tree) -> boolean (a passing `pnpm check` was recorded for that tree; see check-stamp.mjs) }.
// Any of them may throw; any throw means "run the check".
// A ref may skip the check when some base differs from its tip only by notes. Bases are the remote sha (already on origin)
// and every pushed commit whose tree is stamped (tested clean). A stamped tip has an empty diff to itself, so it skips.
// Returns { skip, files, reasons } where files is the union of the changed files of the diffs that justified skipping.
export function decidePush(stdin, git) {
  try {
    const refs = parseRefLines(stdin);
    if (refs.length === 0) return { skip: false, files: [], reasons: [] };
    const files = new Set();
    const reasons = [];
    for (const { localSha, remoteSha } of refs) {
      if (ZERO.test(localSha)) continue; // deleting a ref: nothing to check
      const base = ZERO.test(remoteSha) ? git.mergeBase(localSha) : remoteSha;
      if (!base) return { skip: false, files: [], reasons: [] }; // new ref with no origin/main to compare against
      const fromBase = git.changedFiles(base, localSha);
      // An empty diff from the remote is odd (empty commits, a stale origin/main): don't guess. Stamped bases below may be empty.
      if (fromBase.length > 0 && fromBase.every(isDocsPath)) {
        for (const file of fromBase) files.add(file);
        reasons.push(`docs-only since ${short(base)}`);
        continue;
      }
      const stamped = git.rangeCommits(base, localSha).find((c) => {
        if (!git.hasStamp(git.treeOf(c))) return false;
        const diff = git.changedFiles(c, localSha);
        if (!diff.every(isDocsPath)) return false;
        for (const file of diff) files.add(file);
        reasons.push(c === localSha ? `tree ${short(git.treeOf(c))} already checked` : `docs-only since ${short(c)} (checked)`);
        return true;
      });
      if (!stamped) return { skip: false, files: [...files], reasons: [] };
    }
    return { skip: true, files: [...files], reasons };
  } catch {
    return { skip: false, files: [], reasons: [] };
  }
}

function realGit() {
  const run = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    mergeBase(sha) {
      try {
        run('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main');
      } catch {
        return null;
      }
      return run('merge-base', 'origin/main', sha).trim() || null;
    },
    // --no-renames lists both sides of a rename; -z is safe for odd file names.
    changedFiles: (from, to) => run('diff', '--name-only', '--no-renames', '-z', `${from}..${to}`).split('\0').filter(Boolean),
    rangeCommits: (from, to) => run('rev-list', `${from}..${to}`).split('\n').filter(Boolean),
    treeOf: (commit) => run('rev-parse', `${commit}^{tree}`).trim(),
    hasStamp: (tree) => hasStamp(process.cwd(), tree),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { skip, reasons } = decidePush(fs.readFileSync(0, 'utf8'), realGit());
  if (skip) {
    console.log(`pre-push: ${[...new Set(reasons)].join('; ') || 'nothing to check'}, skipping pnpm check`);
    process.exit(0);
  }
  process.exit(1);
}
