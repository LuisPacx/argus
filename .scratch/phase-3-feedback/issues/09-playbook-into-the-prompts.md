# 09: Playbook into the prompts
**Model:** sonnet / medium — extends an existing prompt-rendering mechanism.

**What to build:** Once the Operator approves a lesson, the next judge or propose run carries it. At call time argus renders the approved lessons for that task into a delimited block next to the Rubric, and records the Playbook version on every Score and Proposal so a change in behaviour can be traced. Judge gets lessons for Narrative and Tech; propose gets lessons for Identity and Tech. Approving a Rubric change goes through the existing Rubric versioning. A Playbook change never re-judges old Narratives.
Spec: sections 10, 15 (slice 10).

**Blocked by:** 08 Lesson aggregation, the Playbook and the weekly review page

**Status:** ready-for-agent

- [ ] Each lesson names its tasks, and only matching lessons render into each prompt (tested)
- [ ] At most 10 active lessons per prompt, ordered by evidence strength; this ticket sets and documents the character cap, and over-long lessons are truncated or refused (tested)
- [ ] Lessons are re-sanitised on render (length, one line, no markup) as other prompt data is (tested with a hostile lesson text)
- [ ] The judge and propose skills say lessons are hints that never override the output contract; the skill text is updated and a test checks the output contract still holds
- [ ] The Playbook version is stored on each new Score and Proposal next to the Rubric version; old rows are untouched
- [ ] An approved Rubric change creates a new Rubric version through the existing editor path, and Scores still record the Rubric version they used (tested)
- [ ] Changing the Playbook does not re-judge old Narratives (tested)
- [ ] With no approved lessons the prompts are unchanged from today (tested)
- [ ] --dry-run of judge and propose shows the rendered block
