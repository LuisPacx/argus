# 06: Live check that the live tick shows Christmas as one Meta
**Model:** haiku / low — read one live tick and compare it with a short checklist; no code.

**What to build:** After tickets 03 and 05 are merged and the worker runs the merged build, read one live Meta tick (the latest `meta_runs` / `meta_current` run and the War Room Meta page) and confirm the Christmas wave shows as a single Meta. Record the observed counts on this ticket as a note. This ticket closes the last open box of graduation-meta ticket 01 ("After merge, one live tick shows Christmas as a Meta"). If the check fails, write what the tick shows (subject keys, counts, unassigned graduates) on this ticket and leave it open; do not change code.

**Blocked by:** 03, 05

Status: ready-for-agent
- [ ] One live tick lists a single Meta for the Christmas wave (not several split subjects), with its 24 h graduations, 6 h graduations and creators recorded as a note on this ticket.
- [ ] No Christmas-named blend graduate (such as Bullmas or CATEMAS) is left unassigned in that tick, or the leftovers are listed with the reason.
- [ ] A second tick shortly after keeps the same subject key and raises no New Meta event.
- [ ] The last box of `.scratch/graduation-meta/issues/01-graduation-count-meta-rule.md` is ticked once the check passes.

## Comments
- 2026-11-22 18:07 [d37fa1ed] From 04 review: test CATEMAS joins only via hand-fed memberKeys ['mas']; no word-level stem matches it. Live check must confirm CATEMAS really joins Christmas on real data.
