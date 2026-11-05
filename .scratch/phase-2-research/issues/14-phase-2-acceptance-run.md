# 14: Phase 2 acceptance run
**Model:** sonnet / medium — runs the definition of done live and records evidence; the Operator is present.

**What to build:** Run argus for 48 hours unattended against live Sources and check the Phase 2 definition of done in architecture §12.

**Blocked by:** 01 to 13, Phase 1 ticket 10 (Phase 1 acceptance run)

**Status:** ready-for-agent

- [ ] Over 48 hours unattended, argus produces at most 10 Proposals per day from live Sources
- [ ] Every card shows all the fields listed in architecture §8
- [ ] Stale Proposals close on schedule
- [ ] A forced subscription exhaustion switches `judge` and `propose` to the API while Builds wait, and API spend stays under its daily cap
- [ ] A Proposal goes from card to marked launched using only the War Room and newpairspam
- [ ] The evidence (logs, counts, Est. usage and API spend, screenshots) is recorded in this ticket
