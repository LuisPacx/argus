// Test helper for test-slot.test.ts: a process that takes a slot (dir from ARGUS_TEST_SLOT_DIR) in the given mode.
import { holdSlot, tryAcquire } from './test-slot.mjs';

const mode = process.argv[2];
if (mode === 'race') {
  const got = tryAcquire({ worktree: 'race', command: 'race' });
  console.log(got ? 'won' : 'lost');
  process.stdin.resume(); // hold until the parent closes stdin
  process.stdin.on('end', () => {
    got?.release();
    process.exit(0);
  });
} else {
  await holdSlot({ worktree: 'holder', command: mode });
  console.log('held');
  if (mode === 'throw') setTimeout(() => { throw new Error('boom'); }, 20);
  else if (mode === 'end') setTimeout(() => process.exit(0), 20);
  else setInterval(() => {}, 1000); // wait for the signal
}
