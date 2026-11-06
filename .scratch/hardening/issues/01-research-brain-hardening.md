# 01: Research brain hardening (judge, propose, narratives, embedder)
**Model:** sonnet / medium — several small, separate fixes in the research path.

**What to build:** Close these gaps found in review of Phase 2. Read each cited place first; add a failing test before each fix.

1. **Judge poison Narrative.** A Narrative whose judge run always times out stays eligible and, through the consecutive-failure backoff, can starve the pass. After N consecutive `timed-out` runs for the same Narrative (N a config constant, default 3), skip it until it changes materially (like a refused answer). Count from `brain_runs` (task `judge`, `narrative_id`), not memory, so it survives restarts. Same check in the propose pass if it has the same shape.
2. **Failed runs that have a session are charged $0.** `Datastore.spendSince` charges `timed-out`, `interrupted` and `in-flight` runs at the route cap, but a plain `failed` row that has a `session_id` (claude ran, then failed without printing a cost) is charged $0. Charge those at the cap too. Keep a `failed` row with no session (claude never started) at $0. (The "timed-out runs record $0" item is already fixed by 47737a8 and is not part of this ticket.)
3. **Propose spend gaps.** Check that the propose pass and the collision retry book each run through the same charge rule (item 2) and the research budget, and that a restart cannot re-draft or re-run past the daily run and spend caps; add tests for any path that is not covered.
4. **Shutdown check in `clusterNewSignals`.** Pass the worker's `AbortSignal` and check it before each Signal's embed, so a shutdown does not wait for a whole batch. Stop cleanly with the Signals already clustered kept.
5. **First tick blocks ingest on model downloads.** On a cold start, the semantic embedder can block the tick on up to 4 downloads of 15 minutes each. Make ingest run independently of the model download (start the download in the background or after ingest), with clustering skipped until the model is ready, logged once.
6. **onnxruntime-web (139MB).** Try a pnpm override that drops `onnxruntime-web` (node runtime only needs `onnxruntime-node`). Keep it only if `pnpm check`, `pnpm verify:boot` and the semantic embedder test still pass and the install shrinks; otherwise record the result in the ticket Notes and leave it out.

**Files:** `packages/core/src/judge.ts`, `packages/core/src/propose.ts`, `packages/core/src/datastore.ts` (`spendSince` and the run-count query only), `packages/core/src/narratives.ts`, `apps/worker/src/semantic-embedder.ts`, `apps/worker/src/main.ts` (clustering and model start only), `pnpm-workspace.yaml` / root `package.json`, and their tests.

**Blocked by:** none. Shares `apps/worker/src/main.ts` and `datastore.ts` with ticket 02 (different regions); merge one after the other.

**Status:** done

- [x] A Narrative with N consecutive judge timeouts is skipped until it changes materially; a test proves the pass moves on to the next Narrative
- [x] A `failed` run with a `session_id` and no cost is charged at the route cap in `spendSince`; one without a session stays $0; tests for both
- [x] The propose pass and collision retry are covered by tests for the charge rule and the daily caps across a restart
- [x] `clusterNewSignals` checks the shutdown signal per Signal; a test aborts mid-batch
- [x] A cold start does not hold ingest behind model downloads; a test with a slow fake download
- [x] The onnxruntime-web override is applied and verified, or the finding is recorded in Notes
- [x] `pnpm check` passes

## Notes

- Item 1: `JudgeConfig.maxConsecutiveTimeouts` and `ProposeConfig.maxConsecutiveTimeouts` (default 3); `narrativesToJudge` / `narrativesToPropose` take it and leave out a Narrative whose last N runs since its last material change (judge) or latest Score (propose) all timed out. Counted from `brain_runs`.
- Item 3: the propose pass and the collision retry already booked every run through the same `spendSince` and research budget; the gap was missing tests (retry timed out charged at cap, runs and crashed in-flight rows counted across a restart, the 10 Proposal cap across passes). No code change was needed there.
- Item 5: `lazyEmbedder` is replaced by `backgroundEmbedder`: `current()` never waits, starts the download after the first ingest, logs the skip once. `--once` waits for the model after ingest.
- Item 6: applied as `overrides: "@huggingface/transformers>onnxruntime-web": "-"` in `pnpm-workspace.yaml`. A bare `onnxruntime-web: "-"` is not enough on its own, and pnpm only re-resolved after `node_modules/.pnpm-workspace-state-v1.json` was deleted. The install drops 16 packages (onnxruntime-web alone is 140 MB). Verified: `pnpm verify:semantic` (real cached model, worst cosine 1.00000), `pnpm verify:boot` PASS, `pnpm check` green.
