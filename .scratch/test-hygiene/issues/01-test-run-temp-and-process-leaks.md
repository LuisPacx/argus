# 01: Test runs leak temp roots and fake-claude processes

**Model:** sonnet / medium

**Status:** done

**What to build:** `/var/tmp` held 30 `argus-test-run-*` dirs (~121 MB) from runs since 11-05, and a `fake-claude.mjs -p /implement-spec` process stayed alive (ppid = init, ignoring SIGTERM) 20 minutes after a `pnpm check`. Root causes found in `packages/core/src/testing/no-leaked-fakes.ts` (vitest globalSetup, which creates the `argus-test-run-*` root and removes it in teardown):

1. Teardown removal throws EACCES when a test left a `chmod 000` directory (`locked`), so the root stays.
2. A run that is killed (timeout, SIGKILL, closed terminal) never runs teardown: the root, the registry dir and any live fake stay. A `hang-stubborn` fake (ignores SIGTERM) then lives forever.

**Acceptance criteria:**

- [x] Teardown makes every directory under the run's root writable before removing it, so locked dirs no longer block removal.
- [x] A fake claude in a hang mode (and its straggler grandchild) exits by itself when its parent dies or after a hard cap, even if it ignores SIGTERM.
- [x] The guard records its own start time and temp root in its registry dir; the next run's setup and `pnpm check` (after the test step, and on a signal) reap registry dirs whose guard is dead: SIGKILL the recorded live fakes (pid plus start time verified) and remove the recorded `argus-test-run-*` root. Runs whose guard is alive are never touched.
- [x] `pnpm check` fails when that reaping finds a leftover from a run that started during this check.
- [x] Tests cover the locked-dir removal and the dead-guard reaping (and that a live guard is left alone).
- [x] `pnpm check` passes.
