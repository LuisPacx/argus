# 04: Blend pass, so blend names like Bullmas and CATEMAS graduate into the Christmas Meta
**Model:** sonnet / high — new matching pass with learned terms, thresholds and ambiguity rules that decide what counts as a Meta.

**What to build:** Add `blendTerms` as a third pass in graduate assignment (after the two existing passes), using the shared term module (ticket 01). Today a graduate joins a subject only on an exact name or ticker form match, so "Bullmas", "CATEMAS" and "pepesanta" miss "Christmas". For each subject the pass builds a term set from its key, its label and its member themes, plus learned stems: a stem (4 characters or more, drawn from the names and tickers of the subject's tokens) is learned only if at least 3 distinct creators used it among the subject's tokens and at least 70% of all tokens carrying that stem are in this subject (self-consistency). A graduate that matches the terms of exactly one subject joins it; a match with two or more subjects is ambiguous and joins none. Blended graduates count in the subject's graduations and creators (default: blends count). The pass touches only graduates that no earlier pass assigned, and only weak subjects (below the Meta bar, Watching, or none): nothing ever moves out of an AI-named subject, and a subject that is already a Meta gains nothing from the blend. No prompt hints are added (the model is not told the stems). Plain code decides (ADR 0012, 0018). Fixture: the Christmas wave of graduation-meta ticket 01.

**Blocked by:** 01

Status: ready-for-agent
- [ ] Christmas fixture where the exact passes leave Bullmas, CATEMAS and pepesanta unassigned: the blend pass assigns them to Christmas and the subject reaches 10 graduations, 10 creators, 3 in 6 h.
- [ ] A stem used by only 2 distinct creators is not learned; one used by 3 is.
- [ ] A stem with 69% self-consistency is not learned; 70% is.
- [ ] A graduate matching two subjects is ambiguous and joins none.
- [ ] A graduate already assigned by an earlier pass or by an AI-named subject is never moved.
- [ ] A subject that is already a Meta gains nothing from the blend pass; only weak subjects do.
- [ ] "Thomas" does not join a subject through the stem "mas"; "CATEMAS" does.
- [ ] Blended graduates count in 24 h, 6 h and distinct-creator totals.
- [ ] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
