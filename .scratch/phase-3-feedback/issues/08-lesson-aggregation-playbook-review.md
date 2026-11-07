# 08: Lesson aggregation, the Playbook and the weekly review page
**Model:** sonnet / high — statistics and leakage guards.

**What to build:** The Operator opens a War Room review page and sees suggested lessons and suggested Rubric changes, each with its evidence, and approves, edits, rejects or retires each. Lessons come from code that compares per-axis notes across organic migrators and controls, not from Claude. A candidate is suggested only if it clears the lesson bar and holds on a later Cohort and is not explained by a confounder. A Rubric change shows as a diff. The page also has its own sections for the Operator's dismissal reasons and for the Operator's own Launches; neither is Study evidence nor enters prompts by itself. The first review is expected after about 14 days of data.
Spec: sections 8, 10, 11, 15 (slice 9).

**Blocked by:** 07 Cases, Cohorts and the blind study Brain task

**Status:** ready-for-agent

- [ ] Aggregation is plain code and stores per candidate: counts, weighted organic and control rates, lift, and the Cohorts it holds in
- [ ] Lesson bar enforced: at least 20 organic migrators and weighted lift at least 1.5x (tested at the boundaries)
- [ ] A lesson found on Cohort k is suggested only when it also holds on a later Cohort (tested)
- [ ] A candidate that vanishes after stratifying on Timing or Launch mechanics is rejected (tested)
- [ ] Fast and bot-driven Cases never feed lessons; they appear as their own report sections (tested)
- [ ] Playbook statuses suggested, approved and retired; approval time and the Operator's edit are stored; retired lessons stay visible
- [ ] Review page supports approve, edit, reject and retire, and a Rubric change is shown as a diff against the current Rubric
- [ ] Review page has a dismissal-reasons section and an own-launches section, clearly marked as not Study evidence
- [ ] Any Claude wording help gets the evidence and aggregate only, no per-Case labels (tested on the prompt)
- [ ] Page checked in a browser against seeded Cases covering each status
- [ ] Full test suite and type-check pass once before the commit
