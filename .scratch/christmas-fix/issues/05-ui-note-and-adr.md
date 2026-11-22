# 05: UI note and ADR for the Christmas fix, so the Operator sees blends and the decision is recorded
**Model:** sonnet / medium — a small War Room note plus a decision record and glossary touch-ups.

**What to build:** Show on the Meta page, for a subject whose count includes blended graduates, a short note such as "includes N graduates matched by name blend" (counts only; no model text). Write a new ADR (next free number, status accepted, decided by the Operator 2026-11-22) recording the change: the subject stabiliser with a 120-minute TTL and previous themes always sent to the AI; the shared NFKC term module; the blend pass with its defaults (3 creators, 70% self-consistency, 4-character stems, ambiguous goes to none, nothing moves out of an AI-named subject, weak subjects only, blends count, no prompt hints, no AI-seeded terms). State that it amends ADR 0018 item 2 (how a graduate joins a subject) and keeps 0015's grouping step. Update GLOSSARY.md only where a term changes (a Graduation can join a subject by name blend) and the architecture doc's Meta tick description.

**Blocked by:** 04

Status: ready-for-agent
- [ ] The Meta page shows the blend note for a subject with blended graduates and none for a subject without.
- [ ] The ADR exists with the next free number, lists every default above and names ADR 0018 as amended.
- [ ] GLOSSARY.md and the architecture doc mention the blend pass in one place each, using the codebase's terms (subject, graduation, Meta, Watching).
- [ ] The ADR does not contradict ADR 0012 (plain code decides) or ADR 0002 (nothing launches or signs).
- [ ] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
