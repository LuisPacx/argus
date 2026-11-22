# verify:boot failure report shows too few log lines

Status: done

## Problem
On a step failure, scripts/verify-boot.mjs keeps only the last 3 lines of the dev-server log (logTail). On 2026-11-22 that cut off the real error ("Another Nuxt dev server is already running ... NUXT_IGNORE_LOCK=1"); only the pnpm ERR line showed. Root cause note: .scratch/phase-1-build-path/issues/19-temp-dir-hygiene.md.

## Acceptance
- [x] logTail keeps the last 20 lines; the test that pins 3 is updated to pin 20 (test first, fails on parent)
- [x] `pnpm check` passes

Luis 2026-11-22: yes to proposal.
Model: haiku, effort low

## Comments
- 2026-11-22 [0d50a746] pnpm check passed (255 files, 4238 tests), stamped 024a45dffb; test pinned 3 failed before the change, passes at 20. Note added by hand: the ticket helper refused the path because the session cwd is not the argus repo.
