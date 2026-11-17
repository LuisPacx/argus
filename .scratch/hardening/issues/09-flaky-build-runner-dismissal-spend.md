# 09: Fix the flaky "dismissed during the run keeps its spend" Build Runner test
**Model:** sonnet / effort: high — one test-only fix, but the root cause needed the dismissal path read end to end.

**Status:** done

**Symptom:** `packages/core/src/build-runner-verify.test.ts`, "Build Runner: spend is recorded on every path > a Proposal dismissed during the run keeps its dismissal; the spend is still recorded", failed twice on 2026-11-17 in full `pnpm check` runs under load (about 2 of 6) with `totalCostUsd` expected 0.0123, received 0. It passes alone.

**Root cause (a test bug, not a production race):** the Build Runner polls for a dismissal every `dismissPollMs` (2 s default, per Build) and, on seeing one, aborts `halt`, which kills the running agent. The test dismissed the Proposal while the fake claude waited, then wrote the release file at once. The fake claude then still had to wake (10 ms poll), run `git commit` and print its result. If the poll fired in that window (more likely the slower the machine, because the window is the fake's wake-up, commit and print time), the agent was killed before it printed a result. A killed run prints no result, so its spend is unknown and `brain.run` reports $0 (`BrainError` `interrupted`, `totalCostUsd: 0`). The test then saw `aborted` with 0, not 0.0123. Which side of the poll the fake lands on is a race against load.

Production code is correct on both sides of that race. If claude's result was printed before the kill lands, `brain.run` returns it as the outcome (the "complete successful result wins over our own kill" rule in `brain.ts`), `recordBrainRunSpend` stores it, and `abandon()` keeps `runEnd`'s cost. If the kill lands first, real claude has printed no cost either, so there is none to record; that is inherent, not a lost write. No fire-and-forget write, no shared state between tests, no clock was involved (each test has its own harness and db).

**Reproduction (deterministic):** the same test with `h.options.dismissPollMs = 20` fails every time with `totalCostUsd` 0 instead of 0.0123 (the poll beats the fake's commit).

**Fix:** the test pins `dismissPollMs = 3_600_000` (the poll is `unref`'d and cleared when the Build ends), so the only thing that can notice the dismissal is the guard after the agent finishes. That is the path the test is about: claude finished, spend kept, the Proposal stays dismissed. The poll-kills-the-agent path stays covered by `packages/core/src/build-runner-dismiss.test.ts` ("while claude runs"), which sets `dismissPollMs = 20` and asserts `aborted`. No retry, no longer timeout.

## Acceptance criteria

- [x] The test's outcome no longer depends on when the dismissal poll fires: the poll is parked, and the comment says why
- [x] The same test with a 20 ms poll fails with `totalCostUsd` 0 before the fix and the committed test passes (red/green recorded in the commit report)
- [x] No production code changed: the root cause is in the test (read from `build-runner.ts` and `brain.ts`)
- [x] `pnpm check` passes and stamps the committed tree

## Comments

- 2026-11-17: found by a worker; open question left to cos: a dismissal that kills a live agent records $0 spend because real claude prints no cost when killed. Not fixable without reading claude's session transcript; out of scope here.
