# 07: A Meta does not drop out and re-fire on a short dip (exit hysteresis)

Status: done
Model: sonnet, effort high

## Problem

Live runs 627-637 (see 06-live-check-christmas-meta.md Comments): Christmas was a Meta at run 627 (g24 11, creators 45, leader $snowball), absent at 628-629, "watching" at 630-636, and a Meta again at 637, which fired a second New Meta event. The Meta rule has no exit hysteresis, and the subject lost $snowball between runs, so one narrative produced two New Meta events in a day.

## Acceptance criteria

- [x] A Meta stays a Meta (or a clearly marked cooling state) through a short dip below the entry thresholds; exit needs a lower bar or N consecutive runs below (pick and justify the rule in an ADR).
- [x] Re-entering after a dip within the cooling window does not emit a second New Meta event for the same key.
- [x] A subject's leader token leaving the subject does not by itself end the Meta; explain how $snowball dropped out and fix it if it is a stabiliser bug (tickets 02/03).
- [x] Tests replay the 627-637 sequence (from the live DB, read-only) and show one Meta episode, one New Meta event.
- [x] `pnpm check` passes.

## Comments
- 2026-11-22 23:23 [0d50a746] christmas-07 dd5521e: dip = stabiliser tie (Grinch took key xmas at run 628, equal overlap, smaller derived key won); snowball leaving is not a cause (Meta follows key). Fixed + 45min exit delay + 6h New Meta guard; ADR 0020; check pending.
- 2026-11-22 23:30 [0d50a746] christmas-07 dd5521e: pnpm check passed (4254 tests, stamped). Boxes a-e met; replay test fails on the old tie-break. Not merged.
- 2026-11-22 23:41 [0d50a746] Fix round 368c0f5 on christmas-07: COOLING_WHY reworded, fixture header and architecture.md (re-entry guard) fixed, replay runs 628/629 use live count 4 and prove the 45-min hold. pnpm check passed (255 files, 4255 tests).
- 2026-11-22 23:50 [0d50a746] Merged 368c0f5 to main: verifier PASS 4255/4255, replay fails on parent, review APPROVE. All boxes ticked.
- 2026-11-22 23:50 [0d50a746] Live worker (supervisor PID 1890700, started 16:37 -03) predates the fix; needs pnpm dev:stop && pnpm dev:start (also restarts War Room). Asked Luis for OK.
- 2026-11-23 00:17 [0d50a746] Luis OK'd restart: argus dev stack restarted 00:16Z (worker 2660618, warroom 2660399, :3100 200, first ticks clean). Pushed main a6f7847.
