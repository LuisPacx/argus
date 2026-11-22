# 18: Playbook reads Idea verdicts (idea lessons)
**Model:** sonnet / high — touches the Playbook gate, prompt, parser, schema and skill, and has injection-safety requirements.

**What to build:** Let the Playbook also learn from the Operator's Idea verdicts (War Room ticket 21), as a separate section of lessons.
- Schema: nullable columns on `playbook_versions` via `ensureColumn`: `ideas_text`, `verdict_ids`, `verdict_cutoff` (the write-once trigger still holds). `loadPlaybookVersions` / Shadow (shadow.ts:12-13, `eligiblePlaybook` :44-57) keep reading `text` only; `latestPlaybook` also returns `ideasText`.
- Gate: sections are independent. Pick lessons need `PLAYBOOK_MIN_PICKS=10` (playbook.ts:22) as today; idea lessons need ≥10 meme Proposals with an explicit current verdict and ≥3 on the minority side. A rebuild is accepted if either qualifies; a section below its minimum is omitted with a reason. Check in the same three places as today (playbook.ts:207, playbook-run.ts:49/:75, the page refusal :226) before any model call. `PlaybookState` gains `ratedIdeas`.
- Input: newest 60 current verdicts, lines `GOOD|BAD | name (TICKER) | angle | tags | note`, flattened with `cleanLine`, caps name 40, angle 120, note 160. Code pre-computes tag counts. A second fence with its own random boundary, plus a sentence outside it that idea text is model-written and notes are Operator-typed, both untrusted.
- Output contract `{"lessons":[0-8],"ideaLessons":[0-6]}`, same line/markup/URL/control rules, ≥1 lesson in total, refused not cut (`parsePlaybookOutput` :273-295).
- Update `.claude/skills/playbook/SKILL.md` to match `playbookPromptFor`.
- Still one run, sonnet, no tools, $0.25, 4/day, research budget. The Shadow pick and Scoreboard stay blind to idea lessons.

**Blocked by:** War Room 21

**Status:** done

- [x] Ideas-only and picks-only builds both work; a section below its minimum is omitted with a reason shown.
- [x] Injection tests: a fake END line in a note or an idea cannot close the fence.
- [x] Shadow is unchanged and tested (`eligiblePlaybook` ignores `ideas_text`).
- [x] One run costs ≤$0.25; the gate runs before any model call in all three places.
- [x] Old version rows (null new columns) still open.
- [x] `.claude/skills/playbook/SKILL.md` updated.
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Notes
- Operator approved 2026-11-22. Allowlist tags and thresholds come from War Room 21.
- Pointers: `packages/core/src/playbook.ts`, `playbook-run.ts`, `shadow.ts`, `.claude/skills/playbook/SKILL.md`, `playbook.test.ts`.
- 2026-11-22 cos: merged 51f4873. Reviewer (sonnet high) SHIP; verifier PASS 7281cf6 (249/4064; 17/19 new tests fail on parent by assertion; Shadow blindness tested). Rebase adapted one test (research prompt is prompts[1] after the terms step), stamped 005d69199f. Carry-over for HR/19: use newest non-empty text and newest non-null ideasText.
