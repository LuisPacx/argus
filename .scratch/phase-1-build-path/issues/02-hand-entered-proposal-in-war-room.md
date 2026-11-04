# 02: Hand-entered Proposal visible in the War Room
**Model:** sonnet / medium — standard datastore plus UI slice.

**What to build:** The Operator opens the War Room, enters a Proposal by hand (Narrative summary, Tech one-liner, why now, name, ticker, description, evidence links) and sees it in the Proposal list as a card and in a details view, with status `new`. The datastore is SQLite via `node:sqlite` in WAL mode with additive idempotent migrations (helios `ensureColumn` pattern, §9 and §11), shared by the worker and the War Room. Creating a Proposal is an insert, not a status transition; status changes belong to ticket 03.

**Blocked by:** 01

**Status:** ready-for-agent

- [x] Datastore opens the database under `.data/` in WAL mode; migrations are additive and idempotent (running them twice is a no-op, tested)
- [x] Proposals table holds the hand-entered fields, status, slug and timestamps
- [x] War Room form creates a Proposal with status `new`
- [x] List shows cards with the §8 fields that exist in Phase 1 (summary, Tech, why now, name and ticker, evidence links, status, agent cost); research-only fields (Score bars, collision checks, Narrative age) are absent or shown as n/a
- [x] Details view shows every stored field
- [x] `.vue` files are type-checked: the War Room alone adds an exact-pinned `typescript@5` devDependency and runs `vue-tsc --noEmit` against the Nuxt-generated tsconfig as part of its typecheck (inside `pnpm check`), next to the TS7 `tsc` check; a new ADR in `docs/adr/` records this as the single exception to the TypeScript 7 convention and drops it once vue-tsc supports TS7; a deliberate type error in a `.vue` file is shown to fail `pnpm check`, then reverted
- [x] Tests cover datastore create and read; `pnpm check` passes
