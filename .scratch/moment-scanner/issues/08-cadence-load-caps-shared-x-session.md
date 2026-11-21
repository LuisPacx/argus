# 08: The hourly cap, the load ramp and one X session wrapper for every X job
**Model:** sonnet / high. It decides how hard argus hits one logged-in X account. A mistake here costs the account, and the Study with it.

**What to build:** what is left of the safety layer once ticket 01 has shipped the lock, the shared stop state, the next-day probe, the second-wall stop and Resume. This ticket adds: an hourly load cap; the ramp the Operator chose (100 loads a day in week 1, up to 300 only after a week with no stop signal); a minimum gap between scans; and one wrapper, `withXSession`, that every X job goes through so the Study's capture (Phase 3 ticket 06, not built) gets the same lock, stop state and counting. The page shows loads against each cap and the ramp day. Useful alone: the account's exposure is bounded by code that is the same for every X job, and the ramp is automatic.

**Status:** superseded

**Blocked by:** 01
Ticket 01 owns the lock (`x-capture/lock.mjs`), the `x_session_state` table with its stop, probe and second-wall rules, and the Resume request; this ticket builds on them and does not change them.

## Design

- **Wrapper** `packages/core/src/x-session/with-x-session.ts`: `withXSession(job: "scanner" | "study", plan, fn)` takes the lock (01), reads the stop state (01), checks the job's allowance, runs `fn` with a `load()` counter, releases the lock and records loads. It never waits for a lock: held means skip and say who holds it (a pid, "manual session", or the other job). The scanner's worker step is moved onto it.
- **Caps in code** (one config file; lowerable only through `ARGUS_MOMENT_*` and `ARGUS_STUDY_*` variables, never raised past the ceilings): scanner loads per scan 8 (from 01), **per hour 24 (rolling 60 minutes)**, per day 100 for the first 7 days after the scanner's first scan and 300 after a week with no STOP signal (a STOP resets the week). The Study keeps its own 200. The probe load of ticket 01 counts toward the day. A scan that would pass a cap is shortened (fewer queries, Meta topics first once ticket 05 exists) or skipped, never run over.
- **Cadence:** a minimum gap of 15 minutes between any two scans whatever the topics are; the default interval stays 30 (from 01). The per-topic halving of flat topics belongs to ticket 05.
- **Study seam:** this ticket does not build the Study's capture. It adds `withXSession("study", ...)` and a test, and appends a Comment to `.scratch/phase-3-feedback/issues/06-x-capture-job.md` telling that ticket to take its lock, stop rule and counting from here and to drop its own copy.
- **Telegram:** ticket 01 sends the STOP message; this ticket limits stop messages to 1 an hour and adds none for a skip because of a held lock.

## Acceptance criteria

- [ ] **Wrapper** (`with-x-session.test.ts`, temp dirs, a fake `SingletonLock` symlink to a live pid and to a dead pid): held by a live process skips with who; stale is allowed; it never waits or loops; two simultaneous calls in one process take the lock once; a `stopped` state (01) makes it load nothing for either job; a STOP seen inside `fn` is recorded through ticket 01's state and ends `fn` with no further load.
- [ ] **Caps** (`caps.test.ts`, fake clock): day 1 to 7 allows 100 loads and the 101st is refused; after a clean week up to 300; a STOP on day 5 resets the week and the 100 cap; the 25th load in a rolling hour is refused; the probe load counts in the day; a scan over its per-scan cap is shortened, not run over; `ARGUS_MOMENT_LOADS_PER_DAY=900` is an error at boot and 40 lowers it; no setting raises a cap past the code ceiling; the Study's 200 is counted apart.
- [ ] **Gap** (`moments-job.test.ts`): two scans due inside 15 minutes run once.
- [ ] **Study seam** (`study-seam.test.ts`): `withXSession("study", ...)` shares the lock, the stop state and the STOP behaviour with the scanner and has its own 200-a-day count; the phase-3 ticket 06 Comment is appended.
- [ ] **Page** (`moments-render.test.ts`, `pnpm page:check --seed /moments`, seeded; say so): loads today and this hour against each cap, the ramp day and the date the 300 cap opens, and the session state from 01 unchanged; no overflow at 390 or 1240 px.
- [ ] **Telegram:** at most one stop message an hour; none for a held lock (tested with the existing Telegram fake).
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- No second browser process on the directory, ever. Nothing here posts, likes, follows or messages. The Operator's manual Argus Chrome session is never killed or waited for. Kill any test process by PID only.
- Commit subject `Moment scanner ticket 08: hourly cap, ramp and X session wrapper`, body ends with `Ticket: .scratch/moment-scanner/issues/08-cadence-load-caps-shared-x-session.md`.

## Comments
- Superseded by .scratch/human-researcher (ADR 0017: agents run only on Operator trigger)
