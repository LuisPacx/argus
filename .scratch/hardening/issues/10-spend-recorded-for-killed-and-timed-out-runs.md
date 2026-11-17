# 10: Spend recorded for killed and timed-out runs
**Model:** sonnet / effort: high — the recording change is small, but it touches every brain path, the budget SQL and the War Room card, and needs a real stream and transcript read to fix the parsing.

**Status:** done

## Problem

A `claude -p` run that is killed prints no final `result` message, so no `total_cost_usd` reaches argus and the run is recorded at $0. Real spend is missing from the Build's cost, from Est. usage in the War Room, and (for the paths below that are not already charged at a cap) from `ARGUS_DAILY_QUOTA_USD` accounting, the research share and the build cap ($25 `maxBudgetUsd` in `DEFAULT_ROUTING.build`).

Evidence:

- `brain.ts` `run()`: `const base = { sessionId: sessionIdOf(messages), totalCostUsd: msg?.total_cost_usd ?? 0, ...info }` (about line 469). The comment above it says so: "a killed run prints no result (spend unknown, so $0)". `timed-out` and `interrupted` `BrainError`s carry that `base`.
- Found 2026-11-17 while fixing the flake in ticket 09 (`build-runner-verify.test.ts`, "a Proposal dismissed during the run keeps its dismissal; the spend is still recorded"): when the dismissal poll killed the agent first, `totalCostUsd` was 0. Ticket 09's Comments note it was "not fixable without reading claude's session transcript" and left it to cos.
- The backlog note "spend edge cases (timed-out runs $0)" is the timeout half. Ticket 01 already made `Datastore.spendSince` charge `timed-out`, `interrupted`, `in-flight` and session-bearing `failed` research runs at the route cap; that is a ceiling, not the real cost, and it covers research tasks only.

## Every path that can end without a cost

How spend is recorded today: `brain.run` returns or throws with `totalCostUsd`; each caller writes it with `store.finishBrainRun` (judge.ts, propose.ts, meme/pass.ts, meta/group-pass.ts, meta/summary-pass.ts, spec-drafting.ts) or, for a Build, `recordBrainRunSpend` then `finishBrainRun` in `build-runner.ts` (`runEnd`, about lines 518-545, 762-771). Budget figures come from `Datastore.spendSince` (`datastore.ts` about 1906): reported cost, plus the route cap for research runs that ended with $0 and are `timed-out`, `interrupted`, `in-flight` or `failed` with a session.

| # | Path | Where | What is recorded now |
|---|------|-------|----------------------|
| 1 | Build agent killed by the dismissal poll (`dismissed.abort()` aborts `halt`, `build-runner.ts` about 686-694) | `brain.run` -> `interrupted` | $0; `abandon()` keeps `runEnd` cost = 0. No cap charge: `build` is not in `RunCaps`. |
| 2 | Build agent hits its 240 min wall-clock cap | `brain.exec` timer -> `timed-out` | $0; Build row `exit_status` `timed-out`; not charged at the $25 cap anywhere. |
| 3 | Build agent killed by worker shutdown (`killLiveBrainChildren` or aborted signal) | `interrupted` | $0, same as 1. |
| 4 | Build: worker dies mid-Build; startup recovery frees the slot (`datastore.ts` about 2125, "its spend is unknown") | row left `in-flight` | Whatever `recordBrainRunSpend` last wrote, normally 0 (it is only called after claude finishes). |
| 5 | Build: claude or the podman container crashes or is OOM-killed with no `result` | `brain.run` throws `failed` ("exited ... without a result") | $0. The podman client dying leaves the container; `stop` ends it, nothing reads its cost. |
| 6 | Build wall-clock kill or dismissal kill of the install and bundle containers | not brain runs | no cost (no model use); out of scope, listed so nobody looks for it. |
| 7 | judge, propose, meta-summary, meta-group, meme-ideas timed out (caps 5, 15, 3, 2, 5 min) | `timed-out` | $0 reported, but `spendSince` charges the route cap (0.10, 1, 0.05, 0.05, 0.30). Budget is safe; Est. usage shown is $0. |
| 8 | Same five, interrupted by shutdown, or left `in-flight` by a dead worker | `interrupted` / `in-flight` | same as 7. |
| 9 | Same five, claude crashes after starting (`failed` with a session) | `failed` | charged at cap (ticket 01); `failed` with no session charged $0 (claude never started: correct). |
| 10 | spec and spec-revise (`spec-drafting.ts`) timed out, interrupted, or cancelled by Undo shortlist (`BRAIN_RUN_CANCELLED`) | `timed-out` / `interrupted` / `cancelled` | $0, and `spec` is not in `RunCaps`, so not charged at its $2 cap either. Cancelled is excluded from the cap charge by design. |
| 11 | ApiBrain (`api-brain.ts`) call aborted or of unknown cost | `interrupted` / `failed` | already charged at its ceiling (`totalCostUsd: ceiling`). Not affected. |

