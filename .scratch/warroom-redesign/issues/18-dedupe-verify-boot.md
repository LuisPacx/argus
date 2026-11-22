# 18: one shared Nuxt dev-server boot/stop for verify-boot and page:check --seed
**Model:** sonnet / effort: medium. A behaviour-preserving refactor of two scripts into one small module; no schema, ADR or dependency change.

Status: done

**Blocked by:** none. (Follow-up of `14-page-check-seed-option.md` and `17-page-seed-refusals-and-unique-dir.md`, review note of 2026-11-17: "same pattern as verify-boot step 4; verify-boot is left as it is".)

## Problem

Two scripts carry the same code to run the War Room's `nuxt dev --strictPort` as its own process group:

| What | `scripts/verify-boot.mjs` (before) | `scripts/page-check-server.mjs` (before) |
| --- | --- | --- |
| process-group probe `groupAlive` (signal 0, EPERM = alive) | 84-91 | 76-83 |
| GET that never throws | `get` 197-204 | `get` 67-74 (status only) |
| spawn `pnpm --dir ROOT --filter @argus/warroom exec nuxt dev --port N --strictPort`, detached, log fd | 217-228 | 151-161 |
| ready wait (503 = still loading, poll 500 ms) and "bound our port" log check | 230-247 | 163-171 |
| SIGTERM, grace wait, SIGKILL on the group | 262-277 | 113-127 |

Differences that matter and stay explicit (parameters, not merged away):
- env (page-check adds `ARGUS_NUXT_BUILD_DIR` and `TMPDIR`), port and log file: passed in.
- grace before SIGKILL: verify-boot 6 s, page-check 6 s (same number, passed in as a parameter); verify-boot treats "needed SIGKILL" as a FAIL (the helper returns that boolean), page-check ignores it and waits for the port to be free.
- page-check can cancel the ready wait from a signal handler (`cancelled`); verify-boot cannot.
- page-check's port-busy probe (`net.connect`, loopback v4 and v6) is only there and stays there; verify-boot's own 3-host `httpGet` probe stays there.

## Plan

- New `scripts/nuxt-dev-server.mjs`: `groupAlive`, `httpGet`, `logTail`, `spawnNuxtDev`, `waitForNuxtReady`, `stopGroup`.
- Both scripts import it; their own copies are deleted. Messages, timeouts and exit codes unchanged.
- New `scripts/nuxt-dev-server.test.ts` (fast tier) for the helper.

## Acceptance

- [x] `scripts/nuxt-dev-server.mjs` holds the single implementation; no `process.kill(-pgid` probe, nuxt `spawn` or ready-wait loop remains in `verify-boot.mjs` step 4 or `page-check-server.mjs`.
- [x] `scripts/nuxt-dev-server.test.ts` covers `httpGet`, `stopGroup` (clean stop, and SIGKILL of a SIGTERM-ignoring group, return value true), and `waitForNuxtReady` (exit/timeout, cancelled, wrong port, up).
- [x] Existing `scripts/page-seed.test.ts`, `page-check*.test.ts` pass unchanged.
- [x] `pnpm check` passes once on the committed tree; `pnpm page:check --seed --all` is clean.

## Comments

- 2026-11-17: written and implemented in c23bf18. Evidence: `pnpm check` passed on that tree (161 files, 2626 tests, stamped tree 945211f4eb); `pnpm page:check --seed --all` exit 0 on every page, seeded, port 3217 free and dir removed after; `pnpm verify:boot` PASS on all four steps (step 4 uses the shared helper).
