# 08: Cadence, load caps and one shared X session
**Model:** sonnet / high. It decides how hard argus hits one logged-in X account and what happens at the first wall. A mistake here costs the account, and the Study with it.

**What to build:** the safety layer the amendment to ADR 0009 describes, as one module that every X job goes through. An hourly cap, a ramp that starts the scanner at 100 loads a day and only reaches 300 after a clean week, one lock shared by the scanner, the Study's capture job and the Operator's manual Argus Chrome session, a shared "X session" state so a wall seen by one job pauses all of them, and a Resume control for the Operator. The page shows the state. Useful alone: the account's exposure is bounded and visible, and Phase 3 ticket 06 (the Study's X capture, not built) has a ready, tested seam to use.

**Status:** ready-for-agent

**Blocked by:** 01. (Better after 05, but not required.)

## Design

- **Module** `packages/core/src/x-session/` (the lock from ticket 01 moves under it, or is imported by it): `withXSession(job: "scanner" | "study", plan, fn)` takes the lock, checks the shared state and the job's allowance, runs `fn` with a `load()` counter, releases the lock, and records loads. It never waits for a lock: held means skip and say who holds it (a pid, "manual session", or the other job).
- **State** `x_session_state` (one row): `status` `ok|stopped`, `reason` (the `detect.mjs` signal), `stopped_at`, `resume_at` (next 00:00 UTC), `strikes` (STOP signals in the last 7 days), `probe_due`. A STOP by either job sets `stopped` for both. The next day the first job to run makes exactly one probe load (the account's own profile page by URL, one load, counted); a clean probe clears it; a second STOP inside 7 days sets `stopped` with no `resume_at` until the Operator presses Resume.
- **Caps in code** (config file, lowerable only through `ARGUS_MOMENT_*` and `ARGUS_STUDY_*` variables, never raised past the ceilings): scanner loads per scan 8, per hour 24, per day 100 for the first 7 days after the scanner's first scan and 300 after a week with no STOP signal (a STOP resets the week); the Study keeps its own 200. The hour is a rolling 60 minutes. A scan that would pass a cap is shortened (fewer queries, Metas first) or skipped, never run over.
- **Cadence:** per topic default 30 minutes, minimum 15; a topic with 6 flat scans in a row halves its rate (ticket 05), and the scanner never runs two scans inside the minimum gap whatever the topics are.
- **Manual session:** the existing lock check (`SingletonLock`) also guards against the Operator's manual Argus Chrome; when it is held the scan is skipped with "manual session". Nothing kills it.
- **Operator control:** a "Resume X jobs" button on the Moments page writes one request row (insert only); the worker clears `stopped` on the next tick; refused unless `status = stopped`; every press recorded with its time.
- **Study seam:** this ticket does not build the Study's capture. It adds `withXSession("study", ...)` and a test, and appends a Comment to `.scratch/phase-3-feedback/issues/06-x-capture-job.md` telling that ticket to take its lock, stop rule and counting from here and to drop its own copy.

## Acceptance criteria

- [ ] **Lock** (`lock.test.ts`, temp dirs, a fake `SingletonLock` symlink to a live pid and to a dead pid): held by a live process refuses with who; stale is allowed; the job never waits or loops; two simultaneous calls in one process take it once.
- [ ] **State machine** (`state.test.ts`): a STOP by the scanner stops the Study's `withXSession` too and the reverse; the next UTC day allows exactly one probe load and no more until it is clean; a clean probe clears the state; a second STOP within 7 days leaves `stopped` with no resume time until Resume; Resume on an `ok` state is refused; every STOP signal class in `detect.mjs` (`login_wall`, `challenge`, `locked`, `own_suspended`, `rate_limited`) takes this path; a `not_found` or `target_suspended` page does not.
- [ ] **Caps** (`caps.test.ts`, fake clock): day 1 to 7 allows 100 loads and the 101st is refused; the 8th day after a clean week allows up to 300; a STOP on day 5 resets the week and the 100 cap; the 25th load in a rolling hour is refused; a scan over its per-scan cap is shortened with the Meta topic kept first; `ARGUS_MOMENT_LOADS_PER_DAY=900` is an error at boot and 40 lowers it; no setting raises a cap past the code ceiling.
- [ ] **Study seam** (`study-seam.test.ts`): `withXSession("study", ...)` shares the lock, the state and the STOP behaviour with the scanner and has its own 200-a-day count; the phase-3 ticket 06 Comment is appended.
- [ ] **Page** (`moments-render.test.ts`, `pnpm page:check --seed /moments`, seeded; say so): the session state (ok, stopped with reason and time, probe due, manual session), loads today and this hour against each cap, the ramp day, and the Resume button only when stopped; the button posts one request (the script's non-GET block means it is not pressed in the check; keyboard: `--keys "focus=[data-test=x-resume]"`); no overflow at 390 or 1240 px.
- [ ] **Telegram:** one message on a STOP (text: job, signal, "X jobs paused until the Operator resumes or the next UTC day"), none for a skip because of a held lock, at most 1 an hour (tested with the existing Telegram fake).
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- No second browser process on the directory, ever. Nothing here posts, likes, follows or messages. The Operator's manual Argus Chrome session is never killed or waited for. Kill any test process by PID only.
- Commit subject `Moment scanner ticket 08: cadence, load caps and one shared X session`, body ends with `Ticket: .scratch/moment-scanner/issues/08-cadence-load-caps-shared-x-session.md`.

## Comments
