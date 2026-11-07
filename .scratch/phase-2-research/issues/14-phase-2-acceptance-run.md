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
