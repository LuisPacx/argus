# 02: Subject stabiliser, so a subject keeps its key and members when its top theme is renamed
**Model:** sonnet / high — stateful merge rule between two runs with many edge cases (renames, expiry, collisions) and prompt input changes.

**What to build:** Add a pure step, `stabiliseSubjects`, that runs on the AI grouping answer before it is applied. Today the subject key comes from the theme with the most distinct creators, so when the leading theme changes name the subject loses its identity and the state the Meta rules carry between runs. The step gives each subject the key and member themes of the matching subject in the previous run's `meta_current`, so identity follows the members, not the top name. Rules: a new subject whose members overlap a previous subject's members inherits that subject's key (and keeps its label unless the AI named it anew); the previous run's themes are always sent to the AI as part of its input, even when they fall outside the top-30 theme cut, so a quiet theme of a live subject is not dropped; a previous subject that has no matching member this run is kept for a TTL of 120 minutes (the state-carry window, `ARGUS_META_STATE_MAX_MINUTES`) and then dropped; two new subjects that would inherit one key keep it on the larger overlap and the other gets a fresh key; the result is deterministic (ties by smaller key). Rename case that must hold: a subject keyed "christmas" in the previous run whose leading theme is now "santa" keeps the key "christmas" and its carried state; it is not a new subject and not a New Meta. Plain code only; the model still only names and summarises (ADR 0012, 0015, 0018). No schema change.

**Blocked by:** none

Status: done
- [ ] Rename case: previous subject keyed "christmas" with members including "christmas"; this run the AI names it from a leading theme "santa" with the same members. The output subject keeps the key "christmas", the same member themes and the carried state; it is not a new subject.
- [ ] A subject with no overlap with any previous subject gets its own key as today.
- [ ] Themes in the previous run's subjects are always in the set sent to the AI, even when they rank below the 30-theme cut; the cut for other themes is unchanged.
- [ ] A previous subject with no matching member this run is kept for 120 minutes and dropped after; at 119 minutes it is kept, at 121 it is gone.
- [ ] Two new subjects overlapping one previous subject: the larger overlap inherits the key, the other gets a fresh key; equal overlaps are decided by the smaller key, independent of input order.
- [ ] An empty previous run changes nothing; the function does no I/O.
- [ ] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
- 2026-11-22 17:36 [d37fa1ed] Merged 26367c0 to main. Verifier PASS (stabilise 14/14, pnpm check 4208/4208); reviewer MERGE, boxes 1-6 met by reading.
