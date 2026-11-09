# 14: Phase 2 acceptance run
**Model:** sonnet / medium — runs the definition of done live and records evidence; the Operator is present.

**What to build:** Run argus for 48 hours unattended against live Sources and check the Phase 2 definition of done in architecture §12.

**Blocked by:** 01 to 13, Phase 1 ticket 10 (Phase 1 acceptance run)

**Status:** in-progress

- [ ] Over 48 hours unattended, argus produces at most 30 Proposals per day from live Sources
- [ ] Every card shows all the fields listed in architecture §8
- [ ] Stale Proposals close on schedule
- [ ] A forced subscription exhaustion switches `judge` and `propose` to the API while Builds wait, and API spend stays under its daily cap
- [ ] A Proposal goes from card to marked launched using only the War Room and newpairspam
- [ ] The evidence (logs, counts, Est. usage and API spend, screenshots) is recorded in this ticket

## Evidence

Cap raised 10 -> 30 by the Operator on 2026-11-06 mid-run

AC4 (forced subscription exhaustion) and AC5 (card to marked launched) stay open for this run; the Operator approved research only with API fallback off.

### Run start

- Started: 2026-11-06T15:28:43-03:00 (worker first tick 2026-11-06T18:28:43Z), 48 h run ends about 2026-11-08T15:28-03:00.
- Commit: 56d7869 (main).
- Config: defaults, no `.env`; API fallback off ("API fallback off (ARGUS_API_FALLBACK=1 turns it on)"); Telegram off; embedder semantic (Xenova/gte-small q8). Started with `pnpm dev:start`; War Room http://localhost:3100/ and /narratives both returned 200.

### First tick (ingest 15:28:43, 17 sources, 400 new Signals; clustering waited for the embedder, then ran at the 2nd ingest tick: 475 Signals into 353 Narratives)

Per-source Signals in the datastore at about 15:36 (13 RSS feeds plus 4 standing sources; the log reports only totals, so counts come from `signals` grouped by source):

| Source | Signals |
|---|---|
| Ars Technica | 20 |
| BBC Technology | 21 |
| BBC World | 25 |
| CoinDesk | 25 |
| Cointelegraph | 30 |
| Decrypt | 39 |
| The Block | 20 |
| The Guardian World | 45 |
| The Verge | 10 |
| WIRED | 50 |
| TechCrunch | 20 |
| NPR News | 10 |
| Hacker News front page | 20 |
| Google Trends | 10 |
| DexScreener trending | 25 |
| GitHub trending | 30 |
| PumpPortal | 0 at the first tick (websocket stream; 391 by 16:00) |

No source returned 0 items over the run so far, except PumpPortal at the very first tick (event stream fills over time).

### Baseline counts (datastore read-only, 16:00-03:00)

Signals 817, Narratives 369, Scores 10, Proposals 1.

### First judge pass (15:58:43, 30 min cadence)

- judge: 10 scored, 0 refused, 0 failed, all via claude-code / haiku, est. cost $0.0148 total.
- Top scores: Narrative 237 = 7.0, 146 = 6.0, 70 = 5.8, 202 = 5.6; PumpPortal-only Narratives scored 1.8 to 2.0.
- propose: 1 proposed ("Plain Results Club", PLAINSRCH, from Narrative 70, status new), 0 refused, 0 failed; two propose runs via claude-code / sonnet, $0.0272 and $0.0277 (total $0.0549).

### Errors seen

- `[ingest] rss:hn-frontpage failed: This operation was aborted` (one fetch timeout, one ingest tick, recovered on the next).
- Earlier `worker.log` lines from 2026-11-04 are old runs, not this one.
- Observation (not fixed): Proposal 1 shows `agent_cost_usd` 0.0 although two propose runs cost $0.0549 in `brain_runs`; two propose runs for one Proposal also to check.

- Restart 2026-11-06T19:48:25Z to 2026-11-06T19:49:04Z to deploy the Activity page (199fab8); downtime 39 s; the 48 h window continues from the original start. Migration applied (source_polls exists, brain_runs.finished_at present); source_polls has 17 rows (one per Source) after the first ingest tick; / and /activity return 200; no errors in worker.log since restart.

### Check-in 2026-11-06T18:47:44-03:00

