# 19: Make ideas and topic ideas use the idea lessons
**Model:** sonnet / medium — two prompt call sites copying an existing capped-block pattern.

**What to build:** Feed `ideasText` (from ticket 18) to idea generation. At `ideas.ts:367` and `:503` (make ideas and topic ideas) add a second capped block (10 lines, 1000 chars, its own random boundary), following `playbookPromptLines` (ideas.ts:196-219).

**Blocked by:** 18

**Status:** ready-for-agent

- [ ] With no `ideasText` the prompts are byte-identical to today.
- [ ] With `ideasText`, the block has its own fence and stays within the caps.
- [ ] New Proposals record the Playbook version id end to end (as `playbook.test.ts:299`).
- [ ] Type-check, `pnpm lint` and `pnpm check` are green.

## Notes
- Pattern: `playbookPromptLines`, `ideas.ts:196-219`; test pattern `playbook.test.ts:299`.
- Idea text and notes are untrusted; reuse the existing flatten/fence helpers.
