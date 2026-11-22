# 16: .env.example entries and `pnpm setup-check`, so the Operator's setup is hard to get wrong
**Model:** sonnet / medium — a small script with fakes-based tests and a docs edit.

**What to build:** Operator research needs no switch (ADR 0017), but it does need a logged-in Claude CLI, the Argus Chrome profile logged in to X, and a running worker. Today nothing says so in one place. Add the missing `.env.example` entries (`ARGUS_CLAUDE_BIN`, `ARGUS_CHROME_BIN`, `ARGUS_CHROME_DIR`, `ARGUS_DB`, and `ARGUS_RESEARCH_TICK` marked as the old loop to leave off) and a preflight, `scripts/setup-check.mjs` (package script `setup-check`, run as `pnpm setup-check`), that prints one PASS/WARN/FAIL line per check with a plain fix hint and exits 1 on any FAIL. Checks: Claude CLI found and logged in (`claude auth status --json`, no model call); Chrome profile directory; Chrome binary; X auth cookie present (read-only look at the profile's cookie store, Chrome not started, SingletonLock untouched, WARN when it cannot tell); database path; War Room (port 3100) and worker running (WARN, "run pnpm dev:start"); `ARGUS_RESEARCH_TICK=1` (WARN: starts the old automatic loop). It reads env as `pnpm dev:start` does and prints only paths and booleans.

**Blocked by:** none

**Status:** done

- [x] `.env.example` lists `ARGUS_CLAUDE_BIN`, `ARGUS_CHROME_BIN`, `ARGUS_CHROME_DIR` (with their defaults), `ARGUS_DB`, and `ARGUS_RESEARCH_TICK` ("old automatic judge+propose loop every 30 min; leave off; Operator research does not need it").
- [x] `pnpm setup-check` prints one PASS/WARN/FAIL line per check with a fix hint and exits 1 on any FAIL, 0 otherwise.
- [x] The Claude check makes no model call; the X login check starts no browser and does not touch the profile lock; no cookie value, token or env value is printed.
- [x] A not-running War Room or worker is a WARN with "run pnpm dev:start"; `ARGUS_RESEARCH_TICK=1` is a WARN.
- [x] Tests with fakes cover every check and the exit code (they fail without the change); temp dirs are removed.
- [x] The README setup steps mention `pnpm setup-check`.
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
- 2026-11-22 cos: merged d3e1d7e+58ccd6b, renamed to pnpm setup-check in f8e7102. Reviewer SHIP; verifier PASS (241/3886; real run paths/booleans only; bogus claude bin FAIL exit 1; cookie dir unchanged). Note: cookie no-new-files test also passes on d3e1d7e; proof is the real-profile before/after listing.
