# 12: ApiBrain fallback on subscription exhaustion
**Model:** sonnet / high — a new paid backend, key handling and real-money caps.

**What to build:** When `claude -p` exits rate-limited because the subscription window is exhausted, `judge` and `propose` switch to ApiBrain (Anthropic SDK, haiku, the same skill markdown as the system prompt, the same output schema) for the rest of the window. `spec` and `build` never fall back; they wait for the window to reset. ApiBrain is pay-as-you-go, so its runs cost real money, unlike Est. usage on the subscription.

**Blocked by:** 08, Phase 1 ticket 07 (Build Runner happy path)

**Status:** ready-for-agent

- [ ] ApiBrain sits behind the Brain interface with the same inputs and validated output schema as ClaudeCodeBrain; its cost is computed from token usage
- [ ] `ANTHROPIC_API_KEY` is read only by ApiBrain from the git-ignored `.env`; it is never passed to any `claude` child (the existing scrub test still passes) and never logged
- [ ] The fallback applies only to `judge` and `propose`, only after a rate-limited run, and only until the window resets; `spec` and `build` wait; tested with the fake `claude` rate-limit modes and a mocked SDK
- [ ] A daily API spend cap in real dollars, in code and configurable; reaching it stops research for the day and is never silently raised
- [ ] The War Room shows the backend of each run and today's API spend in real dollars, kept separate from Est. usage
- [ ] Dry-run covers ApiBrain: it logs the request and sends nothing
- [ ] `pnpm check` and `pnpm verify:boot` pass
