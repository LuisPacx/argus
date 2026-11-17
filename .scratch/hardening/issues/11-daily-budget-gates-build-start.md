# 11: The daily budget gates the start of a Build
**Model:** sonnet / effort: medium — one gate in `runNextBuild`, one new refusal code and one store query; the War Room reuses the existing "Build blocked" marker and notice.

**Status:** open

## Problem

Hardening ticket 10 made every Build dollar count toward the daily budget (`ARGUS_DAILY_QUOTA_USD`, `researchUsage().dailyUsedUsd`), but only for display. Nothing stops a new Build from starting when the day's budget is already used up. The Operator's decision: the daily budget gates Builds.

## Decisions (the Operator and cos, 2026-11-17)

- Gate only the START of a Build (`runNextBuild`, before the slot is taken). A retry inside a running Build is unchanged: it stays under the per-Build $25 cap and `MIN_RETRY_BUDGET_USD` (1).
- When the daily budget is used up (`dailyUsedUsd >= ARGUS_DAILY_QUOTA_USD`), the Build waits. It is not failed: the Proposal stays `approved` and starts by itself on a later tick when the window has room.
- The window is the one `research-budget.ts` already defines: a rolling 24 hours (not a calendar day), counted from each run's start (`brain_runs.created_at`). The expected start is the earliest moment at which, with the oldest runs aged out of that window, the daily figure is under the quota; null when it cannot be known.
- The War Room shows why, and when, with the existing refusal path: a new `daily-budget` code in `BuildRefusal`, so the Proposal page's "Build blocked" marker and notice carry the message ("Build not started: the daily budget is used up ... about 14:05 UTC"). No new UI pattern.
- The default config applies when the runner is given none (`DEFAULT_RESEARCH_BUDGET_CONFIG`); the worker passes the same `ARGUS_DAILY_QUOTA_USD` it gives research.

## Acceptance criteria

- [ ] With the daily figure at or above the quota, `runNextBuild` starts nothing: the Proposal stays `approved`, no brain run is opened, and the stored refusal has code `daily-budget` and a message with the used and quota dollars and the expected start time (a test, failing on the parent commit)
- [ ] A Build below the quota still starts as before
- [ ] When the oldest run ages out of the rolling 24 h window and the figure falls under the quota, the next call starts the Build by itself and clears the refusal (a test with an injected clock)
- [ ] The expected start time is the first moment the window is under the quota (a test with several runs), and is omitted from the message when unknown
- [ ] A retry inside a running Build is not gated (the existing retry tests still pass unchanged)
- [ ] The worker passes its research config to the Build runner
- [ ] The Proposal page shows the message through the existing "Build blocked" marker and notice (no War Room code change; the server test types the new code)
- [ ] `pnpm check` passes and stamps the committed tree

## Comments