Paths 1 to 5 and 10 are the real gaps (nothing counts them anywhere); 7 to 9 are covered by the cap but report $0 as Est. usage and charge a flat worst case. That is 10 affected paths (11 is the model to copy).

## What a killed run leaves behind

- **The session id.** `sessionIdOf()` already recovers it from the `system`/`init` message of the stream, for stream-json runs. Judge, propose, spec and the other research tasks run with `--output-format json` (the default), which prints one object at the end, so a killed one leaves no stdout and no session id; only the Build route sets `outputFormat: "stream-json"` (`brain.ts` about 162).
- **Per-turn usage in the stream (Build only today).** In `stream-json` every `assistant` message carries `message.id`, `message.model` and `message.usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`). `brain.exec` already collects stdout and passes it to `parseMessages`, and the runner tees every line to the Build log, so these events exist even when the child is killed. Not yet verified against a real capture: a message can appear more than once (one line per content block) with the same `message.id`, so usage must be de-duplicated by id, and sub-agent turns carry `parent_tool_use_id`.
- **The session transcript.** Claude Code writes `<config dir>/projects/<cwd with / and . replaced by ->/<session id>.jsonl`, one line per message with the same `usage` and `model`, flushed as it goes. For a Build the config dir is `CLAUDE_CONFIG_DIR=/home/agent/.claude` (`sandbox.ts` `containerEnv`, role `agent`), and `/home/agent` is the per-Build home mounted from the host (`buildHomeFor(dataDir, id)`, containment policy requires the `-v <home>:/home/agent:` mount), so the transcript is readable on the host after the container is killed. The home is kept when a Build fails; a dismissed Build's home is removed by `sweepDismissedHomes`, and a built Build's home is removed after success, so a read must happen before the sweep. For the non-Build tasks the brain runs `claude` on the host with the Operator's default config dir; the transcript is under `~/.claude/projects/` keyed by the throw-away working directory (or the stable `workDir` for spec), also on the host disk. Both need a real run to confirm the exact path and that usage lines are present for a killed session.
- **Prices.** There is a price table, but only for the API backend: `API_PRICES` in `api-brain.ts` (`inputPerMTok`, `outputPerMTok`, `maxPromptTokens`, haiku only: `claude-haiku-5-5`) and `costOf()` (cache write 1.25x input, cache read 1x input in that function). It has no sonnet entry and no cache-read discount, so it cannot price a Build as is. Token counts to USD need a per-model table (input, output, cache write, cache read) for the subscription models argus routes to (haiku, sonnet), kept in one place and checked against the `claude-api` skill, as `API_PRICES` is. The same prices give a check: for a run that does finish, the recomputed cost can be compared with `total_cost_usd` in a test.
- **Time and the cap.** Elapsed time (the row's `created_at` to `finished_at`) and the route's `maxBudgetUsd` are always known.

## Options

A. **Stream usage as it arrives and keep a running total.** Run every claude route with `--output-format stream-json --verbose`, sum de-duplicated `assistant` usage x price as lines arrive (`onOutput`), and on a kill put the running total in the `BrainError`. For the Build also call `recordBrainRunSpend` periodically so even a dead worker leaves a figure. Exact to within pricing accuracy; the mechanism is already there for the Build. Cost: the five research routes change output format (their parser, `parseResult`, already accepts stream-json) and need a price table.

B. **Read the transcript after the kill.** After a `timed-out`, `interrupted` or `failed` run with a session id, read `<config dir>/projects/*/<session>.jsonl`, sum usage x price. No change to the live path and works for json-format routes if the session id is known, but a json-format killed run has no session id (no init message), so it only helps stream routes unless the id is passed in (`--session-id <uuid>` chosen by argus before the run). Depends on Claude Code's on-disk format, which can change, and on the home still existing.

C. **Conservative estimate: elapsed x a rate.** Cost = elapsed minutes x a per-route rate, capped at `maxBudgetUsd`. Needs no parsing, but the rate is a guess (a minute of a Build can cost cents or dollars), so it over- or under-counts by a wide factor.

D. **Record "cost unknown" and charge a fixed worst case.** Store the run as unknown (not $0) and charge the route cap (`maxBudgetUsd`: $25 for a Build, $0.10 to $2 for the rest) against every cap. Simple and safe, and it is what research already does; for the Build $25 per kill would block the day's quota for one dismissed Proposal, which is likely too coarse.

## Recommendation

A for the Build (already stream-json, so no format change), with B as the fallback when the stream has no usage (no turn completed yet, or the worker died), and D as the last fallback when neither is readable. Every recorded cost carries a `cost_source` of `exact` (the result's `total_cost_usd`), `estimated` (summed usage x price, or transcript) or `unknown` (charged at the route cap). Research routes keep today's cap charge (path 7 to 9 are already safe for the budget) and take A only if the open question below says Est. usage accuracy for them matters; the minimum for them is to show their cap charge as "estimated" instead of $0.

## Decisions (the Operator, 2026-11-17)

These replace the open questions and override the Recommendation where they differ.

1. A Build killed with no recoverable usage is charged an elapsed-time estimate: run minutes x the average $/min of recent Builds, marked `estimated`. Never zero.
2. A Build's retries add up against its $25 cap, and every Build dollar counts toward the daily budget (`ARGUS_DAILY_QUOTA_USD`), not only the research share.
3. The research routes keep their route-cap charge (no switch to `stream-json`); the War Room shows it as `estimated`.
4. Price table (cos decision): one module in `packages/core` next to `API_PRICES`, covering every model used, with cache-read and cache-write rates.
5. Cancelled spec drafts (Undo shortlist) count against caps.

Open detail for the worker: what "recent Builds" means (last N Builds, or last 24 hours) and what the rate is when there are none; the acceptance criteria below require a stated default.

## Acceptance criteria

- [x] One price module in `packages/core` next to `API_PRICES` covers every model argus uses (input, output, cache write, cache read), with a test that an unknown model is refused loudly, not priced at 0, and that summing a captured finished run's usage reproduces its `total_cost_usd` within a stated tolerance
- [x] Build agent killed by the dismissal poll: a test (fake claude printing stream-json turns with usage, then killed) records a nonzero estimated cost on the run row and on the Proposal's cost; the existing `build-runner-dismiss.test.ts` "while claude runs" case asserts it
- [x] Build agent hits its wall-clock cap: a test records a nonzero estimated cost (or the explicit cap charge if no usage was streamed) and `exit_status` `timed-out`
- [x] Build agent killed by shutdown (`killLiveBrainChildren`): a test records the estimate
- [x] Build whose claude or container crashes without a result: a test records the estimate from the stream or the explicit fallback charge
- [x] Build left in flight by a dead worker: startup recovery records the last streamed total or the fallback charge, not 0
- [x] judge, propose, meta-summary, meta-group, meme-ideas: a test per task that a timed-out and an interrupted run records a nonzero cost or an explicit `unknown` charge at its route cap, and that `researchUsage` and the per-task daily caps count it
- [x] spec and spec-revise: a test that a timed-out or interrupted draft records an estimate or an explicit fallback charge, and a cancelled draft (Undo shortlist) is charged and counts against caps (decision 5)
- [x] A Build killed with no recoverable usage (killed before the first turn finished, or no stream) is charged run minutes x the average $/min of recent Builds, marked `estimated`, never $0; a test with a seeded history of Builds checks the figure
- [x] The elapsed-time estimate with no recent Builds to average uses a stated default $/min (a named constant, capped at the route's `maxBudgetUsd`), is marked `estimated`, and a test covers an empty history
- [x] A Build's retries sum against its $25 cap: a test where attempt 1 is killed with an estimate and attempt 2 runs shows the second gets only the remaining budget (or is refused at the cap), and the Proposal's total includes both
- [x] Every Build dollar (exact or estimated, every attempt) counts toward the daily budget, not only the research share: a test that a Build's cost raises the `ARGUS_DAILY_QUOTA_USD` figure
- [x] The research routes' cap charge shows as `estimated` in the War Room (not as $0 or as exact)
- [x] The daily-quota and research-share figures and the $25 build cap count recorded estimates (a test that a dismissed Build's estimate raises `usedUsd` / the Proposal cost)
- [x] The War Room shows exact vs estimated vs unknown cost on the Proposal card and the usage view (label or marker, e.g. "$0.42 est."), checked with `pnpm page:check` at 1240 and 390 px with the screenshots and exit code cited
- [x] The transcript or stream reader is confirmed once against a real killed `claude -p` run (path, line shape, de-duplication), and the capture is added as a fixture
- [x] `pnpm check` passes and stamps the committed tree

## Comments

- 2026-11-17 (worker, done): checked against real runs (claude 2.1.326). Findings that change the Recommendation: (1) the `stream-json` `assistant` event carries `message.id`, `message.model` and `message.usage`, one event per content block (de-dup by id), but its `output_tokens` is a start-of-message stub (16 and 1 for a run that printed 161): input and cache counts are exact, output is estimated from the content size (`run-cost.ts`). (2) A SIGKILLed run's transcript (`~/.claude/projects/<cwd>/<session>.jsonl`) has no assistant or `cost-state` lines (they are written lazily), so Option B is not viable; the stream (Option A) is the source, and the elapsed-time estimate (decision 1) the fallback. A finished session's transcript does end in a `cost-state` line with per-model `modelUsage`; a fit of 1763 of them gave the price table (sonnet $2/$10, cache read $0.10, 5 min write $2.50, 1 h write $4; haiku $0.10/$0.50/$0.01/$0.125/$0.20; opus 5.5 $4/$20/$0.20/$5/$8), matching the claude-api skill's input/output rates. Fixtures: `packages/core/src/fixtures/claude-stream-json-killed.jsonl` (real, SIGKILLed after its first turn) and `-finished.jsonl` (real, with its result: priced `modelUsage` reproduces `total_cost_usd` to 1e-7; the streamed figure is within 60-102% of it).
- Design: `model-prices.ts` (one table, loud on unknown models), `run-cost.ts` (stream pricing, elapsed estimate; default $25/240 min per minute, average of the last 10 exact Builds), `brain_runs.cost_source` (exact | estimated | unknown, migration backfills old rows; old data loads). A Build records the priced stream (also written to the row on each heartbeat, so a dead worker's sweep keeps it) or, with none, minutes (at least one) x the rate, capped at what the $25 cap still allows; the retry gets the remainder (none under $1, `MIN_RETRY_BUDGET_USD`). Research routes keep the cap charge in `spendSince` (now also for `cancelled`), shown as estimated; Spec drafts that were killed, timed out or cancelled are recorded at the route's cap. `researchUsage` gains `estimatedUsd`, `dailyUsedUsd` (every task incl. Builds). The War Room shows "est." / "+ unknown" / "reported" on the card, the Proposal's runs, Activity and the research bar; the page-check seed has one run of each kind. Not done (out of scope): the pipeline page's 24 h node figures still sum recorded cost only; Builds are counted in the daily figure but do not gate a Build's start.

- 2026-11-17: written from ticket 09's finding. Read from `packages/core/src/brain.ts`, `build-runner.ts`, `datastore.ts` (`spendSince`), `research-budget.ts`, `sandbox.ts`, `api-brain.ts`. The stream and transcript facts above are from Claude Code's documented formats, not yet confirmed against a real killed run; the last two acceptance boxes exist for that.