- Status: `dev:status` reports warroom running (pid 659237, port 3100) and worker running (pid 660582).
- Datastore (read-only, counts at 2026-11-06 18:47 -03:00): Signals 3248, Narratives 452, Scores 60, Proposals 7.
- Proposals by status: new 7. Created per calendar day (UTC date): 2026-11-06 = 7. Cap is 10 per day; 3 left today.
- Expired Proposals: 0 (no status 'expired' rows; the proposals table has no expiry column).
- brain_runs in the last 6 h: 70 runs, estimated cost $0.3559 total.
- worker.log since the restart (from line after 2026-11-06T19:49:04Z, log tail 21:47:33Z): 1 ingest tick with 1 failed source, 1 propose refusal, 1 ExperimentalWarning (SQLite, startup only). Count of real errors and warnings: 3 (plus 1 startup warning). Most frequent messages:
  1. `[worker] judge tick: N scored, N refused, N failed` (4 summary lines, all 0 failed).
  2. `[worker] propose tick: N proposed, N refused, N failed` (4 summary lines; one tick had 1 refused).
  3. `[ingest] rss:hn-frontpage failed: This operation was aborted` (1; same fetch-timeout as before). Also: `propose: narrative 189 refused: \`evidence\` must be an array of 3 to 5 links`` (1).

- Propose run cap raised 30 -> 45 by the Operator on 2026-11-06 mid-run
- Restart 2026-11-06T23:28:27Z-2026-11-06T23:28:50Z (23 s downtime) on 08b5302 to apply caps 30 Proposals/day and 45 propose runs/day.
- Restart 2026-11-07T02:18:18Z-2026-11-07T02:18:42Z (24 s downtime) on 26afe60 to deploy the War Room redesign (ticket 18). New PIDs: warroom 1470085, worker 1470825. Fix needed: stale dev-server resolution of @fontsource-variable/plus-jakarta-sans returned 500 on all pages; restart cleared it.

### Check-in 2026-11-07T00:47:55-03:00

- Status: `dev:status` reports warroom running (pid 1470085, port 3100) and worker running (pid 1470825). Running: yes.
- Datastore (read-only, counts at 2026-11-07T00:47:55-03:00): Signals 7602, Narratives 670, Scores 150, Proposals 21.
- Proposals by status: new 21 (no other status). Created per calendar day (UTC date): 2026-11-06 = 13, 2026-11-07 = 8. Proposals in the last 24 h: 21 (cap 30).
- Expired Proposals: 0 (no status other than new; no expiry column).
- brain_runs in the last 6 h: 113 runs, estimated cost $0.8507 total.
- worker.log since the last check-in (2026-11-06T21:47:44Z, from line 2508): 0 error-level lines; 2 ingest source failures (`github:trending`, `rss:hn-frontpage`, each `This operation was aborted`, one tick each); 6 propose refusals (`evidence` must be an array of 3 to 5 links), 4 of them counted in propose tick summaries; 2 ExperimentalWarning (SQLite, startup only); 5 cap stops (3 judge daily-cap, 2 propose proposal-cap).
- Most frequent warning/error messages:
  1. `propose: narrative N refused: evidence must be an array of 3 to 5 links` (6)
  2. `[ingest] <source> failed: This operation was aborted` (2 distinct sources, 1 each)
  3. `(node:N) ExperimentalWarning: SQLite is an experimental feature` (2)

### Restart 2026-11-07T10:31:00-03:00 (after suspend)

- Downtime 2026-11-07 01:00:02 -03:00 to 10:31:00 -03:00 (9h30m58s). Cause: laptop suspended on lid close, then rebooted at 10:24; no argus fault. Same configuration: defaults, no `.env`, research-only, API fallback off, Telegram off.
- Time counted so far: 21h32m (2026-11-06 15:28 to 2026-11-07 01:00). Top-up: 26h28m. New planned end: 2026-11-08T12:59:00-03:00 (restart time + 26h28m).
- New PIDs: warroom 11274 (port 3100), worker 11438. HEAD at restart: aa822d548125d08e9498708349744c5c99010c00.
- Checks: / and /activity return 200; worker.log shows fresh ticks from 2026-11-07T13:31:00Z with no errors. First tick: judge daily cap reached (150 runs in 24 h) and waiting; ingest 17 sources, 86 new signals.

### Restart 2026-11-07T11:01:24-03:00 (under the sleep lock)

- Restarted through `pnpm dev:stop` / `pnpm dev:start` so both processes run under the systemd-inhibit sleep/lid lock (c2c75c3). Same configuration: research-only, API fallback off, Telegram off.
- Downtime 2026-11-07 11:00:34 -03:00 (stop issued) to 11:01:24 -03:00 (first tick of the new worker): 50 s.
- New planned end: 2026-11-08T12:59:50-03:00 (previous 2026-11-08T12:59:00-03:00 plus 50 s).
- New PIDs: warroom 171016 (port 3100), worker 174028. Old PIDs 11274, 11438, 11461 confirmed gone before start. HEAD at restart: c2c75c3c04f4f814b9ffe7f46f253ea32a3f0cfb.
- Checks: `dev:status` shows "sleep lock: held (2 argus locks, handle-lid-switch:sleep)"; `systemd-inhibit --list` shows two who=argus block locks (sleep:handle-lid-switch); / and /activity return 200; worker.log shows "API fallback off" and fresh ticks with no errors (judge daily cap reached and waiting; ingest 17 sources).

### Check-in 2026-11-07T12:47:23-03:00

- Status: `dev:status` reports warroom running (pid 362056, port 3100), worker running (pid 174028), "sleep lock: held (2 argus locks, handle-lid-switch:sleep)". Running: yes. / and /activity return 200. package.json and git status clean.
- Time: 21h18m elapsed since the 2026-11-06 15:28 start (including 9h31m suspend downtime). Planned end unchanged: 2026-11-08T12:59:50-03:00.
- Datastore (read-only, counts at 2026-11-07 12:47 -03:00): Signals 9259, Narratives 802, Scores 150, Proposals 21.
- Proposals by status: new 20, spec-drafted 1 (Proposal 21, the accidental Shortlist below). Created per calendar day (UTC date): 2026-11-06 = 13, 2026-11-07 = 8. Proposals in the last 24 h: 21 (cap 30). Since the last check-in (00:48 -03:00): 0. Expired Proposals: 0.
- brain_runs since the last check-in (00:48 -03:00 = 03:48Z): 1 run, $0.0438 (judge 0, propose 0): the spec run for Proposal 21 (sonnet). Downtime 01:00 to 10:31 produced no runs.
- brain_runs in the last 24 h: 184 runs, $1.2504 total. Rows start 2026-11-06T18:58:43Z, so the 24 h window is the whole run to date. By task and outcome: judge (haiku, success) 150 runs, $0.1975; propose (sonnet, success) 25 runs, $0.8074; propose (sonnet, invalid-output) 8 runs, $0.2016; spec (sonnet, success) 1 run, $0.0438.
- Judge cap: binding. 150 runs in 24 h, and the worker has logged `judge: daily cap reached` and skipped judging since the last check-in (6 cap-stop ticks in the window). Runs age out of the 24 h window from 2026-11-07T18:58Z onward, so the cap releases gradually.
- Propose caps: not reached. Proposal cap 21 of 30; propose runs 33 of the 45/day limit. The two `daily cap of 10 new Proposals` lines in worker.log are from before the raise to 30 (lines 3314 and 3671).
- Propose refusals (whole run): 5 `narrative N refused: evidence must be an array of 3 to 5 links`, plus 3 name-retry notices (2 for evidence, 1 for non-JSON output), matching the 8 invalid-output propose runs. Since the last check-in: 0.
- Errors since the last check-in: 0 error-level lines; no ingest failures; no judge or propose failures. Whole run ingest failures: `rss:hn-frontpage` aborted 3 times, `github:trending` aborted once (each one tick, recovered). SQLite ExperimentalWarning appears at startup only.

Operator actions today (not research; excluded from the research counts above except where a row is noted):

- About 11:25 -03:00, accidental Shortlist of Proposal 21 (created 2026-11-06T22:21 -03:00): one spec brain run (sonnet, $0.0438, brain_runs created 2026-11-07T14:25:45Z, exit success). Proposal 21 is now spec-drafted. Log: `spec for proposal 21: drafted`, `resolved 1 command(s)`. The run is included in the 24 h totals above.
- About 11:30 -03:00, War Room-only restart for ticket 19 (the worker was not touched; worker pid 174028 is unchanged since 11:01).
- Restarts at 10:31 (after suspend) and 11:01 (sleep lock) are recorded above.

### Check-in 2026-11-07T18:47 -03:00

- Status: `dev:status` reports warroom running (pid 362056, port 3100), worker running (pid 174028), "sleep lock: held (2 argus locks, handle-lid-switch:sleep)". Running: yes. `systemd-inhibit --list` shows two argus block locks (sleep:handle-lid-switch, one per process). / and /api/proposals return 200. No process was restarted or signalled for this check-in.
- Time: 27h19m elapsed since the 2026-11-06 15:28 start (including 9h31m suspend downtime). Planned end unchanged: 2026-11-08T12:59:50-03:00 (18h12m left).
- Proposals: total 27 (new 26, spec-drafted 1). Proposals in the last 24 h: 20 (cap 30). Since the last check-in (15:47Z): 6 (Proposals 22 to 27, created 19:02Z to 21:02Z).
- brain_runs in the last 24 h (window from 2026-11-06T21:47Z): 184 runs, $1.2511 total. By task and outcome: judge (haiku, success) 150 runs, $0.1944; propose (sonnet, success) 24 runs, $0.7837; propose (sonnet, invalid-output) 9 runs, $0.2292; spec (sonnet, success) 1 run, $0.0438 (the Proposal 21 run from 14:25Z).
- brain_runs since the last check-in (15:47Z): 70 runs, $0.3036: judge 60 runs, $0.0801 (six 10-narrative ticks, 19:02Z to 21:32Z); propose 10 runs, $0.2765 (8 success $0.2230, 2 invalid-output $0.0535). The spec run is outside this window.
- Judge cap: binding again. The 24 h judge count is exactly 150 at 21:47Z. The worker logged `judge: daily cap reached` and skipped judging at six ticks (16:01, 16:31, 17:01, 17:31, 18:01, 18:31Z). Judging resumed at 19:02Z as runs aged out, and the 21:32Z tick scored 10. The cap-stop log line repeats the fixed figures "150 runs, $0.1975"; the DB shows $0.1944 for the same 150 runs now, so treat the log figure as stale.
- Propose caps: not reached. Proposals 20 of 30 in 24 h. Propose runs 33 in 24 h, under the 45/day limit.
- Propose refusals since the last check-in: 2 (narrative 321 at 19:32Z, narrative 829 at 21:02Z), both `evidence must be an array of 3 to 5 links`. These match the 2 invalid-output propose runs (ids 208 and 242). The 24 h total is 9 invalid-output runs.
- Errors since the last check-in: 0 error-level lines; no judge or propose failures ("0 failed" on every tick). Ingest: `rss:hn-frontpage` failed 6 times (16:06 aborted, 16:16 aborted, 16:36 fetch failed, 16:56 502 Bad Gateway, 17:26 aborted, 18:31 aborted), each one tick and recovered. No `github:trending` failures in the window.
- Datastore counts (Signals, Narratives, Scores) were not re-counted for this check-in.

Operator actions since the last check-in: none. This check-in only read the DB (read-only) and the logs.

### Check-in 2026-11-08T00:47 -03:00

- Status: `dev:status` reports warroom running (pid 362056, port 3100), worker running (pid 174028), "sleep lock: held (2 argus locks, handle-lid-switch:sleep)". Running: yes. `systemd-inhibit --list` shows the two argus block locks (sleep:handle-lid-switch, one per process). / and /api/proposals return 200. No process was restarted or signalled for this check-in.
- Time: 33h19m elapsed since the 2026-11-06 15:28 start. Planned end unchanged: 2026-11-08T12:59:50-03:00 (12h12m left).
- Proposals: total 39 (was 27 at the last check-in, so 12 new). Proposals in the last 24 h: 18 (cap 30, not exceeded).
- brain_runs in the last 24 h: 184 runs, $1.1778 total by task and outcome: judge (success) 150 runs, $0.1927; propose (success) 23 runs, $0.6921; propose (invalid-output) 10 runs, $0.2492; spec (success) 1 run, $0.0438.
- brain_runs since the last check-in (created after 2026-11-07T21:47Z): judge (success) 90 runs, $0.1126; propose (success) 15 runs, $0.4692; propose (invalid-output) 8 runs, $0.1957. Total 113 runs, $0.7775.
- Judge cap: binding again. The worker logged `judge: daily cap reached` and `stopped: daily-cap` on repeated ticks in the window, interleaved with normal judge ticks of 10 scored. The cap-stop log line repeats the stale figure "150 runs, $0.1975"; the DB shows $0.1927 for the current 150 runs, so treat the log figure as stale.
- Propose caps: one tick logged `stopped: proposal-cap` (two occurrences in the window). Propose runs 33 in 24 h, under the 45/day limit.
- Propose refusals since the last check-in: about 9 in the log, all `evidence must be an array of 3 to 5 links` except one `tech is over 200 characters` (narrative 90). Matches the 8 invalid-output runs in the DB since the last check-in (one run is the 24 h tally of 10 invalid-output).
- Errors since the last check-in: 0 judge or propose failures ("0 failed" on every tick). Ingest: `rss:hn-frontpage` failed as known (aborted, fetch failed, 502 Bad Gateway, each one tick and recovered). New to this window: `github:trending` failed with "This operation was aborted" on three ticks (one tick also had rss aborted). Each recovered on the next tick.
- Datastore counts (Signals, Narratives, Scores) were not re-counted for this check-in.

Operator actions since the last check-in: none. This check-in only read the DB (read-only) and the logs.

### Check-in 2026-11-08T06:47 -03:00

- Status: `dev:status` reports warroom running (pid 362056, port 3100), worker running (pid 174028), "sleep lock: held (2 argus locks, handle-lid-switch:sleep)". Running: yes. `systemd-inhibit --list` shows the two argus block locks (sleep:handle-lid-switch, one per process). / and /api/proposals return 200. No process was restarted or signalled for this check-in.
- Time: 39h19m elapsed since the 2026-11-06 15:28 start. Planned end unchanged: 2026-11-08T12:59:50-03:00 (6h12m left).
- Proposals: total 39 (unchanged since the last check-in). Proposals in the last 24 h: 18 (cap 30, not exceeded). None created since the last check-in; the newest Proposal was created 2026-11-08T02:02:25Z.
- brain_runs in the last 24 h (window from 2026-11-07T09:47Z): 184 runs, $1.1778 total by task and outcome: judge (success) 150 runs, $0.1927; propose (success) 23 runs, $0.6921; propose (invalid-output) 10 runs, $0.2492; spec (success) 1 run, $0.0438.
- brain_runs since the last check-in (created after 2026-11-08T03:47Z): 0. The newest brain run was created 2026-11-08T02:02:20Z.
- Judge cap: binding. The 150 judge runs in the 24 h window were all created between 2026-11-07T19:00Z and 2026-11-08T02:02Z, so the cap holds until about 2026-11-08T19:00Z, which is after the run ends. The worker logged `judge: daily cap reached (150 runs, $0.1927 in 24 h); waiting` and `stopped: daily-cap` on every judge tick since the last check-in. Unlike the earlier entries, the logged figure matches the DB now ($0.1927). Zero narratives scored since 02:02Z.
- Propose caps: not reached. Propose runs 33 in 24 h, under the 45/day limit. No propose runs since 02:02Z (no new judged narratives).
- Propose refusals since the last check-in: 0 (the 10 invalid-output runs in the 24 h window are all from before 03:47Z).
- Errors since the last check-in: 0 error-level lines; 0 judge or propose failures ("0 failed" on every tick). Ingest: `rss:hn-frontpage` failed 7 times (6 `This operation was aborted`, 1 `502 Bad Gateway`), each one tick and recovered, as known. `github:trending` had 0 failures in the window (the last aborts were before 03:47Z). Ingest ticks continued every cycle (17 sources).
- Datastore counts (Signals, Narratives, Scores) were not re-counted for this check-in.

Operator actions since the last check-in: none. This check-in only read the DB (read-only) and the logs.

### Final check-in 2026-11-08T13:24 -03:00 (16:24Z): whole-run totals

Whole run: start 2026-11-06T18:28:43Z (15:28:43 -03) to 2026-11-08T15:59:50Z (12:59:50 -03). Read-only: DB and worker.log; no process restarted or signalled.

- Liveness now: `dev:status` pids unchanged: warroom 362056 (port 3100), worker 174028. Both systemd-inhibit lock wrappers are alive (`sleep:handle-lid-switch`, who=argus). `/` and `/api/proposals` return 200. The worker is still ticking past the planned end (last log tick 2026-11-08T16:23:46Z); it was left running as instructed.
- Proposals: 39 total (38 `new`, 1 `spec-drafted`, Proposal 21). Per UTC calendar day: 2026-11-06 = 13, 2026-11-07 = 21, 2026-11-08 = 5 (to 02:02Z). Rolling 24 h maximum: 23 (window ending 2026-11-07T23:32Z). Cap 30 never reached. Two `stopped: proposal-cap` ticks were on 2026-11-06, before the raise to 30 (cap 10 then).
- brain_runs by kind (all backend claude-code; API backend runs: 0): judge (haiku, success) 300 runs, $0.3902; propose (sonnet, success) 48 runs, $1.4995; propose (sonnet, invalid-output) 18 runs, $0.4508; spec (sonnet, success) 1 run, $0.0438. Total 367 runs, $2.3844 (claude-code `total_cost_usd`, est. usage). API spend: $0.00 (API fallback off).
- Invalid-output and refusal counts: 18 invalid-output brain runs (all propose). Worker log has 18 `propose: narrative N refused` lines: 13 outputs dropped, and 5 name-retry notices where the Proposal was kept with a flagged name. Reasons: `evidence` not 3 to 5 links (most), `tech` over 200 characters (narrative 90), and non-single-JSON output (retry, narrative 59). Judge: 0 refused, 0 failed on all ticks.
- Judge cap stop windows (43 `stopped: daily-cap` judge ticks): window 1 from 2026-11-07T02:18:41Z to 18:31:25Z (15 ticks); window 2 from 2026-11-08T02:31:21Z to 16:01:20Z (28 ticks, still binding at the end). Judge scored 10 per tick between the windows.
- Errors by source (worker.log: 0 error-level lines, 0 judge or propose failed ticks; only startup SQLite ExperimentalWarnings):
  - Ingest source failures: 99 lines in total.
  - Network blip 2026-11-08T15:41Z to about 16:01Z: 71 source failures over five ingest ticks, 65 RSS feeds with `fetch failed` (incl. `rss:hn-frontpage`), plus Google Trends, DexScreener and GitHub trending (2 each). Recovered at the 2026-11-08T16:21:26Z ingest tick (70 new Signals, no failures).
  - Outside the blip: `rss:hn-frontpage` 22 (mostly `This operation was aborted`, plus 502 Bad Gateway and fetch failed, one tick each); `github:trending` 6 (`This operation was aborted`, one tick each). All recovered on the next tick.
- Stall: no brain runs after 2026-11-08T02:02:20Z (last judge 02:02:03Z). The 150 judge runs in the trailing 24 h were all created between 2026-11-07T19:00Z and 02:02Z, so the judge cap stayed binding until the run ended. Zero narratives were scored after 02:02Z, so propose had nothing new to work on and the pool stayed empty. Cause and fix are in ticket 21 (commit ef09647).
- Store counts at the end: Signals 22864, Narratives 1443, Scores 300.

Correction to the run clock: the 2026-11-07 01:00 -03 entry above recorded 21h32m elapsed from 2026-11-06 15:28 to 2026-11-07 01:00. That span is 9h32m. The 26h28m top-up, and so the 12:59:50 -03 end, were computed from that miscount. Wall clock from start to 15:59:50Z is 45h31m; minus the 9h31m suspend (04:00Z to 13:31Z on 2026-11-07) and about 2 min of restarts, the run had about 36h of uptime, not 48h.

Acceptance criteria (evidence at this check-in; no boxes ticked):
- AC1 (at most 30 Proposals per day, over 48 h unattended): partly. The cap held (max 23 in any rolling 24 h), but the unattended run covered about 36 h, not 48 h.
- AC2 (every card shows all architecture §8 fields): not evidenced. No card or field check is recorded for this run, and no screenshots are in the ticket.
- AC3 (stale Proposals close on schedule): not exercised. Expiry is wired (`apps/worker/src/main.ts`, `packages/core/src/expiry.ts`: `new` 48 h, `shortlisted` 7 d). The oldest `new` Proposal (2026-11-06T18:59:39Z) reaches 48 h at 18:59Z on 11-08, after the run end. No expiries, no status changes.
- AC4 (forced subscription exhaustion switches judge and propose to the API, builds wait, API spend under cap): not met. No forced exhaustion; API fallback off (Operator's research-only choice); API spend $0.00. The judge daily cap bound and stalled the pool, a different mechanism (ticket 21).
- AC5 (card to marked launched using only War Room and newpairspam): not met. No Proposal launched or marked launched; only `new` and `spec-drafted` statuses exist.
- AC6 (evidence recorded in the ticket): partly. Counts, logs and check-ins are recorded; screenshots are missing.

Operator actions since the last check-in: none. This check-in only read the DB (read-only) and the logs.

## Spec draft for #21 Zoo Lobby Ledger (saved before undo, 2026-11-08)

# Zoo Lobby Ledger (ZOOLOG)

A single-page Cloudflare Worker site that lays out cited public reporting on lobbying over endangered-animal imports ahead of CITES meetings, as a timeline with claims, denials and documents side by side, each with a source link.

## Goal

A visitor can open the page, read a dated timeline of reporting on the Vantara zoo lobbying story and the UK-chaired CITES meeting, filter it by entry type, and click through to the original article for every entry. It fits the Narrative now because on 3 Nov 2026 the Guardian and Mongabay reported that UK ministers were told not to engage formally with Vantara after lobbying. People following the story need one place that separates what was alleged, what was denied and what documents show, without editorialising.

## Scope

1. **Timeline**: reverse-chronological list of entries. Each entry has date, outlet, headline (as published), a one-to-two sentence neutral summary, a type badge (`claim`, `denial`, `document`, `event`) and a source link.
2. **Type filter**: buttons to show all or one type. Works client-side and is reflected in the URL query (`?type=denial`).
3. **Who-lobbies-whom panel**: a small table of relationships stated in the cited reporting (lobbying party, target, as reported by, source link). Each row is attributed ("according to the Guardian"), never stated as fact by the site.
4. **Permit counts**: a small block of figures that appear in the cited sources, each with the figure, what it counts, the source link and the date. Seed it only with numbers that are explicitly in the four sources; if none can be confirmed, show the empty state "No permit figures recorded yet" rather than inventing any.
5. **JSON API and about note**: `/api/entries` returns the data as JSON; a short "About and method" section explains that entries are hand-curated from public reporting, that the summaries are paraphrases, and that the ledger does not assert wrongdoing.

## Out of scope

- Accounts, comments, submissions, admin UI, or any write endpoint.
- Live scraping or fetching of the news sites, RSS, or any third-party API.
- Reproducing article text beyond a short paraphrase; no quotes longer than a few words.
- Tokens, wallets, trading, notifications, email.
- Charts or maps.

## Pages and routes

- `GET /`: the HTML page (server-rendered from the static data module, small inline-able CSS, minimal vanilla JS for filtering). Sections in order: header with one-line description, timeline with filter, lobbying relationships table, permit counts, About and method. The creator disclosure footer from the template stays.
- `GET /api/entries`: JSON `{ "updated": "YYYY-MM-DD", "entries": Entry[], "relationships": Relationship[], "permits": Permit[] }`. Optional `?type=` filter on entries; unknown type returns 400 with `{ "error": "unknown type" }`. Header `Cache-Control: public, max-age=300`.
- `GET /api/entries/:id`: a single entry, or 404 JSON `{ "error": "not found" }`.
- Any other path: 404 using the template's default.

Data shapes:

```
Entry { id: string, date: "YYYY-MM-DD", outlet: string, headline: string,
        summary: string, type: "claim"|"denial"|"document"|"event", url: string }
