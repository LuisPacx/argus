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
9. Boot verification: verifiers prove worker boot and shutdown with `pnpm verify:boot`, never hand-rolled shell. Verifiers prove a commit's new tests fail on its parent with `pnpm verify:parent <sha>` (parent failures are the expected result).
10. `pnpm check` runs on every push through the pre-push hook. Never use `--no-verify`.
11. Tests run on at most 2 workers locally. Stress loops run one loop at a time, with no parallel suites.
12. Every War Room command type and mutating route has an endpoint-level test that calls the real route handler with the exact payload the UI sends (see `apps/warroom/server/test/routes.test.ts`); core-level tests alone don't count.
13. **Build agent output is untrusted input.** Anything the build agent can write (files in the built repo such as `wrangler.jsonc`, `.git/config`, hooks and attributes, the result markers, and anything under the template) is attacker-controlled. argus regenerates what it acts on (argus writes the deploy config itself; git runs with no repo config and pushes from a fresh clone) or validates it against a strict schema. It never parses agent files with a regex and never uses them as-is with Operator credentials. Any tool run with Operator credentials (wrangler, gh, git and the like) runs with its cwd in an argus-owned directory, never inside the agent's repo, and with config and env-file discovery disabled or pointed at argus-owned files, since such tools load `.env`, config and hooks from the cwd.
14. **Timing-sensitive tests must pass under load from other projects on the same machine.** Give multi-step tests an explicit timeout rather than the 5 s default. Kill leftover processes by PID, never by name pattern.
15. **Test helpers must not locate shared state through environment variables.** Registries, temp roots and lock files must not be found through variables a child process may lose or see differently, such as `TMPDIR` or `HOME`. Resolve such paths from a fixed location, e.g. the helper's own file location.
16. **Tests never start the real `claude`.** A test that starts the worker passes a fake as `ARGUS_CLAUDE_BIN` (`fakeClaudeBin` in `packages/core/src/testing/fake-claude.ts`), and a test that builds a `ClaudeCodeBrain` passes `command: FAKE_CLAUDE`. The vitest globalSetup puts a tripwire `claude` first on PATH; any call to it fails the run and names the arguments.
