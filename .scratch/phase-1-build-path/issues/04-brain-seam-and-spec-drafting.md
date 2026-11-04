# 04: Brain seam and Spec drafting
**Model:** sonnet / high — child-process spawning, secret scrubbing and spend caps.

**What to build:** When the Operator shortlists, the worker asks the Brain for a Spec. ClaudeCodeBrain runs `claude -p` with the `spec` skill, writes the Proposal's `spec.md`, records the run's cost and session_id, and moves the Proposal to `spec-drafted`. The card shows agent cost so far. The Brain interface follows §5; Phase 1 has ClaudeCodeBrain only (ApiBrain is Phase 2), with routing as config data. A fake `claude` executable lets every brain and build test run offline at zero spend.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] Brain interface per §5 with ClaudeCodeBrain; routing (task -> backend, model) is config, not code branching
- [ ] Child environment is scrubbed: `ANTHROPIC_API_KEY` removed and only the needed variables passed; a test asserts it
- [ ] Every run passes `--max-budget-usd` from config; hitting the cap fails the run and the cap is never raised
- [ ] `--dry-run` logs the command and spawns nothing; tested
- [ ] A brain-runs table stores task, backend, model, session_id, total_cost_usd, Proposal id and exit status
- [ ] The `spec` skill in argus's `.claude/skills/` drafts a Spec for an unattended Cloudflare Workers web-app MVP (ADR 0003)
- [ ] On shortlist the worker writes `spec.md` under the Proposal's `.data/proposals/<id>/` directory, stores its path and hash, and sets `spec-drafted`; a failed draft leaves the Proposal `shortlisted` with the error visible
- [ ] A fake `claude` executable emitting the json and stream-json result shapes (success, failure, budget exceeded, rate limited) is a shared test fixture
- [ ] Card shows summed agent cost
- [ ] `pnpm check` passes
