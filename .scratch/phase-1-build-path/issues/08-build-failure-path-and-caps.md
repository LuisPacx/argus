# 08: Build failure path and caps
**Model:** sonnet / high — failure handling, process kills and caps that must not leak spend.

**What to build:** When a Build fails (non-zero exit, budget cap, 4 h wall clock, deploy or footer check failure), the runner retries once with the failure report appended. If the retry fails, the Proposal becomes `build-failed` with its session_id stored, and the card shows the exact `claude --resume <session_id>` command to run in tmux from the repo directory. The Operator can re-queue a `build-failed` Proposal; this settles the recovery gap noted in §3.

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] Exactly one automatic retry; its prompt includes the last log lines and the error
- [ ] The wall clock (config, default 4 h) kills the child and counts as a failure; tested with a short timeout and the fake `claude`
- [ ] A budget-exceeded result counts as a failure; tested
- [ ] After the retry fails: `build-failed`, session_id stored, resume command shown on the card
- [ ] Re-queue from `build-failed` back into the Build queue is added to the lifecycle table and tested; dismiss still works
- [ ] The §3 gap note in `docs/architecture.md` is replaced by the decision
- [ ] `pnpm check` passes
