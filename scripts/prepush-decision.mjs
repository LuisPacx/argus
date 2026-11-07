// Decides whether the pre-push hook may skip `pnpm check`: only when EVERY file changed by EVERY pushed ref is a note.
// Exit 0 = skip the check; anything else (exit 1, a crash, any doubt) = run it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

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

// git = { mergeBase(sha) -> sha | null, changedFiles(from, to) -> string[] }. Either may throw; any throw means "run the check".
// Returns { skip, files } where files is the union of changed files over all pushed refs.
export function decidePush(stdin, git) {
  try {
    const refs = parseRefLines(stdin);
    if (refs.length === 0) return { skip: false, files: [] };
    const files = new Set();
    for (const { localSha, remoteSha } of refs) {
      if (ZERO.test(localSha)) continue; // deleting a ref: nothing to check
      const base = ZERO.test(remoteSha) ? git.mergeBase(localSha) : remoteSha;
      if (!base) return { skip: false, files: [] }; // new ref with no origin/main to compare against
      for (const file of git.changedFiles(base, localSha)) files.add(file);
    }
    const list = [...files];
    // A live ref that changes no files is odd (empty commits, a stale origin/main): don't guess, run the check.
    if (list.length === 0 && refs.some((r) => !ZERO.test(r.localSha))) return { skip: false, files: list };
    return { skip: list.every(isDocsPath), files: list };
  } catch {
    return { skip: false, files: [] };
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
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { skip, files } = decidePush(fs.readFileSync(0, 'utf8'), realGit());
  if (skip) {
    console.log(`pre-push: docs-only push (${files.length} files), skipping pnpm check`);
    process.exit(0);
  }
  process.exit(1);
}
