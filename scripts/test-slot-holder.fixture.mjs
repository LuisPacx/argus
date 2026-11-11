// Test helper for test-slot.test.ts: a process that takes a slot (dir from ARGUS_TEST_SLOT_DIR) in the given mode.
//   race | term | int | throw | end   take a slot as `check.mjs` would and behave per mode
//   tree | tree-stubborn              like check.mjs: hold a slot, run a step tree (this -> mid -> grandchild), kill it on a signal
//   mid, gc, gc-stubborn              internal: the step and its grandchild (ARGUS_FIXTURE_DIR holds gc.pid and gc.exited)
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { holdSlot, killTree, spawnStep, tryAcquire } from './test-slot.mjs';

const mode = process.argv[2];
const dir = process.env.ARGUS_FIXTURE_DIR;
if (mode === 'race') {
  const got = tryAcquire({ worktree: 'race', command: 'race' });
  console.log(got ? 'won' : 'lost');
  process.stdin.resume(); // hold until the parent closes stdin
  process.stdin.on('end', () => {
    got?.release();
    process.exit(0);
  });
} else if (mode === 'tree' || mode === 'tree-stubborn') {
  let step = null;
  let stopping = false;
  await holdSlot({
    worktree: 'tree',
    command: mode,
    onSignal: (name) => (stopping = true) && killTree(step.child, name, { graceMs: Number(process.env.ARGUS_FIXTURE_GRACE_MS) || 5000 }),
  });
  step = spawnStep(process.execPath, [process.argv[1], 'mid', mode === 'tree-stubborn' ? 'stubborn' : 'polite'], { stdio: 'inherit' });
  writeFileSync(join(dir, 'mid.pid'), String(step.child.pid)); // the step leader (= its process group id), for test cleanup
  console.log('ready');
  await step.closed;
  if (stopping) await new Promise(() => {}); // as check.mjs: the signal handler exits
  process.exit(0);
} else if (mode === 'mid') {
  // Like pnpm: forwards nothing, leaves its grandchild running when it dies.
  const gc = spawn(process.execPath, [process.argv[1], process.argv[3] === 'stubborn' ? 'gc-stubborn' : 'gc'], { stdio: 'ignore' });
  writeFileSync(join(dir, 'gc.pid'), String(gc.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'gc' || mode === 'gc-stubborn') {
  if (mode === 'gc-stubborn') process.on('SIGTERM', () => {}); // ignores SIGTERM: only SIGKILL stops it
  else
    process.on('SIGTERM', () => {
      // slow to stop, so a release that does not wait for it is visible
      setTimeout(() => {
        writeFileSync(join(dir, 'gc.exited'), '1');
        process.exit(0);
      }, 300);
    });
  writeFileSync(join(dir, 'gc.ready'), String(process.pid)); // handler installed: now it is safe to signal the tree
  setInterval(() => {}, 1000);
} else {
  await holdSlot({ worktree: 'holder', command: mode });
  console.log('held');
  if (mode === 'throw') setTimeout(() => { throw new Error('boom'); }, 20);
  else if (mode === 'end') setTimeout(() => process.exit(0), 20);
  else setInterval(() => {}, 1000); // wait for the signal
}
