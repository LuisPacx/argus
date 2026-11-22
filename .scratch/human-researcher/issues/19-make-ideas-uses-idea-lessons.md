# 19: Make ideas and topic ideas use the idea lessons
**Model:** sonnet / medium — two prompt call sites copying an existing capped-block pattern.

**What to build:** Feed `ideasText` (from ticket 18) to idea generation. At `ideas.ts:367` and `:503` (make ideas and topic ideas) add a second capped block (10 lines, 1000 chars, its own random boundary), following `playbookPromptLines` (ideas.ts:196-219).

**Blocked by:** 18

Status: done

- [x] With no `ideasText` the prompts are byte-identical to today.
- [x] With `ideasText`, the block has its own fence and stays within the caps.
- [x] New Proposals record the Playbook version id end to end (as `playbook.test.ts:299`).
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Notes
- Pattern: `playbookPromptLines`, `ideas.ts:196-219`; test pattern `playbook.test.ts:299`.
- Versions: Make ideas reads the newest non-empty Pick lessons and the newest non-empty idea lessons (`Datastore.playbookLessons`), possibly from different versions. `proposals.playbook_version` = the Pick lessons' version (the ideas version when no Pick lessons were shown); new column `proposals.ideas_playbook_version` = the version whose idea lessons were shown. The Shadow pick is untouched and never reads `ideas_text`.
- Idea text and notes are untrusted; reuse the existing flatten/fence helpers.
