# 01: ADR "the Operator is the researcher" and switch off the automatic agents
**Model:** sonnet / medium — a decision record plus switches over existing schedules; no new behaviour.

**What to build:** The Operator decides when Claude runs. Record that as a new ADR (the next free number, 0017) that amends ADR 0011 and ADR 0013: the automatic research tick (judge and propose), the automatic Meta meme-ideas runs and the moment scanner are off. Metas, the radar, ingest and Meta counting keep running, and so do the haiku tasks (meta-group, meta-summary, radar-name). Each is a switch, so nothing is deleted and the Operator can turn one back on. The War Room says plainly which agents are off. The new terms Pick, Research brief, Shadow pick and Scoreboard are added to the glossary.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] A new ADR (0017, or the next free number) states the principle "Claude runs only when the Operator triggers it", lists the exceptions kept automatic, and amends ADR 0011 and ADR 0013 with a dated pointer in each.
- [ ] With the switches at their defaults, the worker starts no judge, propose or Meta meme-ideas run and no moment scan, and writes one line at start saying so (tested with fake clocks and a fake Brain: no Brain call in a full simulated day).
- [ ] Turning each switch on restores the old behaviour with its existing caps (tested); no code or table is deleted.
- [ ] Meta ranking, ingest, radar counting, meta-group, meta-summary and radar-name still run on their schedules (tested).
- [ ] The War Room shows which automatic agents are off (render test).
- [ ] `GLOSSARY.md` gains Pick, Research brief, Shadow pick and Scoreboard, using the definitions in the spec.
- [ ] Existing tests that assumed the automatic runs are updated, not deleted; type-check, `pnpm lint` and `pnpm check` are green.

## Comments
