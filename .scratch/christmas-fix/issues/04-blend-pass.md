# 04: Blend pass, so blend names like Bullmas and CATEMAS graduate into the Christmas Meta
**Model:** sonnet / high — new matching pass with learned terms, thresholds and ambiguity rules that decide what counts as a Meta.

**What to build:** Add `blendTerms` as a third pass in graduate assignment (after the two existing passes), using the shared term module (ticket 01). Today a graduate joins a subject only on an exact name or ticker form match, so "Bullmas", "CATEMAS" and "pepesanta" miss "Christmas". For each subject the pass builds a term set from its key, its label and its member themes, plus learned stems: a stem (4 characters or more, drawn from the names and tickers of the subject's tokens) is learned only if at least 3 distinct creators used it among the subject's tokens and at least 70% of all tokens carrying that stem are in this subject (self-consistency). A graduate that matches the terms of exactly one subject joins it; a match with two or more subjects is ambiguous and joins none. Blended graduates count in the subject's graduations and creators (default: blends count). The pass touches only graduates that no earlier pass assigned, and only weak subjects (below the Meta bar, Watching, or none): nothing ever moves out of an AI-named subject, and a subject that is already a Meta gains nothing from the blend. No prompt hints are added (the model is not told the stems). Plain code decides (ADR 0012, 0018). Fixture: the Christmas wave of graduation-meta ticket 01.

**Blocked by:** 01

Status: done
- [x] Christmas fixture where the exact passes leave Bullmas, CATEMAS and pepesanta unassigned: the blend pass assigns them to Christmas and the subject reaches 10 graduations, 10 creators, 3 in 6 h.
- [x] A stem used by only 2 distinct creators is not learned; one used by 3 is.
- [x] A stem with 69% self-consistency is not learned; 70% is.
- [x] A graduate matching two subjects is ambiguous and joins none.
- [x] A graduate already assigned by an earlier pass or by an AI-named subject is never moved.
- [x] A subject that is already a Meta gains nothing from the blend pass; only weak subjects do.
- [x] "Thomas" does not join a subject through the stem "mas"; "CATEMAS" does.
- [x] Blended graduates count in 24 h, 6 h and distinct-creator totals.
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
- 2026-11-22 18:06 [d37fa1ed] Worker done: bbc0fc4 on christmas-04 (blend.ts, graduates.ts, compute.ts +1). Verifier (Haiku) and reviewer (Sonnet high) running. Merge after 03; whichever lands second rebases.
- 2026-11-22 18:07 [d37fa1ed] Review bbc0fc4: approve with notes. Fix round after verifier: (1) MED graduates.ts blend/weak: a Meta kept by hysteresis (leaders.ts:228-250) is below bar so counts weak and gains blends; treat previous Meta as strong. (3) blend.ts:46-57 memoise per-stem corpus scan.
- 2026-11-22 18:17 [d37fa1ed] Verifier bbc0fc4: pnpm check PASS 4221/4221; 4 new tests fail on parent 1a2f446, 3 guard tests pass there as expected. Review fix round (hysteresis Meta = strong, memoise stem) sent to the 04 worker.
- 2026-11-22 18:41 [d37fa1ed] Fix rounds b499b1d (wasMeta strong, memo stems) + c523dd5 (compute wiring tests, 3 routes fail without wiring per worker; check 4228). Reviewer on bbc0fc4..c523dd5. Next: rebase on main after 03 merges, then verifier on rebased head.
- 2026-11-22 18:42 [d37fa1ed] Review bbc0fc4..c523dd5: APPROVE (static). Low note: wasMeta ignores canStay, so a fallen Meta still counts as strong (arguably intended). Next: rebase on main after 03 merges, then verifier on rebased head.
- 2026-11-22 19:00 [d37fa1ed] Rebased onto 727aec8 + 844534d (ticket-03 cache test); worker check exit 0, 4236 tests. Review APPROVE. Haiku verifier on 844534d running; ff-merge on PASS.
- 2026-11-22 19:08 [d37fa1ed] Verifier 844534d: pnpm check passed 4236/4236. Parent-fail check moot (parent already has 03 fix); independent Haiku mutation check (drop previousThemeKeys) running before ff-merge.
- 2026-11-22 19:09 [d37fa1ed] Mutation check PASS. ff-merged to main at 844534d; worktree and branch removed. Boxes map 1:1 to graduates.test.ts blend tests; done.
