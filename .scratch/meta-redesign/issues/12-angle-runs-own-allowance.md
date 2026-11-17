# 12: Operator angle runs get their own daily allowance
**Model:** sonnet / medium. One new brain_runs column, one count split in `mayRun`, one message. Not opus: the size was decided in ticket 11's grilling.

**What to build:** an Operator angle run no longer shares the regular meme cap (8 runs a day). It counts against its own allowance, so an angle is not blocked when the automatic runs used up the 8, and automatic runs cannot spend the angle allowance. Requested by the Operator on 2026-11-17.

**Status:** done

**Blocked by:** none (follows ticket 11).

## Problem and evidence

- Ticket 11 made angle runs share the cap: `ANGLE_EXTRA_DAILY_MEME_RUNS = 0` and `dailyMemeRunLimit()` in `packages/core/src/meme/pass.ts`. `mayRun` counts every `meme-ideas` run from `memeIdeasSpendSince`, so 8 automatic runs end an angle request `capped` ("daily cap of 8 meme-ideas runs reached") even though the Operator, not a trigger, asked for it.
- `brain_runs` has no mark that tells an angle run from an automatic one (a refused run has no Proposal), so the two cannot be counted apart today.

## Design

- Size (ticket 11, Decision 3): **5 angle runs per rolling 24 h, hard ceiling 10**, one request pending at a time (already enforced at request time; unchanged). The retry for a copied name is a run and counts.
- `brain_runs` gets an additive column `angle` (INTEGER NOT NULL DEFAULT 0), set to 1 by an angle job's runs (`startBrainRun` takes `angle`). Old rows read 0.
- `mayRun`: an angle job counts only angle runs against the angle allowance; an automatic job counts only non-angle runs against the regular cap. The research budget stays shared and untouched.
- `ANGLE_EXTRA_DAILY_MEME_RUNS` is replaced by `DEFAULT_ANGLE_DAILY_MEME_RUNS = 5` and `MAX_ANGLE_DAILY_MEME_RUNS = 10`; `dailyMemeRunLimit(kind, maxRunsPerDay)` stays the one place that says the limit.
- The capped detail on the request names which cap: `angle allowance of 5 meme-ideas runs a day reached ...` versus the regular `daily cap of 8 meme-ideas runs reached ...`. The War Room shows the request detail as it is, so the page needs no change.

## Acceptance criteria

- [x] An angle run is recorded with `angle = 1` and is counted by the angle allowance, not by the regular 8 (test fails on the parent commit).
- [x] With 8 automatic runs in 24 h an angle request still runs; with 5 angle runs it ends `capped` with the angle message and no Brain call.
- [x] 8 regular runs plus angle runs: an automatic job is still stopped at 8 and angle runs do not move that count; regular runs cannot use the angle allowance (an automatic job is not stopped or allowed by angle runs, and 5 angle runs do not stop an automatic run).
- [x] The capped message tells the two caps apart (regular: "daily cap of 8"; angle: "angle allowance of 5").
- [x] Old DBs without the column open and read; the pipeline graph lists the new constants in place of the old one.
- [x] `pnpm check` passes once before the commit.

## Constraints

- Do not touch build-runner or the research-budget code. No new env knob.
- Follow `docs/agents/worker-rules.md` and `CODING_STANDARDS.md`.
