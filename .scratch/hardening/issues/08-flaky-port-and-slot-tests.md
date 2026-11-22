# 08: Fix two flaky tests (fixed seed port, test-slot timeout)
**Model:** sonnet / low — two small test-only fixes.

**Approved:** the user approved this work on 2026-11-16 (it keeps costing 10-minute `pnpm check` reruns).

**What to build:**

1. `scripts/page-check-browser.test.ts`, the "--seed starts a private War Room..." test, passed the fixed port 3291, so it failed whenever two checks ran at once in different worktrees. It now asks the OS for a free port (listen on 0, read the port, close) and passes that. No other test in `scripts/`, `apps/` or `packages/` uses a fixed listening port: every other server there already does `listen(0, ...)`; the remaining port literals are parser/URL fixtures (`--port 3300`, `localhost:3000`) that never bind. The live port 3100 stays refused (`scripts/page-seed.test.ts`, unchanged; OS-assigned ports are in the ephemeral range, never 3100).
2. `scripts/test-slot.test.ts` timed out on the first run and passed on the rerun. Root cause: "racing reclaimers of one stale slot cannot both win" called `deadPid()` (a synchronous `spawnSync` of a node process) once per round, 20 rounds, about 1.8 s idle in a 5 s default test timeout; under a parallel check, node start-up slows several-fold and the test overran. It was not slot contention (the tests use private temp slot dirs) and not a timer. Fix: spawn the dead pid once per test, not per round (the planted `startTime: "1"` already makes the slot stale whatever the pid), which takes the test to about 10 ms and the file from about 5.2 s to about 3 s. No timeout was raised.

Status: done

## Acceptance criteria

- [x] The seed test in `scripts/page-check-browser.test.ts` picks a free port per run and checks the cleanup line for that port; no hard-coded listening port remains in the tests
- [x] The live port 3100 is still refused by `--seed` (existing `scripts/page-seed.test.ts` cases pass)
- [x] The racing-reclaimers test in `scripts/test-slot.test.ts` no longer spawns a process per round, and no timeout was raised
- [x] 10 runs of each of the two test files (one loop, `--maxWorkers=2`) all pass
- [x] `pnpm check` passes and stamps the committed tree

## Comments

- 2026-11-16: approved by the user; implemented by a worker, boxes left for cos.
- 2026-11-16: boxes ticked on review (MERGE) + verifier (check 2459, slot test 5/5 at --maxWorkers=2).