Relationship { id, lobbyist: string, target: string, reportedBy: string, url: string }
Permit { id, figure: string, describes: string, date: "YYYY-MM-DD", url: string }
```

## Data

- A single typed module `src/data.ts` exporting `entries`, `relationships`, `permits` and `updated`. No D1, KV or Durable Objects.
- Seed it with at least one entry per source below (use the URLs exactly), dated by the article publication date visible in the URL or page where known:
  - https://www.theguardian.com/environment/2026/nov/03/uk-ministers-anant-ambani-indian-zoo-vantara-freedom-information-endangered-animals-cites
  - https://news.mongabay.com/2026/09/vantara-works-with-lobbyist-tied-to-trump-jr-and-pro-hunting-groups/
  - https://www.khaleejtimes.com/world/asia/india-mega-zoo-in-spotlight-animal-acquisitions
  - https://www.dawn.com/news/1954843/india-asks-un-wildlife-body-to-not-curb-its-animal-imports-amid-ambani-zoo-furore
- The implementer cannot browse. Write summaries only from what the Proposal and the URL slugs support (for example: the Guardian reported ministers were told not to engage formally with Vantara after lobbying, based on freedom of information material; Mongabay reported Vantara works with a lobbyist; Dawn reported India asked the UN wildlife body not to curb its animal imports). Where a detail is not supported, leave it out. Do not invent quotes, numbers, names or denials. Add a visible note on the page: "Summaries are paraphrased from headlines and URLs by the site maintainer and have not been verified against full articles; check the source."
- Do not add `denial` or `document` entries unless the slugs/Proposal support them; it is fine for those types to be empty at launch, with filter buttons showing a count of 0.

## Acceptance criteria

- [ ] `GET /` returns 200 HTML containing the timeline, relationships, permits and About sections, plus the template's disclosure footer.
- [ ] Every entry, relationship and permit row renders a working `<a href>` with `rel="noopener noreferrer"` to its source URL.
- [ ] All four evidence URLs appear at least once in the page.
- [ ] Entries render newest first.
- [ ] `?type=claim` (and other valid types) filters the server-rendered list; the filter buttons work with JS enabled and the links work without JS.
- [ ] `GET /api/entries` returns valid JSON matching the shapes above; `?type=bogus` returns 400; `/api/entries/<unknown>` returns 404.
- [ ] Unit tests cover the filter function, the sorting, and the API status codes; template lint and CI pass.
- [ ] A test asserts every `url` in the data module is `https:` and every entry has a non-empty summary.
- [ ] The paraphrase disclaimer is visible on the page.
- [ ] Layout is readable at 360px width; text contrast is sufficient; no external fonts, scripts or trackers.
- [ ] No secrets, env vars or outbound fetches are required to run or deploy.

## Notes for the implementer

- Escape all data when rendering HTML (even though it is static) with a small helper; do not use `innerHTML` with data.
- Build in this order: data module and types, filter/sort helpers with tests, API routes, HTML renderer, filter UI, styling.
- Cut first if short on time: the `/api/entries/:id` route, then the permit block (keep the empty state), then the URL-reflected filter JS enhancement.
- Keep the tone neutral: use "reported", "according to", "alleged"; never state lobbying or wrongdoing as fact in the site's own voice.
- Set `updated` to the date of the last data edit (seed: 2026-11-07).

## Re-run (2026-11-09)

### Purpose

A fresh 48 h acceptance run of the Phase 2 definition of done, because the first run (2026-11-06 to 2026-11-08) left gaps: only about 36 h of uptime; AC2 not evidenced; AC3 not exercised; AC4 and AC5 not met; AC6 partial (no screenshots). Since the first run: ticket 21 (propose repair retry), ticket 22 (judge only Narratives with >= 2 Signals; cap 300/24h), ticket 23 (startup `[config]` line and PumpPortal/Study lifecycle logging) and ticket 24 (lint rule against non-literal RegExp) were merged.

### Operator decisions

- API fallback stays OFF for the whole run, with no forced window. AC4 is recorded as "not tested, by Operator decision".
- AC5 goes as far as built + the Launch link opening pump.fun prefilled. No real launch and no SOL. AC5 is therefore at best partial.
- The DB (`.data/argus.db`) is kept, so the carried-over `new` Proposals can expire for AC3. It must not be wiped or moved.
- Judge min Signals 2 and cap 300/24h.
- $20 daily quota with a 0.3 research share.
- Telegram off.

### Run start

- T0: 2026-11-09T16:28:34.799Z (2026-11-09T13:28:34-03:00), the first `[worker] tick` after the restart.
- Commit: c7b5392 (main; code as 8bff602 plus `scripts/tick-gaps.mjs`). Started with `pnpm dev:stop` / `pnpm dev:start`, no extra env. `pnpm install --frozen-lockfile`: already up to date.
- PIDs: warroom 3396797 (port 3100), worker 3397022. `dev:status`: "sleep lock: held (2 argus locks, handle-lid-switch:sleep)".
- `[config]` line:

```
[config] judge_min_signals=2 judge_runs_24h=300 propose_new_24h=30 propose_runs_24h=45 daily_quota_usd=20 research_share=0.3 api_fallback=off api_key=unset study=on study_rule=v1 study_age_s=60/300 study_captures_day=20000 telegram=off
```

### Start/end rule

End = T0 + 48h + downtime, computed only with `node scripts/tick-gaps.mjs 2026-11-09T16:28:34.799Z`, never by hand. A downtime is a gap of more than 10 min between consecutive `[worker] tick` lines. Every restart or suspend is logged here with its gap and the new End.

Initial End: 2026-11-11T16:28:34.799Z (2026-11-11T13:28:34-03:00).

### Evidence plan per AC

- AC1: Proposals per rolling 24 h vs 30 (SQL on `proposals.created_at` plus `/api/research`).
- AC2: at h6 and h42, fetch 3 Proposals via `/api/proposals/<id>`, check that every architecture section-8 card field is non-null, and take screenshots.
- AC3: the carried-over `new` Proposals are listed in the h0 check-in with created_at and expected close (created + 48 h). At each check-in: `grep -c 'closed stale Proposal'` on worker.log plus status_history rows with reason stale. Compare scheduled vs actual close at h42 and at the end.
- AC4: not tested, by Operator decision (API fallback off all run; API spend must stay $0.00).
- AC5: between h30 and h40, with the Operator present: shortlist one Proposal -> spec drafted -> approve -> build -> built -> check that the Launch link opens pump.fun prefilled. Record status_history and screenshots. Stop before launch (no real launch, no SOL).
- AC6: everything is recorded in this ticket.

Lockouts: count them. A lockout is a Narrative excluded from propose after an invalid-output propose run until a newer Score (see the propose candidate query in `packages/core/src/datastore.ts`). Also count cap/budget stops by reason (`stopped:`, `daily cap reached`, `research budget reached`, `the daily cap of`).

### 6h check-in brief

Each check-in records "### Check-in <ISO>" in the format of the first run, plus:

- the `node scripts/tick-gaps.mjs <T0>` output;
- the `[config]` line;
- `[pumpportal]` lifecycle lines since the last check-in (connect count, max `open`, reconnects);
- Study counts from `/api/study`;
- lockouts and stops by reason;
- refusals and failures;
- ingest failures by source;
- an alert to the Operator if Proposals exceed 30 per rolling 24 h, argus is down, or `open` is ever above 1.

### Final report

The final check-in lists whole-run totals and a per-AC verdict table (AC1 to AC6).

### Check-in 2026-11-09T16:32Z (h0 baseline)

- Status: `dev:status` shows warroom running (pid 3396797, port 3100) and worker running (pid 3397022), "sleep lock: held (2 argus locks, handle-lid-switch:sleep)". PASS.
- Config: `[config]` line as quoted in Run start (judge_min_signals=2, judge_runs_24h=300, propose_new_24h=30, daily_quota_usd=20, research_share=0.3, api_fallback=off, telegram=off). PASS.
- PumpPortal: `[pumpportal] connect conn=1 open=1` and `[pumpportal] subscribe conn=1 streams=newToken,migration` present. PASS. Connect count 1, max open 1, reconnects 0.
- `[worker] Study started: capture tick every 10s, rule v1` present. PASS.
- Ticks: first tick 2026-11-09T16:28:34.799Z, last at check time 2026-11-09T16:31:45.001Z, every 5 s. No stack traces and no error lines in the first 3 min (only the startup SQLite ExperimentalWarning). PASS.
- HTTP via http://localhost:3100: `/` 200, `/study` 200, `/api/proposals` 200, `/api/research` 200. PASS.
- Ingest first tick: 17 sources, 0 new Signals; clustering waited for the semantic embedder (loaded Xenova/gte-small q8). Judge tick 0 scored; `propose: the daily cap of 30 new Proposals is reached; waiting` (`stopped: proposal-cap`) at the first tick: 30 Proposals (ids 40 to 69) were created in the 24 h before T0, so propose is capped until the oldest of them ages out (about 2026-11-09T19:25Z).
- Proposals by status: new 48, closed 21 (total 69). Rolling 24 h to T0: 30 (ids 40 to 69), at the cap, not above it.
- `/api/study` at baseline (all-time = last 24 h): seen 5607, out of scope 558, in population 1924, captured 1924, pending 4, missed 286 (58.1% of 492 migrations), late 0, capped 0, unreadable 3303, website fetched 548, empty shell 75 (13.7%), capture runs 24h 12167 of 20000.
- Lockouts and stops since T0: lockouts not yet counted (baseline); stops so far: `the daily cap of 30` x1.

Carried-over `new` Proposals for AC3: 48 (ids 22 to 69). Expected close = created_at + 48 h; the expiry job runs in the worker, so actual close may lag by a tick. Earliest expected close: Proposal 22 at 2026-11-09T19:02:17.932Z (2 h 33 min after T0). Latest: Proposal 69 at 2026-11-11T02:26:29.315Z.

| id | name | created_at (Z) | expected close (Z) |
|---|---|---|---|
| 22 | Coin Flip Playoffs | 2026-11-07T19:02:17.932 | 2026-11-09T19:02:17.932 |
| 23 | Spurs Night Watch | 2026-11-07T19:32:16.692 | 2026-11-09T19:32:16.692 |
| 24 | Duck Line Watch | 2026-11-07T19:32:22.585 | 2026-11-09T19:32:22.585 |
| 25 | Sunflower Showdown | 2026-11-07T20:32:05.539 | 2026-11-09T20:32:05.539 |
| 26 | Price Pinch Ledger | 2026-11-07T21:02:12.278 | 2026-11-09T21:02:12.278 |
| 27 | Ahsoka Delay Dial | 2026-11-07T21:02:27.519 | 2026-11-09T21:02:27.519 |
| 28 | Signal Check Krakow | 2026-11-07T22:02:22.196 | 2026-11-09T22:02:22.196 |
| 29 | Matriarch Moves | 2026-11-07T22:02:27.671 | 2026-11-09T22:02:27.671 |
| 30 | Tipoff Tracker | 2026-11-07T22:32:30.983 | 2026-11-09T22:32:30.983 |
| 31 | Podium Pending | 2026-11-07T22:32:46.541 | 2026-11-09T22:32:46.541 |
| 32 | Academy Kids Radar | 2026-11-07T23:02:15.667 | 2026-11-09T23:02:15.667 |
| 33 | Iowa Saturday Hawk Cyclone | 2026-11-07T23:02:21.617 | 2026-11-09T23:02:21.617 |
| 34 | Belt Watch | 2026-11-07T23:32:19.651 | 2026-11-09T23:32:19.651 |
| 35 | Possible Love Meter | 2026-11-08T00:02:11.829 | 2026-11-10T00:02:11.829 |
| 36 | Herod Court Ledger | 2026-11-08T00:02:17.444 | 2026-11-10T00:02:17.444 |
| 37 | Pineapple Tribunal | 2026-11-08T00:32:18.582 | 2026-11-10T00:32:18.582 |
| 38 | Ankle Watch | 2026-11-08T01:32:06.929 | 2026-11-10T01:32:06.929 |
| 39 | Second Act Scoreboard | 2026-11-08T02:02:25.936 | 2026-11-10T02:02:25.936 |
| 40 | Lights Out Seattle | 2026-11-08T19:25:06.871 | 2026-11-10T19:25:06.871 |
| 41 | Wild Thousand | 2026-11-08T19:25:12.917 | 2026-11-10T19:25:12.917 |
| 42 | Preload Lounge | 2026-11-08T19:25:25.420 | 2026-11-10T19:25:25.420 |
| 43 | Top 25 Tumble Tracker | 2026-11-08T19:55:12.691 | 2026-11-10T19:55:12.691 |
| 44 | Win Run Tracker | 2026-11-08T19:55:24.237 | 2026-11-10T19:55:24.237 |
| 45 | Bercy Bracket Buddy | 2026-11-08T19:55:37.177 | 2026-11-10T19:55:37.177 |
| 46 | Cop Tangible | 2026-11-08T20:25:05.982 | 2026-11-10T20:25:05.982 |
| 47 | Kickoff Compass | 2026-11-08T20:25:11.482 | 2026-11-10T20:25:11.482 |
| 48 | Lumen Lamp | 2026-11-08T20:25:37.011 | 2026-11-10T20:25:37.011 |
| 49 | Bracket Shift | 2026-11-08T20:55:23.824 | 2026-11-10T20:55:23.824 |
| 50 | Mini Menu Advent | 2026-11-08T20:55:34.324 | 2026-11-10T20:55:34.324 |
| 51 | Shake Check | 2026-11-08T20:55:40.488 | 2026-11-10T20:55:40.488 |
| 52 | Silicon Sentry | 2026-11-08T21:25:10.385 | 2026-11-10T21:25:10.385 |
| 53 | Hardwood Rhythm | 2026-11-08T21:25:24.158 | 2026-11-10T21:25:24.158 |
| 54 | Playoff Pitch | 2026-11-08T21:25:30.097 | 2026-11-10T21:25:30.097 |
| 55 | Vortex Watch | 2026-11-08T21:55:22.576 | 2026-11-10T21:55:22.576 |
| 56 | Paris Masters Pulse | 2026-11-08T22:25:06.723 | 2026-11-10T22:25:06.723 |
| 57 | Bottle Fine Meter | 2026-11-08T22:25:27.192 | 2026-11-10T22:25:27.192 |
| 58 | Cowboy Title Watch | 2026-11-08T22:55:31.611 | 2026-11-10T22:55:31.611 |
| 59 | Steph Ladder | 2026-11-08T22:55:57.719 | 2026-11-10T22:55:57.719 |
| 60 | Tall Rookie Watch | 2026-11-08T22:56:11.911 | 2026-11-10T22:56:11.911 |
| 61 | Memory Rosetta | 2026-11-08T23:25:11.750 | 2026-11-10T23:25:11.750 |
| 62 | Canes Eye Tracker | 2026-11-08T23:25:38.486 | 2026-11-10T23:25:38.486 |
| 63 | Maradona Matchday Board | 2026-11-08T23:25:56.675 | 2026-11-10T23:25:56.675 |
| 64 | SEC Payroll Watch | 2026-11-08T23:55:13.117 | 2026-11-10T23:55:13.117 |
| 65 | Grifone Rossonero | 2026-11-09T00:25:25.088 | 2026-11-11T00:25:25.088 |
| 66 | Steel Bye Week | 2026-11-09T00:25:38.146 | 2026-11-11T00:25:38.146 |
| 67 | Niner Report Desk | 2026-11-09T00:54:57.501 | 2026-11-11T00:54:57.501 |
| 68 | Santa Slay Meter | 2026-11-09T01:57:07.417 | 2026-11-11T01:57:07.417 |
| 69 | Marshals Clock | 2026-11-09T02:26:29.315 | 2026-11-11T02:26:29.315 |

tick-gaps output at this check-in (`node scripts/tick-gaps.mjs 2026-11-09T16:28:34.799Z`):

```
T0: 2026-11-09T16:28:34.799Z
Last tick: 2026-11-09T16:31:45.001Z
Total wall time: 0h03m10s
Gaps over 10 min: 0
Total downtime: 0h00m00s
Uptime: 0h03m10s
End (T0 + 48h + downtime): 2026-11-11T16:28:34.799Z (2026-11-11T13:28:34-03:00)
```
