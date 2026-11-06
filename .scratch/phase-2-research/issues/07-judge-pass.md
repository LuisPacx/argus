# 07: Judge pass
**Model:** sonnet / high — a new Brain task with delta logic and spend caps.

**What to build:** On a 30-minute brain tick, the `judge` task scores only new or materially changed Narratives against the current Rubric (haiku, per the routing table). Every Score is stored, new Signals on a Narrative trigger a re-score, and the details view shows Score history.

**Blocked by:** 05, 05b, 05c, 06

**Status:** done

- [x] A `judge` skill in argus's skills reads the Rubric at call time and returns per-dimension scores in a validated schema; invalid output fails the run
- [x] The same Brain guarantees as Spec drafting: no tools, isolation flags, budget, timeout, in-flight run row, usage recorded, dry-run
- [x] Delta only: unchanged Narratives are not re-judged; tested
- [x] Every Score is stored with its Rubric version, and the history shows in the details view
- [x] Tests use the fake `claude`; no real usage
- [x] `pnpm check` and `pnpm verify:boot` pass

Notes: the delta is "no Score, or `changed_materially_at` after the last Score's"; a Rubric edit does not re-judge old Narratives. Caps: 10 per pass, 150 runs / $2 per rolling 24 h, $0.10 per run; the 30% research share stays with ticket 08. Judge runs are `brain_runs` rows with `proposal_id` 0 and a `narrative_id`. Details view: the Narrative page lists the Score history (Proposals do not exist from Narratives until ticket 08).
