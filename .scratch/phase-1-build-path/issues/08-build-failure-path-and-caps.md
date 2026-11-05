# 08: Build failure path and caps
**Model:** sonnet / high — failure handling, process kills and caps that must not leak spend.

**What to build:** When a Build fails (non-zero exit, budget cap, 4 h wall clock, deploy or footer check failure), the runner retries once with the failure report appended. If the retry fails, the Proposal becomes `build-failed` with its session_id stored, and the card shows the exact `claude --resume <session_id>` command to run in tmux from the repo directory. The Operator can re-queue a `build-failed` Proposal; this settles the recovery gap noted in §3.

Timed-out or shutdown-killed Brain runs record $0 because claude prints no result; real spend is unknown, so per-Proposal cost undercounts for builds that hit the wall-clock cap (up to the $25 build budget).

**Blocked by:** 07, 15

**Status:** done

- [x] Exactly one automatic retry; its prompt includes the last log lines and the error
- [x] The wall clock (config, default 4 h) kills the child and counts as a failure; tested with a short timeout and the fake `claude`
- [x] A budget-exceeded result counts as a failure; tested
- [x] After the retry fails: `build-failed`, session_id stored, resume command shown on the card
- [x] Re-queue from `build-failed` back into the Build queue is added to the lifecycle table and tested; dismiss still works
- [x] The §3 gap note in `docs/architecture.md` is replaced by the decision
- [x] A last line `ARGUS_BUILD_FAILED::{...}` (template README contract) counts as a failure and enters the single retry, with its summary included in the retry prompt
- [x] Before the retry the runner discards uncommitted work in the Build repo (reset to its last commit), so the retry starts from a clean tree
- [x] `pnpm check` passes
