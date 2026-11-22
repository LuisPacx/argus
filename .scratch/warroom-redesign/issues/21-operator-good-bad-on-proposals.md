# 21: Operator Good/Bad verdicts on meme Proposals (Idea verdicts)
**Model:** sonnet / high — a new append-only table, store method, API route and UI on three pages, with strict validation and a security-sensitive render.

**What to build:** Let the Operator rate a meme-kind Proposal's idea as Good or Bad, with one click, and optionally say why. Only explicit Good/Bad counts; bulk dismissals are NOT a signal.
- New append-only table `proposal_verdicts` (id, proposal_id, verdict `good|bad`, tags JSON from the allowlist, note ≤500, kind, playbook_version copied from the Proposal IN THE STORE, idea snapshot = clamped JSON of name/ticker/angle at verdict time, created_at), index (proposal_id, id). The newest row per Proposal is the current verdict; history is kept.
- New module `packages/core/src/proposal-verdict.ts` (validation, tag allowlist, snapshot clamp). Tag allowlist: `good-name`, `funny`, `great-hook`, `fresh-angle`, `timely`, `name-taken`, `too-generic`, `wrong-angle`, `boring`, `risky`.
- Insert-only store method `addProposalVerdict` in the WarRoomStore Pick (pattern: `addNarrativeVerdict` datastore.ts:2347, narrative-verdict.ts:73-84). Do NOT widen `narrative_verdicts`.
- `POST /api/proposals/[id]/verdict`. Version and kind come from the store; a body `playbookVersion` is ignored. Meme-kind Proposals only.
- UI: Good and Bad buttons post at once (no tags). A `<details>` "add why" (tags + note) posts a superseding row. A pill with the current verdict on list cards (`index.vue`, `NarrativeProposals.vue`) and on `proposals/[id].vue`. Generalise only pure helpers from `apps/warroom/app/utils/verdict.ts` and the VerdictForm layout.
- GLOSSARY term "Idea verdict" (Verdict stays Narrative-only). No model call.

**Blocked by:** none

Status: done

- [x] History is kept; the newest row per Proposal is current.
- [x] playbook_version and kind come from the store; a body `playbookVersion` is ignored.
- [x] 404/400 matrix (unknown Proposal, non-meme kind, bad verdict, unknown tag, 501-char note, extra keys) with nothing stored on any error.
- [x] `renderToString` shows the control and an escaped note.
- [x] `page:check` exits 0 at 390 and 1240 px with keys.
- [x] No `v-html`; no raw `:href` (lint-links passes).
- [x] GLOSSARY has "Idea verdict".
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Notes
- Operator approved 2026-11-22 ("yes as you recommend"): min 10 explicit idea verdicts with ≥3 on the minority side (used by human-researcher 18); meme-kind only; one-click verdict with optional "add why".
- Patterns: `packages/core/src/datastore.ts` (addNarrativeVerdict ~:2347), `narrative-verdict.ts:73-84`, `apps/warroom/app/utils/verdict.ts`, VerdictForm.
- Follow-ups: human-researcher 18, 19, 20.
- 2026-11-22 cos: merged 8044488. Reviewer (sonnet high) SHIP; verifier PASS 9d42664 (247/4014, new tests fail on parent, keys run POST /api/proposals/1/verdict seen); rebased check stamped 9f514a6719.
