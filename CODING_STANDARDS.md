# Coding standards

Rules reviewers enforce. Invariants refer to `docs/architecture.md` §10.

1. **The worker is the only writer of state transitions.** The War Room and other callers write command rows to the datastore; only the worker applies them.
2. **No secrets in the repo or logs.** Credentials live in a gitignored `.env` (`.env.example` lists names only). Never log tokens or full environments. Build children get a scrubbed environment.
3. **Dry-run on anything that spends.** Brain runs, Builds, repo creation and deploys support `--dry-run` (log the command, spawn nothing) and the dry run is exercised before a real run.
4. **Caps are never silently raised.** Budget and wall-clock caps fail the run when hit. Raising one is an explicit, reviewed change (§10.3).
5. **Type-check and test once before committing.** Run `pnpm check` (typecheck, lint, tests) once before a commit, not after every edit.
6. **Ticks are re-entrancy guarded.** Any interval-driven loop is wrapped in `reentrant`.
7. **TypeScript strictness stays on.** `typescript` is pinned to an exact 7.x; typecheck is `tsc --noEmit --checkers 1`.
8. Dev processes: `pnpm dev:start` / `pnpm dev:stop` manage both the War Room (port 3100) and the worker, with pids and logs in `.data/run/`. Agents must never start either another way, except the worker's foreground `--once` mode, and must never leave one running; run `pnpm dev:stop` before finishing.
9. Boot verification: verifiers prove worker boot and shutdown with `pnpm verify:boot`, never hand-rolled shell.
10. `pnpm check` runs on every push through the pre-push hook. Never use `--no-verify`.
11. Tests run on at most 2 workers locally. Stress loops run one loop at a time, with no parallel suites.
