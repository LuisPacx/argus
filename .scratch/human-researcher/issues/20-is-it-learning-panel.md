# 20: "Is it learning?" lines in the Playbook panel
**Model:** sonnet / medium — a query plus a few panel lines, with fixture tests.

**What to build:** In `PlaybookPanel`, one line per Playbook version: "ideas made with it: N, rated R, good G (X%)", plus a "no Playbook" baseline row. Computed in `playbookState` from `proposals.playbook_version` LEFT JOIN the newest Idea verdict per Proposal. Always show the unrated count. No trend sentence below 10 rated per version. Caption: ratings are unblinded and small.

**Blocked by:** War Room 21 (most useful after 19)

**Status:** ready-for-agent

- [ ] Counts equal a hand-built fixture (including unrated and the no-Playbook row).
- [ ] No verdict/trend sentence below 10 rated per version.
- [ ] Render is escaped (`renderToString` test).
- [ ] `page:check /research` exits 0.
- [ ] Type-check, `pnpm lint` and `pnpm check` are green.

## Notes
- Operator approved 2026-11-22. Only explicit Good/Bad counts; dismissals are not a signal.
- Pointers: `PlaybookPanel`, `playbookState` in `packages/core/src/playbook.ts`, `proposals.playbook_version`.
