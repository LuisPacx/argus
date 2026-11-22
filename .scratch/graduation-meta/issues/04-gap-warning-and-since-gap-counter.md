# 04: Gap warning and since-the-last-gap counter on the Meta page
**Model:** sonnet / medium — one page section fed by existing gap data, with a render test.

**What to build:** When `study_gaps` (or worker downtime) overlaps the 24 h window, the War Room Meta page shows a plain warning: "Argus was not recording from <time> to <time>; counts cover N of 24 h". It also shows a "since the last gap" counter: graduations counted per subject since the last gap ended. With no gap overlapping the window, neither appears. Reuse `metaCoverage()` and `study_gaps`; add no schema.

**Blocked by:** 02

**Status:** done

- [x] A render test with a gap fixture shows the warning with both times and "covers N of 24 h", and the since-the-last-gap counter.
- [x] With no gap, no warning and no counter are rendered.
- [x] Plain text only: no `v-html`, no raw bound `:href`.
- [ ] `pnpm page:check` exit 0 at both widths, screenshots cited.
- [ ] Type-check, `pnpm lint` and `pnpm check` are green.

## Notes
- Builds on the coverage flag from ticket 02 and the counts from ticket 01.
- Spec: `.scratch/graduation-meta/spec.md`.
