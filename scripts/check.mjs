// `pnpm check`: typecheck, lint, test, in order, stopping at the first failure with its exit code.
// On success in a clean worktree it stamps HEAD's tree (see check-stamp.mjs) so the pre-push hook can skip a re-run.
import { spawnSync } from 'node:child_process';
import { stampIfClean } from './check-stamp.mjs';

for (const step of ['typecheck', 'lint', 'test']) {
  const r = spawnSync('pnpm', [step], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
try {
  const tree = stampIfClean(process.cwd());
  console.log(tree ? `check: passed, stamped tree ${tree.slice(0, 10)}` : 'check: passed, worktree dirty so not stamped');
} catch (err) {
  console.warn(`check: passed, but stamping failed: ${err.message}`); // never fail a passing check over the stamp
}
