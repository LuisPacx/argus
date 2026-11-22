# 03: Wire the stabiliser into the Meta tick, so the live run keeps subject identity between ticks
**Model:** sonnet / medium — plumbing between the tick, the previous `meta_current` run and the grouping step, with existing tests adapted.

**What to build:** In the Meta tick, read the previous run's subjects from `meta_current` (read-only) and pass them to the stabiliser (ticket 02) around the grouping step: the previous themes join the AI's input, and the stabiliser result replaces the plain grouping result before graduates are assigned and Metas are computed. The grouping cache and its hash must account for the added themes so a changed previous run does not reuse a stale answer. The rules fallback (AI step off or refused) goes through the same stabiliser. First run (no previous run) behaves as today. No schema change, no new schedule, nothing is written beyond what the tick writes now.

**Blocked by:** 02

Status: done
- [x] A tick whose AI answer renames the leading theme of a live subject (christmas -> santa) produces the same subject key as the tick before, and no New Meta event is raised.
- [x] The previous run's themes appear in the grouping input even when they are outside the top-30 cut.
- [x] With the AI step off, the rules fallback also keeps keys through the stabiliser.
- [x] The first run, and a run after the 120-minute TTL, behave as before the change.
- [x] A changed previous run does not reuse a cached grouping answer built for different input.
- [x] The tick reads `meta_current` only through the existing store read; nothing new is written.
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
- 2026-11-22 17:27 [d37fa1ed] 02 review risk 1: compute.ts ~518 themeInputs slices to GROUP_MAX_THEMES before buildGroupItems, so keep restores nothing; drop that slice or apply the cut inside buildGroupItems.
- 2026-11-22 17:27 [d37fa1ed] 02 review risk 2: stabilise kept includes a previous subject that lost the greedy match (merge case); it would show in Watching duplicating the winner's themes. Decide whether to filter.
- 2026-11-22 17:27 [d37fa1ed] 02 review risk 3: 120-min TTL runs from previous.computedAt; kept stored in Watching under the new computedAt never expires (CurrentMeta has no per-row time). Carry the original age.
- 2026-11-22 17:59 [d37fa1ed] Review of b238d7d: changes needed. (1) compute.ts:410/457: the stabiliser runs only when there is an AI answer, so the rules fallback skips it (criterion 3). (2) compute.ts:466: a merge loser is dropped only on full overlap; partial overlap still duplicates in Watching.
- 2026-11-22 18:09 [d37fa1ed] Verifier b238d7d: pnpm check PASS 4219/4219; 3 of 5 new tests fail on parent; merge-loser and first-run tests pass on parent. Fix round sent to the same worker: rules-fallback stabilise + partial-overlap loser, each with a test that bites.
- 2026-11-22 18:38 [d37fa1ed] Fix round 727aec8 (rules-path stabilise, merge loser on any claimed member; 2 new tests fail on b238d7d per worker). Verifier (Haiku) + reviewer (Sonnet) dispatched on 23c7592..727aec8.
- 2026-11-22 18:38 [d37fa1ed] Review 23c7592..727aec8: APPROVE (static). Rules fallback + merge loser met; top-30 and TTL risks fixed. No dedicated test that added previous themes change itemsHash. Waiting on verifier.
- 2026-11-22 18:51 [d37fa1ed] Verifier 727aec8: pnpm check PASS 4221/4221; both new tests fail on b238d7d. Merged to main (ff 727aec8). Cache box open: test added by 04 worker after rebase.
- 2026-11-22 19:09 [d37fa1ed] Cache box: test 844534d on main; independent mutation (previousThemeKeys -> empty set) fails it, baseline passes. All boxes met.
