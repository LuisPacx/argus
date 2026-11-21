# The Operator is the researcher: Claude runs only when the Operator triggers it

Status: accepted (decided by the Operator 2026-11-20; `.scratch/human-researcher/spec.md`, ticket 01). Amends ADR 0011 and ADR 0013 (pointers at the end of each).

The automatic research loop (ingest, cluster, judge, propose, meme ideas after each Meta tick) ran for days and did not improve. Of 84 Proposals, none was launched, and nothing recorded which were good: there were no labels. The Study and Playbook meant to learn from outcomes were never built, and `narrative_verdicts` is unread. More automatic runs on the same signal only spend the research budget. The Operator can pick good coins by hand, so he becomes the researcher: he names a topic and the coins he thinks are valuable, Argus researches and files ideas on request, and it learns from his Picks until the machine beats him.

## Decision

1. **Claude runs only when the Operator triggers it.** Every model call is the answer to a button press or a form submit on the War Room.
2. **Kept automatic, by decision:**
   - The haiku tasks: `meta-group` and `meta-summary` for Metas, and `radar-name` for the radar. They name and summarise what plain code counted; they find nothing and start nothing.
   - Every plain-code job, which makes no Claude call: ingest and clustering, Meta counting and ranking, the radar's counting, and (when built) tracking the outcome of a Pick.
3. **Switched off by default (switches, nothing deleted):**
   - The automatic research tick: judge, then propose, every 30 minutes. Switch `ARGUS_RESEARCH_TICK=1` (new; unset, empty or `0` is off; anything else is an error).
   - The automatic Meta meme-ideas runs after each Meta tick. Switch `ARGUS_MEME_IDEAS=1` (existing, off by default). A Meta's ideas become a per-Meta "Make ideas" button (human-researcher ticket 02), not an automatic run.
   - The moment scanner. Switch `ARGUS_MOMENTS=1` (existing, off by default).
   Each switch, turned on, restores the old behaviour with its existing caps. No code and no table is removed.
   The radar keeps its existing switch `ARGUS_RADAR` (ADR 0016; default off): "kept automatic" above means ADR 0017 adds no switch for it and does not turn it off, not that it runs without `ARGUS_RADAR=1`. `radar-name` is not built yet (trend-radar ticket 04).
4. **The worker says so and the War Room shows it.** At start the worker writes one line naming the automatic agents that are off; the home page's research bar shows the same list with the variable that turns each on. (The War Room reads its own environment, as it does for the meme switch, so the page can disagree with a worker started with other variables; the worker's line is the one to trust.)
5. **Tech Proposals are not extended.** They still need a news Narrative and a market Signal (ADR 0011, ADR 0013). A topic the Operator types produces `meme` Proposals only.
6. **New terms** (GLOSSARY): Pick, Research brief, Shadow pick and Scoreboard. The success test is the Scoreboard: the machine's bonded-within-24-hours rate beats the Operator's, shown with n beside it, and no verdict while either side has fewer than 20 Picks.

## Considered options

- **Keep the automatic loop and add Picks beside it.** Rejected: it keeps spending the budget on a signal with no labels, and a Shadow pick would be mixed with automatic runs it should be compared against.
- **Delete the automatic agents.** Rejected: a switch costs nothing, keeps the tests and the code the Operator may want back, and the Shadow pick reuses the research path.
- **Switch the haiku tasks off too.** Rejected: they are cheap, bounded, and make the Metas and the radar readable; the Operator kept them.

## Consequences

- New: `ARGUS_RESEARCH_TICK`, `packages/core/src/automatic-agents.ts`, the worker's `research-schedule.ts`. With the defaults, a worker running for a day makes no judge, propose or Meta meme-ideas call and no moment scan.
- ADR 0011 and ADR 0013 carry a dated pointer to this record. ADR 0002 is unaffected (argus still launches nothing).
- `--once` honours the switch too: a one-shot run judges and proposes only with `ARGUS_RESEARCH_TICK=1`.
- While `ARGUS_MEME_IDEAS` is off, the Operator's angle on a Meta (ADR 0013 amendment, meta redesign ticket 11), which shares that switch, also waits; human-researcher ticket 02 gives the Meta its own button.
