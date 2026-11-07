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
