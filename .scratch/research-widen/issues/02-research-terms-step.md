# 02: Terms step, so the topic is widened into blends and searched
**Model:** sonnet / high — a new Brain task with budget, spend and rate-limit accounting, plus sequential external searches with partial-failure rules.

**What to build:** When the Operator asks for research on a topic, first ask a small model (Haiku) for up to 15 related terms and blends of the topic (for example "xmas", "santa", "mas" for "christmas"). The call is a new Brain task, `research-terms`: no tools, no API fallback, a $0.05 budget, its own skill, input the topic only (in a fenced untrusted block), output JSON that code validates and de-duplicates (each term 2 to 20 plain characters). It runs only inside an Operator-triggered request, after the cap check and before the researcher run; a dry-run skips it. It is logged with the other Brain runs, counts in the research spend and the shared research budget, and so the worst case for one request is $0.80; the 6 runs and $3 daily caps do not change. Then search DexScreener for up to 8 of the terms, one after another, keeping Solana pairs with a plain address, a price and a mint ending "pump"; a failure or rate limit on one search is not fatal and the hits so far are kept. Feed the terms to ticket 01's local match and merge. If the terms step fails or returns nothing valid, carry on with the topic alone and say so in the brief's note. No new schedule or switch (ADR 0017); nothing launches or signs (ADR 0002).

**Blocked by:** 01

Status: done

- [x] With a fake brain returning 12 terms and a fake DexScreener that returns CATEMAS only for "catemas", CATEMAS is a candidate.
- [x] Terms are validated in code (2 to 20 plain characters, de-duplicated, at most 15); invalid output counts as a failure.
- [x] A terms failure still produces a brief, with a note that the topic alone was used.
- [x] A dry-run makes no terms call; the terms call happens after the cap check and before the researcher run.
- [x] The run is recorded under `research-terms` with the Brain runs and counted in the research spend and the shared budget; a test shows the total for one request is at most $0.80.
- [x] At most 8 term searches, sequential; a 429 or error mid-way keeps the earlier hits and does not fail the request.
- [x] No new schedule, switch or automatic run; no Claude call outside an Operator request.
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Notes
- Pointers: `researchSpendSince` and the Brain task list/budgets in `packages/core`; the existing skills under `.claude/skills/` (add `research-terms`); the researcher in `packages/core/src/research/researcher.ts`.
- Spec: `.scratch/research-widen/spec.md`.
- 2026-11-22 cos: merged 23e6408. Reviewer (sonnet high) SHIP; verifier: pnpm check 246/4032, page:check 0; new tests fail on parent at import (terms.ts is new), accepted. Worst case $0.80/request ($1.55 with the pre-existing repair retry).
