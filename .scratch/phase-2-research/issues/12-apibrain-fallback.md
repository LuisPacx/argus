# 12: ApiBrain fallback on subscription exhaustion
**Model:** sonnet / high — a new paid backend, key handling and real-money caps.

**What to build:** When `claude -p` exits rate-limited because the subscription window is exhausted, `judge` and `propose` switch to ApiBrain (Anthropic SDK, haiku, the same skill markdown as the system prompt, the same output schema) for the rest of the window. `spec` and `build` never fall back; they wait for the window to reset. ApiBrain is pay-as-you-go, so its runs cost real money, unlike Est. usage on the subscription.

**Blocked by:** 08, Phase 1 ticket 07 (Build Runner happy path)

**Status:** done

- [x] ApiBrain sits behind the Brain interface with the same inputs and validated output schema as ClaudeCodeBrain; its cost is computed from token usage
- [x] `ANTHROPIC_API_KEY` is read only by ApiBrain from the git-ignored `.env`; it is never passed to any `claude` child (the existing scrub test still passes) and never logged
- [x] The fallback applies only to `judge` and `propose`, only after a rate-limited run, and only until the window resets; `spec` and `build` wait; tested with the fake `claude` rate-limit modes and a mocked SDK
- [x] A daily API spend cap in real dollars, in code and configurable; reaching it stops research for the day and is never silently raised
- [x] The War Room shows the backend of each run and today's API spend in real dollars, kept separate from Est. usage
- [x] Dry-run covers ApiBrain: it logs the request and sends nothing
- [x] `pnpm check` and `pnpm verify:boot` pass

## What was built

`packages/core/src/api-brain.ts` (ApiBrain, pricing, ceilings, the cap), `api-fallback.ts` (FallbackBrain, config, key reading, the spend ledger), a fake Anthropic server and a tripwire for the test run (`testing/fake-anthropic.ts`, `testing/no-leaked-fakes.ts`), `Datastore.apiSpendSince`, the worker wiring in `apps/worker/src/main.ts`, and the War Room's backend and API spend displays. Design and rules: `docs/architecture.md` section 5. No real API call was made, in tests or by hand: tests use a fake Anthropic server on loopback.

## Open questions (decided conservatively, for the Operator to confirm)

- **When the fallback triggers.** Chosen: off by default (`ARGUS_API_FALLBACK=1` turns it on, and a key in `.env` is needed); triggered only by a rate-limited `claude -p` run (of any task, since the window is one window); judge and propose then use the API until the reset time claude reported (never more than 6 h ahead), else for 15 minutes, after which claude is asked again. Looser alternatives: on by default when a key exists, or also on timeouts and auth failures.
- **The default daily cap.** Chosen: $0.50 of real money per rolling 24 hours (`MAX_API_DAILY_USD`), which configuration can only lower (`ARGUS_API_DAILY_USD`). A haiku judge call costs about a fifth of a cent, so this is hundreds of calls. Raising it is a code change.
- **Model.** `claude-haiku-5-5` for both tasks (the claude-api skill's current Haiku, $0.10 in and $0.50 out per million tokens at prompts up to 100K tokens). The API run has no WebSearch or WebFetch, so a propose run on the API takes its evidence links only from the Signals shown.
