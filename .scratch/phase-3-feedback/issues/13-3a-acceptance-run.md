# 13: 3a acceptance run (14 days)
**Model:** sonnet / medium — checks evidence against a fixed list and writes it up.

**What to build:** The Operator gets a written record that 3a is done, or a list of what failed. The Study runs 14 days unattended with every 3a part switched on; afterwards each item of the 3a done signal is checked with evidence, and the first real Playbook review takes place in the War Room. If the X spike ruled X out of 3a, the X capture job is left out of the run and the record says so.
Spec: sections 12, 15 (slice 12).

**Blocked by:** 04 Bot-filter raw metrics and the Organic migration label; 06 X capture job; 07 Cases, Cohorts and the blind study Brain task; 08 Lesson aggregation, the Playbook and the weekly review page; 09 Playbook into the prompts; 10 Own-launch tracking (06 drops out if ticket 05 rules X out of 3a)

**Status:** ready-for-agent

- [ ] The run covers 14 days with no operator action beyond known setup; any intervention is logged with its reason
- [ ] Evidence for daily Snapshots and for chain labels written at 24h and 7d on those days
- [ ] At least 50 migrator Cases and 50 control Cases with final labels, produced within the cap of 100 Study runs per day, with the counts quoted
- [ ] The first Playbook review took place in the War Room, with a screenshot or stored review record
- [ ] At least one approved lesson is visible as a Playbook version on a stored Score or Proposal
- [ ] Study health is reported: missed-create rate, empty-shell share, late migrators, Helius credits against budget, X captures and stops, run cap use
- [ ] Nothing in the run posted from the X account, spent beyond the caps, or called the API for study runs (checked from stored records)
- [ ] The record lists failed or marginal items and says plainly whether 3a is done; it is saved in the phase-3-feedback directory
- [ ] The run and the review use --dry-run first for any new spending step
