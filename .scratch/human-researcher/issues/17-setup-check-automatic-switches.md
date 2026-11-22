# 17: `pnpm setup-check` warns on every automatic Claude switch, and sees the running War Room and worker from a worktree
**Model:** sonnet / medium — small change to the existing script, fakes-based tests.

**What to build:** Ticket 16's check only knew `ARGUS_RESEARCH_TICK`. ADR 0017's rule is that Claude runs only when the Operator triggers it, so `pnpm setup-check` must WARN for every automatic agent whose switch is on (research tick, meta meme ideas, moment scanner, and any added later). It takes the list, the labels and the on/off parsing from `packages/core/src/automatic-agents.ts` instead of hard-coding names. Message: "<label> is ON: Claude runs by itself (Operator rule: only when you trigger it). Remove <SWITCH> from .env". An invalid value FAILs, as the worker refuses to start on it. Bug: run from a git worktree, setup-check looked in the worktree's own empty `.data/run`, so it said "not running" for a worker that `pnpm dev:status` shows running; it now reads the main checkout's run dir and `.env` (`--root` still overrides).

**Blocked by:** 16

**Status:** open

- [ ] Every automatic switch that is on is a WARN with the message above; off or unset is PASS; an invalid value is a FAIL that does not hide the other switches.
- [ ] The switch list comes from `automatic-agents.ts` (a test fails if a switch there is not covered).
- [ ] From a git worktree, setup-check reports the War Room and worker of the main checkout as running when `pnpm dev:status` does (a test covers the root resolution).
- [ ] New tests fail on the parent commit; type-check, `pnpm lint` and `pnpm check` are green.

## Comments
