# 04: Brain seam and Spec drafting
**Model:** sonnet / high — child-process spawning, secret scrubbing and spend caps.

**What to build:** When the Operator shortlists, the worker asks the Brain for a Spec. ClaudeCodeBrain runs `claude -p` with the `spec` skill, writes the Proposal's `spec.md`, records the run's cost and session_id, and moves the Proposal to `spec-drafted`. The card shows agent cost so far. The Brain interface follows §5; Phase 1 has ClaudeCodeBrain only (ApiBrain is Phase 2), with routing as config data. A fake `claude` executable lets every brain and build test run offline at zero spend.

**Blocked by:** 03

**Status:** done

- [x] Brain interface per §5 with ClaudeCodeBrain; routing (task -> backend, model) is config, not code branching
- [x] Child environment is scrubbed: `ANTHROPIC_API_KEY` removed and only the needed variables passed; a test asserts it
- [x] Every run passes `--max-budget-usd` from config; hitting the cap fails the run and the cap is never raised
- [x] `--dry-run` logs the command and spawns nothing; tested
- [x] A brain-runs table stores task, backend, model, session_id, total_cost_usd, Proposal id and exit status
- [x] The `spec` skill in argus's `.claude/skills/` drafts a Spec for an unattended Cloudflare Workers web-app MVP (ADR 0003)
- [x] On shortlist the worker writes `spec.md` under the Proposal's `.data/proposals/<id>/` directory, stores its path and hash, and sets `spec-drafted`; a failed draft leaves the Proposal `shortlisted` with the error visible
- [x] A fake `claude` executable emitting the json and stream-json result shapes (success, failure, budget exceeded, rate limited) is a shared test fixture
- [x] Card shows summed agent cost
- [x] `pnpm check` passes

## Review fixes

Reviewer findings fixed: spend recorded before any write/transition with an in-flight `brain_runs` row; required `timeoutMs` and `tools` on every `TaskRoute`; isolated skill-only cwd and untrusted-data line in the `spec` skill; structured rate-limit detection with a 3-attempt cap. Done again only after verify, review and a real `claude -p` smoke.

Second fix round: shutdown aborts the drafting loop (no spawn after stop) and a shutdown-killed run is `interrupted`, so the Proposal is drafted again on the next boot; Spec output is validated against the `spec` skill's output contract (H1 + `## Goal`, `## Scope`, `## Acceptance criteria`, or a lone `## Needs human`) and an invalid one fails with `spec_error`, nothing saved; every route runs with `--strict-mcp-config --setting-sources project` (real haiku run: no MCP servers, no user skills or plugins in the init event); stale-run recovery only touches rows older than the longest timeout plus grace; skill temp dir cleaned if preparing it throws; fake `claude` matches real event shapes. Stale-run sweep replaced in 83c4af5: per-task timeout plus 5 min grace, swept every tick.

Verified: 446607d and 83c4af5 pass `pnpm check` (97 tests), dry-run worker boot and SIGTERM exit 0; final review: ship; real `claude -p` haiku smoke confirmed output shapes, `/spec` resolves with `--tools ""`, no user MCP/skills load.
