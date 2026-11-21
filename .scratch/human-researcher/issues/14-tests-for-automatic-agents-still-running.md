# 14: Tests that the automatic agents still run
**Model:** sonnet / medium — tests with fakes, no behaviour change expected.

**What to build:** Ticket 01 added switches that turn off the agents that no longer run by themselves (ADR 0017), and left one box open: proof that the agents which are still automatic keep running on their schedules with the new switches at their defaults. Add that proof. Ranking of Metas, ingest, counting for the radar, Meta grouping, Meta summaries and radar naming must each still be started by their schedule when nothing is switched. The radar is not exercised by a test today, and Meta grouping and Meta summaries are only asserted in the default configuration, not shown to run. The tests use fakes for the model and the data sources and make no live call. If a test finds one of these not running, that is a bug to fix in the same ticket and to say so in its comment.

**Blocked by:** none

**Status:** ready-for-agent

- [ ] With the switches at their defaults, a scheduled tick runs Meta ranking and ingest, each shown by its effect on a test database (tests with fake sources); radar counting runs when ARGUS_RADAR=1 (its default stays off), shown by its readings in the test database.
- [ ] With the defaults, a scheduled tick runs Meta grouping and Meta summary, each shown by a call to a fake Brain and by its stored result (tests, no live model call). Radar naming (radar-name) is not built yet (trend-radar ticket 04) and is tested there.
- [ ] The agents ADR 0017 turned off (Proposal ideas, Spec and the rest named by ticket 01) still do not run on a tick at the defaults, in the same test run, so the two sets are checked together.
- [ ] The tests fail if a schedule entry for one of the automatic agents is removed or its switch default is flipped (checked once by hand and noted in the ticket comment).
- [ ] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
