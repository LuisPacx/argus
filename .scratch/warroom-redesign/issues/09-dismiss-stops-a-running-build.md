# 09: Dismissing a Proposal stops its running Build
**Model:** sonnet / high. The change is concurrency between the build tick and the command tick, next to code that deletes real Cloudflare Workers and GitHub repos.

**What to build:** dismissing a `building` Proposal aborts its Build at the next safe point. No deploy and no GitHub repo creation may run after the dismissal. The run closes as aborted or interrupted, and the page says so. Also, a re-queue and a clean-up for the same Proposal can never run at the same time.

**Status:** open

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

- [ ] A test for dismiss-while-building shows that no deploy step and no repo creation step runs after the dismissal.
- [ ] The run is closed as aborted or interrupted, and ticket 07's clean-up then works on what was created before the abort.
- [ ] A test for re-queue against an applying clean-up shows the two never run at the same time.
- [ ] No token appears in any new log line or row.
- [ ] `pnpm check` passes.
- [ ] A browser check by cos, with the result cited in Comments.

## Interplay

- **Ticket 07** (Clean up build) owns the clean-up and its refusal while a `build` run is in flight. This ticket must keep that refusal working.
- **Glossary:** say "Build", "Proposal" and "Operator" as the code does.

## Commits

One commit, after a full `pnpm check`. Subject `War Room ticket 09: dismissing a Proposal stops its running Build`, body ending with `Ticket: .scratch/warroom-redesign/issues/09-dismiss-stops-a-running-build.md` before the trailers. Tick the boxes in the commit only if the full check does not stamp the tree afterwards, otherwise in a follow-up docs commit. No `Closes #N`: this repo has no GitHub issues.

## Comments
