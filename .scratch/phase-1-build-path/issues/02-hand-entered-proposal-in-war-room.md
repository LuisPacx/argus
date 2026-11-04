# 02: Hand-entered Proposal visible in the War Room
**Model:** sonnet / medium — standard datastore plus UI slice.

**What to build:** The Operator opens the War Room, enters a Proposal by hand (Narrative summary, Tech one-liner, why now, name, ticker, description, evidence links) and sees it in the Proposal list as a card and in a details view, with status `new`. The datastore is SQLite via `node:sqlite` in WAL mode with additive idempotent migrations (helios `ensureColumn` pattern, §9 and §11), shared by the worker and the War Room. Creating a Proposal is an insert, not a status transition; status changes belong to ticket 03.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Datastore opens the database under `.data/` in WAL mode; migrations are additive and idempotent (running them twice is a no-op, tested)
- [ ] Proposals table holds the hand-entered fields, status, slug and timestamps
- [ ] War Room form creates a Proposal with status `new`
- [ ] List shows cards with the §8 fields that exist in Phase 1 (summary, Tech, why now, name and ticker, evidence links, status, agent cost); research-only fields (Score bars, collision checks, Narrative age) are absent or shown as n/a
- [ ] Details view shows every stored field
- [ ] Tests cover datastore create and read; `pnpm check` passes
