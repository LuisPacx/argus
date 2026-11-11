// `pnpm check`: typecheck, lint, test, in order, stopping at the first failure with its exit code.
// On success it stamps HEAD's tree (see check-stamp.mjs) so the pre-push hook can skip a re-run, but only if the worktree was
// clean and HEAD's tree unchanged for the whole run (snapshot taken before the first step).
import { checkEnv } from '../vitest.tiers.mjs';
import { snapshot, stampIfClean, unstampableReason } from './check-stamp.mjs';
import { holdSlot, killTree, spawnStep } from './test-slot.mjs';

// `pnpm check:fast` (--fast) runs the fast test tier instead and never stamps: a stamp must mean the full suite passed.
const fast = process.argv.includes('--fast');
// The full run takes one of two machine-wide test slots (test-slot.mjs) for all three steps and waits, loudly, when both
// are taken. check:fast does not: it is the short iteration tier. The slot is released on exit, errors and signals, and a
// killed check is reclaimed by the stale-holder check, so it can never be held forever.
// Steps run as their own process group (spawnStep). pnpm does not forward signals, so on SIGINT/SIGTERM/SIGHUP (a
// detached group no longer gets the terminal's Ctrl-C itself) the whole group is signalled and awaited before the slot
// is released, so a stopped check keeps its slot until the step tree is gone. Bounds: a process that left the group
// (setsid/setpgid) is not signalled or awaited, and a group that survives SIGKILL for 5 s no longer holds the slot.
let child = null;
let slot = null;
let stopping = false; // a signal arrived: the signal handler owns the exit (after the tree is gone and the slot released)
if (!fast) {
  try {
    slot = await holdSlot({
      worktree: process.cwd(),
      command: 'pnpm check',
      onSignal: (name) => {
        stopping = true;
        return child && killTree(child, name);
      },
    });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
// Snapshot after the wait: the tree may have changed while queued, and the stamp must describe what the steps ran on.
let before = null;
try {
  before = snapshot(process.cwd());
} catch {
  // not a git worktree: run the check, stamp nothing
}
// check:fast also runs its steps as a group, so Ctrl-C and kill stop it the same way (it just holds no slot).
if (fast) {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, async () => {
      stopping = true;
      if (child) await killTree(child, sig);
      process.exit(128 + { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[sig]);
    });
  }
}
for (const step of ['typecheck', 'lint', fast ? 'test:fast' : 'test']) {
  const s = spawnStep('pnpm', [step], { stdio: 'inherit', env: checkEnv(fast) });
  child = s.child;
  const status = await s.closed;
  if (stopping) await new Promise(() => {}); // never returns: the signal handler exits
  if (status !== 0) process.exit(status); // 'exit' handler releases the slot
}
slot?.release();
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
