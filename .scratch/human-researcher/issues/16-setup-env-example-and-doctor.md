# 16: .env.example entries and `pnpm run doctor`, so the Operator's setup is hard to get wrong
**Model:** sonnet / medium — a small script with fakes-based tests and a docs edit.

**What to build:** Operator research needs no switch (ADR 0017), but it does need a logged-in Claude CLI, the Argus Chrome profile logged in to X, and a running worker. Today nothing says so in one place. Add the missing `.env.example` entries (`ARGUS_CLAUDE_BIN`, `ARGUS_CHROME_BIN`, `ARGUS_CHROME_DIR`, `ARGUS_DB`, and `ARGUS_RESEARCH_TICK` marked as the old loop to leave off) and a preflight, `scripts/doctor.mjs` (package script `doctor`, run as `pnpm run doctor` because a bare `pnpm doctor` is pnpm's own command), that prints one PASS/WARN/FAIL line per check with a plain fix hint and exits 1 on any FAIL. Checks: Claude CLI found and logged in (`claude auth status --json`, no model call); Chrome profile directory; Chrome binary; X auth cookie present (read-only look at the profile's cookie store, Chrome not started, SingletonLock untouched, WARN when it cannot tell); database path; War Room (port 3100) and worker running (WARN, "run pnpm dev:start"); `ARGUS_RESEARCH_TICK=1` (WARN: starts the old automatic loop). It reads env as `pnpm dev:start` does and prints only paths and booleans.

**Blocked by:** none

**Status:** open

- [ ] `.env.example` lists `ARGUS_CLAUDE_BIN`, `ARGUS_CHROME_BIN`, `ARGUS_CHROME_DIR` (with their defaults), `ARGUS_DB`, and `ARGUS_RESEARCH_TICK` ("old automatic judge+propose loop every 30 min; leave off; Operator research does not need it").
- [ ] `pnpm run doctor` prints one PASS/WARN/FAIL line per check with a fix hint and exits 1 on any FAIL, 0 otherwise.
- [ ] The Claude check makes no model call; the X login check starts no browser and does not touch the profile lock; no cookie value, token or env value is printed.
- [ ] A not-running War Room or worker is a WARN with "run pnpm dev:start"; `ARGUS_RESEARCH_TICK=1` is a WARN.
- [ ] Tests with fakes cover every check and the exit code (they fail without the change); temp dirs are removed.
- [ ] The README setup steps mention `pnpm run doctor`.
- [ ] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
