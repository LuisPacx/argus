# 05: UI note and ADR for the Christmas fix, so the Operator sees blends and the decision is recorded
**Model:** sonnet / medium — a small War Room note plus a decision record and glossary touch-ups.

**What to build:** Show on the Meta page, for a subject whose count includes blended graduates, a short note such as "includes N graduates matched by name blend" (counts only; no model text). Write a new ADR (next free number, status accepted, decided by the Operator 2026-11-22) recording the change: the subject stabiliser with a 120-minute TTL and previous themes always sent to the AI; the shared NFKC term module; the blend pass with its defaults (3 creators, 70% self-consistency, 4-character stems, ambiguous goes to none, nothing moves out of an AI-named subject, weak subjects only, blends count, no prompt hints, no AI-seeded terms). State that it amends ADR 0018 item 2 (how a graduate joins a subject) and keeps 0015's grouping step. Update GLOSSARY.md only where a term changes (a Graduation can join a subject by name blend) and the architecture doc's Meta tick description.

**Blocked by:** 04

Status: done
- [x] The Meta page shows the blend note for a subject with blended graduates and none for a subject without.
- [x] The ADR exists with the next free number, lists every default above and names ADR 0018 as amended.
- [x] GLOSSARY.md and the architecture doc mention the blend pass in one place each, using the codebase's terms (subject, graduation, Meta, Watching).
- [x] The ADR does not contradict ADR 0012 (plain code decides) or ADR 0002 (nothing launches or signs).
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
- 2026-11-22 19:10 [d37fa1ed] Dispatched: Sonnet medium, branch christmas-05 in ~/.cache/argus-scratch/christmas-05. Next: verifier + reviewer, then ff-merge; then 06 live check.
- 2026-11-22 19:13 [d37fa1ed] Worker 1 died (context thrash, likely a large read/output) with uncommitted edits in 6 files (api.ts, graduates.ts, store.ts, CurrentMeta.vue, meta.ts, render test), no ADR yet. Fresh Sonnet medium resumes in same tree.
- 2026-11-22 19:21 [d37fa1ed] Worker 2: committed on christmas-05 (ADR 0019, blend note, glossary, architecture); pnpm check green 4237/4237. Boxes not ticked; needs verifier+reviewer, then ff-merge.
- 2026-11-22 19:22 [d37fa1ed] 910b272 on christmas-05 (ADR 0019; worker check 4237/4237, lint not run separately). Haiku verifier (lint, check, parent-fail) + Sonnet reviewer running; ff-merge on pass.
- 2026-11-22 19:23 [d37fa1ed] Review a76af4f..910b272: APPROVE (static, no finding >=80%). Blend note count-only, blended optional in grads JSON, ADR 0019 defaults match blend.ts/config.ts. stabilise.ts not read by reviewer. Waiting on verifier.
- 2026-11-22 19:35 [d37fa1ed] Verifier 910b272: lint exit 0, check 4237/4237 stamped; new render test fails on parent a76af4f. ff-merged to main at 910b272; worktree and branch removed.
