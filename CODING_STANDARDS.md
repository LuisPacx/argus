# Coding standards

Rules reviewers enforce. Invariants refer to `docs/architecture.md` §10.

1. **The worker is the only writer of state transitions.** The War Room and other callers write command rows to the datastore; only the worker applies them.
2. **No secrets in the repo or logs.** Credentials live in a gitignored `.env` (`.env.example` lists names only). Never log tokens or full environments. Build children get a scrubbed environment.
3. **Dry-run on anything that spends.** Brain runs, Builds, repo creation and deploys support `--dry-run` (log the command, spawn nothing) and the dry run is exercised before a real run.
4. **Caps are never silently raised.** Budget and wall-clock caps fail the run when hit. Raising one is an explicit, reviewed change (§10.3).
5. **Type-check and test once before committing.** Run `pnpm check` (typecheck, lint, tests) once before a commit, not after every edit.
6. **Ticks are re-entrancy guarded.** Any interval-driven loop is wrapped in `reentrant`.
7. **TypeScript strictness stays on.** `typescript` is pinned to an exact 7.x; typecheck is `tsc --noEmit --checkers 1`.
8. Dev servers: start the War Room only with `pnpm dev:start` (port 3100; pid and log in `.data/run/`), and run `pnpm dev:stop` before finishing. Never leave a dev server running and never start one any other way.
