# 09: Dismissing a Proposal stops its running Build
**Model:** sonnet / high. The change is concurrency between the build tick and the command tick, next to code that deletes real Cloudflare Workers and GitHub repos.

**What to build:** dismissing a `building` Proposal aborts its Build at the next safe point. No deploy and no GitHub repo creation may run after the dismissal. The run closes as aborted or interrupted, and the page says so. Also, a re-queue and a clean-up for the same Proposal can never run at the same time.

**Status:** done; browser check by cos still open

**Blocked by:** none. Interplay: this ticket touches `build-runner.ts`, `lifecycle.ts` and `cleanup-build.ts`. Run it after the `pnpm check` speed-up branch (test files only) is merged, or in a worktree.

## Problem (found in the 2026-11-12 review of ticket 07)

- `building -> dismissed` is a legal transition. It is listed as DISMISSIBLE in `packages/core/src/lifecycle.ts`. But dismissing does not stop the running Build. The runner checks the Proposal status only at a few points, and `build-runner.ts` removes the Build home only when the Build ends.
- So a dismissed Proposal can still deploy a Cloudflare Worker and create a GitHub repo after the Operator dismissed it.
- Ticket 07 now refuses clean-up while a `build` brain run is in flight. Nothing is deleted from under the Build, but the Build itself keeps going.

## A second race that nobody has checked

A re-queue (`build-failed -> approved`) can overlap a clean-up that is being applied for the same Proposal. The clean-up runs in `runPendingCleanups` in `packages/core/src/cleanup-build.ts`. `buildTick` and the tick that runs clean-ups are separate loops (`apps/worker/src/main.ts`, about lines 183-201), so nothing stops the two from running together today.

## What is there today

- `packages/core/src/lifecycle.ts` lists DISMISSIBLE, which allows `building -> dismissed`.
- `packages/core/src/build-runner.ts` checks the status at a few points only, and removes the Build home only when the Build ends.
- `packages/core/src/cleanup-build.ts` holds `runPendingCleanups`. Ticket 07 added the refusal while a `build` run is in flight.
- `apps/worker/src/main.ts` runs `buildTick` and the clean-up tick in separate loops.

## What to build

- Dismissing a `building` Proposal aborts its Build at the next safe point, before any deploy or repo creation step.
- After the dismissal, no deploy step and no repo creation step runs for that Proposal.
- The run closes as aborted or interrupted, and the Proposal page says so in plain words.
- A re-queue and a clean-up for the same Proposal can never run at the same time.
- The implementer picks the mechanism (for example a lock, a status check inside the clean-up, or a guard in the re-queue) and records the choice in the Comments.
- No token or secret may appear in any new log line or row.

## Acceptance

- [x] A test for dismiss-while-building shows that no deploy step and no repo creation step runs after the dismissal.
- [x] The run is closed as aborted or interrupted, and ticket 07's clean-up then works on what was created before the abort.
- [x] A test for re-queue against an applying clean-up shows the two never run at the same time.
- [x] No token appears in any new log line or row.
- [x] `pnpm check` passes.
- [ ] A browser check by cos, with the result cited in Comments.

## Interplay

- **Ticket 07** (Clean up build) owns the clean-up and its refusal while a `build` run is in flight. This ticket must keep that refusal working.
- **Glossary:** say "Build", "Proposal" and "Operator" as the code does.

## Commits

One commit, after a full `pnpm check`. Subject `War Room ticket 09: dismissing a Proposal stops its running Build`, body ending with `Ticket: .scratch/warroom-redesign/issues/09-dismiss-stops-a-running-build.md` before the trailers. Tick the boxes in the commit only if the full check does not stamp the tree afterwards, otherwise in a follow-up docs commit. No `Closes #N`: this repo has no GitHub issues.

## Comments

Implemented (commit f89a1fd; `pnpm check` passed, stamped tree 7d8e2f01bb; the first run failed only on the 300 ms timing bound of `meta/theme.test.ts`, 306 ms while another worker's check shared the machine; it passes alone and on the rerun). Mechanisms chosen:

- **Abort.** `attempt()` in `build-runner.ts` checks the Proposal is still `building` in `step()` and before every container launch and before the claude run, in the same tick as the spawn, so no `gh repo create`, `wrangler deploy`, push or container starts after a dismissal. Also a poll (`dismissPollMs`, default 2 s) aborts a `halt` signal (the worker's shutdown signal joined with the dismissal) that the claude run, the install and bundle containers and the other git steps take, so a dismissed Build does not keep spending for hours. The clone, `gh repo create` and `wrangler deploy` are `uninterruptible` (only the shutdown signal stops them): killing them half-way would leave a repo or Worker that nothing records, which is what Clean up build needs to find. The poll acts only on `dismissed`, so the final push after `built` is untouched; a poll that cannot read the status is skipped.
- **Run status.** A dismissed Build ends `abandoned` and its run closes as `aborted` (any spend already recorded is kept; a claude killed by the dismissal reports none). The existing "dismissed meanwhile" exits use the same path, so the dismiss-during-run test now expects `aborted` instead of `success`. This ends 07's in-flight refusal, and a test runs `cleanupBuild` on what a Build created before the abort.
- **Page.** `CleanupView.buildStopped` (dismissed and a `build` run `aborted`) shows a note in the Build artifacts card: dismissed while building, the Build was stopped, nothing deployed or created after. No edit to the title card; `[id].vue` only got the `showArtifacts` condition and a neutral pill for `aborted`.
- **Re-queue vs clean-up.** In one worker the two cannot overlap by tick order, but a `--once` run beside the daemon can. A claim on the Proposal row (`cleanup_claimed_at`, `Datastore.beginCleanup`/`endCleanup`/`cleanupRunning`) is taken in a `BEGIN IMMEDIATE` transaction that rechecks the status; `applyCommand` for `requeue` checks it inside the command's transaction and rejects with "Clean up build is running". `runPendingCleanups` leaves its command pending when the claim is held, and always lets go in `finally`. The claim is void after 10 minutes, so a worker that died mid-clean-up does not block the Proposal. Chosen over a status check alone because it also keeps two clean-ups from deleting twice, and over an in-process lock because the processes differ.
- No token in any new line or row: the new log lines name no credential (tested with the sentinel secrets of the harness).
- Browser check by cos: not done. It needs a real Build dismissed while running: the stopped note, the artifacts, and a Clean up build after it.
