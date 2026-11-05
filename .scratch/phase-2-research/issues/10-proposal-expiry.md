# 10: Proposal expiry
**Model:** sonnet / medium — scheduled transitions through the existing lifecycle.

**What to build:** Stale Proposals close on schedule on the worker tick, per the expiry rules in architecture §3 (only `new` and `shortlisted` expire, after 48 hours and 7 days; `spec-drafted` never does). The card shows the time left.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Expiry follows architecture §3 and goes through the lifecycle with the system actor and a recorded reason
- [ ] A Proposal with a Brain run in flight is never expired mid-run; tested
- [ ] The card shows the time left before expiry
- [ ] Tests use a fake clock
- [ ] `pnpm check` and `pnpm verify:boot` pass
