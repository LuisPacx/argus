# 03: Wire the stabiliser into the Meta tick, so the live run keeps subject identity between ticks
**Model:** sonnet / medium — plumbing between the tick, the previous `meta_current` run and the grouping step, with existing tests adapted.

**What to build:** In the Meta tick, read the previous run's subjects from `meta_current` (read-only) and pass them to the stabiliser (ticket 02) around the grouping step: the previous themes join the AI's input, and the stabiliser result replaces the plain grouping result before graduates are assigned and Metas are computed. The grouping cache and its hash must account for the added themes so a changed previous run does not reuse a stale answer. The rules fallback (AI step off or refused) goes through the same stabiliser. First run (no previous run) behaves as today. No schema change, no new schedule, nothing is written beyond what the tick writes now.

**Blocked by:** 02

Status: ready-for-agent
- [ ] A tick whose AI answer renames the leading theme of a live subject (christmas -> santa) produces the same subject key as the tick before, and no New Meta event is raised.
- [ ] The previous run's themes appear in the grouping input even when they are outside the top-30 cut.
- [ ] With the AI step off, the rules fallback also keeps keys through the stabiliser.
- [ ] The first run, and a run after the 120-minute TTL, behave as before the change.
- [ ] A changed previous run does not reuse a cached grouping answer built for different input.
- [ ] The tick reads `meta_current` only through the existing store read; nothing new is written.
- [ ] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
