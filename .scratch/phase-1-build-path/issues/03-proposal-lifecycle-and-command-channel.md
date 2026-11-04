# 03: Proposal lifecycle and the command channel
**Model:** sonnet / high — the single-writer state machine every later ticket relies on.

**What to build:** The Operator clicks shortlist, or dismiss with a reason, on a card. The War Room records a command, the worker applies it through the lifecycle module, and the card shows the new status within a tick. The lifecycle module encodes every transition in §3 as data and rejects illegal ones. `approve(proposalId)` exists as the single approval function (§1); the UI uses it from ticket 05.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Lifecycle module has a transition table covering every transition in §3; tests assert each legal transition and reject illegal ones (e.g. new -> approved, anything out of closed)
- [ ] Every status change is recorded with time, actor (operator, system or build) and reason
- [ ] The War Room writes command rows only; the worker is the sole writer of status (enforced by structure or test)
- [ ] Commands are applied idempotently; an illegal command is marked rejected and its error shows in the War Room
- [ ] Shortlist and dismiss-with-reason work from the card; dismiss is reachable from every state except closed
- [ ] `approve(proposalId)` is exported as the single approval path and tested
- [ ] `pnpm check` passes
