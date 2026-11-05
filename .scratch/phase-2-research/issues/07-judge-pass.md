# 07: Judge pass
**Model:** sonnet / high — a new Brain task with delta logic and spend caps.

**What to build:** On a 30-minute brain tick, the `judge` task scores only new or materially changed Narratives against the current Rubric (haiku, per the routing table). Every Score is stored, new Signals on a Narrative trigger a re-score, and the details view shows Score history.

**Blocked by:** 05, 06

**Status:** ready-for-agent

- [ ] A `judge` skill in argus's skills reads the Rubric at call time and returns per-dimension scores in a validated schema; invalid output fails the run
- [ ] The same Brain guarantees as Spec drafting: no tools, isolation flags, budget, timeout, in-flight run row, usage recorded, dry-run
- [ ] Delta only: unchanged Narratives are not re-judged; tested
- [ ] Every Score is stored with its Rubric version, and the history shows in the details view
- [ ] Tests use the fake `claude`; no real usage
- [ ] `pnpm check` and `pnpm verify:boot` pass
