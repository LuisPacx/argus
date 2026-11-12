# 22: Judge only Narratives backed by 2 or more Signals; raise the judge cap to 300 per 24 h
**Model:** sonnet / medium — one SQL condition, two named config values, tests.

**What to build:** In the P2-14 acceptance run the judge cap (150 runs per rolling 24 h) was always exhausted and about 1015 Narratives were never scored, so research stalled (see `.scratch/cos.md`, 2026-11-08). Operator decision 2026-11-08: (a) judge only Narratives backed by at least 2 Signals; a single-Signal Narrative is skipped, not scored, starts no run and so never counts against the cap, and becomes eligible once it gains a second Signal; (b) raise the judge run cap from 150 to 300 per rolling 24 h. Unchanged: `ARGUS_DAILY_QUOTA_USD` $20 with the 0.3 research share, API fallback off, the propose lockout rule, the $2 judge daily spend cap.

**Status:** done (4d4683b on main)

## Where it lives

- `packages/core/src/judge.ts`: `DEFAULT_JUDGE_MIN_SIGNALS = 2`, `DEFAULT_JUDGE_RUNS_PER_DAY = 300`, `JudgeConfig.minSignals`; env overrides `ARGUS_JUDGE_MIN_SIGNALS` and the existing `ARGUS_JUDGE_MAX_RUNS_PER_DAY` (same positive-whole-number rules).
- `packages/core/src/datastore.ts` `narrativesToJudge(..., minSignals)`: `n.signal_count >= ?` in the candidate query. The datastore default is 1; the judge passes its config.
- War Room Activity page: a single-Signal Narrative with no Score reads "skipped: ..." instead of "not judged yet". Skipped Narratives have no `brain_runs` row, so no run status shows a failure.

## Acceptance criteria

- [x] Minimum Signal count and run cap are named, documented config values with env overrides, not magic numbers.
- [x] Candidate selection excludes a 1-Signal Narrative and includes it once it has 2 (test).
- [x] The default cap is 300, and skipped Narratives start no run and use none of it (tests).
- [x] A skipped Narrative leaves no `brain_runs` row, so it is not counted as a failure; the Activity page says it is skipped.
- [x] `.env.example` and `docs/architecture.md` state the new values; no GLOSSARY term changes.
- [x] `pnpm check` passes.

## Comments
