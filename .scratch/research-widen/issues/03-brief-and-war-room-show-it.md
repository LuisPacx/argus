# 03: Brief and War Room show how each coin was found
**Model:** sonnet / medium — a small stored-shape addition and a page change with a render test.

**What to build:** Show the widening to the Operator. A coin in a Research brief gets an optional `via` (set by code, never by the model): the term that found it. The stored brief stays backward compatible, so an older brief without `via` still loads and renders. On the Research page, a coin with `via` shows a "found via <term>" label beside its bonded pill, and bonded coins are listed first. The brief's note lists the terms used and says "local set: last 7 days seen by Argus".

**Blocked by:** 02

Status: done

- [x] The brief's coin shape has an optional code-set `via`; a stored brief without it still parses.
- [x] The Research page shows "found via <term>" beside the bonded pill, and lists bonded coins before the others.
- [x] The brief note lists the terms used and "local set: last 7 days seen by Argus".
- [x] A render test covers the label and the order; an old brief without `via` renders.
- [x] `pnpm page:check /research` exits 0.
- [x] No raw bound `:href` (lint-links passes); any link goes through the safe-link helper.
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Notes
- Pointers: `BriefCoin` in `packages/core/src/research/brief.ts`; the brief component `ResearchBriefs.vue` in the War Room app.
- Spec: `.scratch/research-widen/spec.md`.
- 2026-11-22 cos: merged 95bc5b9. Reviewer SHIP; verifier PASS (249/4098; 12 new tests fail on parent by assertion; screenshot shows "found via" labels, terms note, bonded first).
