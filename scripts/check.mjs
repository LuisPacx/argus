// `pnpm check`: typecheck, lint, test, in order, stopping at the first failure with its exit code.
// On success it stamps HEAD's tree (see check-stamp.mjs) so the pre-push hook can skip a re-run, but only if the worktree was
// clean and HEAD's tree unchanged for the whole run (snapshot taken before the first step).
import { spawnSync } from 'node:child_process';
import { checkEnv } from '../vitest.tiers.mjs';
import { snapshot, stampIfClean, unstampableReason } from './check-stamp.mjs';

// `pnpm check:fast` (--fast) runs the fast test tier instead and never stamps: a stamp must mean the full suite passed.
const fast = process.argv.includes('--fast');
let before = null;
try {
  before = snapshot(process.cwd());
} catch {
  // not a git worktree: run the check, stamp nothing
}
for (const step of ['typecheck', 'lint', fast ? 'test:fast' : 'test']) {
  const r = spawnSync('pnpm', [step], { stdio: 'inherit', env: checkEnv(fast) });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (fast) {
  console.log('check:fast: passed (fast tier only, not stamped; run pnpm check before committing)');
  process.exit(0);
}
try {
  const tree = before && stampIfClean(process.cwd(), before);
  if (tree) console.log(`check: passed, stamped tree ${tree.slice(0, 10)}`);
  else console.log(`check: passed, not stamped (${before ? unstampableReason(before, snapshot(process.cwd())) : 'no git snapshot'})`);
} catch (err) {
  console.warn(`check: passed, but stamping failed: ${err.message}`); // never fail a passing check over the stamp
}
