# 01: Why argus missed the NVIDIA CEO token, and what to change
**Model:** sonnet / high. It needs judgment across sources, clustering, the judge and the prompts, and the fixes it leads to change how argus decides.

**What to build:** a gap analysis of the missed NVIDIA CEO idea, written in this ticket. It names the pipeline stage that failed and lists ranked fixes, each with its cost and risk. The user chooses the fixes in a grilling session run by cos. Then each chosen fix becomes its own tagged ticket. Nothing is implemented in this ticket.

**Status:** open

**Blocked by:** the two reports below, which are in progress (2026-11-12):
- `.scratch/missed-ideas/2026-11-12-nvidia-ceo/external.md`
- `.scratch/missed-ideas/2026-11-12-nvidia-ceo/internal-trace.md`

## Background

- On 2026-11-12 the user flagged a missed idea. NVIDIA was trending over a controversy about its CEO. The user calls it "cheating". Treat the details as to be verified from sources, not as fact.
- Someone then created the pump.fun token `dS222UNvAHpALEuFtK26bfM6Sganp1TZfFVQEiEpump`.
- The user wants argus to catch this kind of idea. That means checking the X posts, the token and the narrative.
- The user wants argus "trained" on such cases. In this project, training means real cases and lessons written into the prompts. It does not mean fine-tuning a model. The places this goes are:
  - Phase 3 ticket 07: cases and cohorts
  - Phase 3 ticket 08: lesson aggregation
  - Phase 3 ticket 09: playbook into the prompts

## What the reports contain

- `external.md`: the public timeline, the X posts, and the token path.
- `internal-trace.md`: what argus saw at each pipeline stage, where the idea fell out, and the rule that dropped it, given as file:line.

## What to do

1. Read both reports.
2. Write the gap analysis in this ticket under "Gap analysis". For the miss, name the stage that failed. The stages are: source missing, Signal dropped, clustering, judge, propose, and Meta.
3. List the fixes, ranked. For each fix give its cost and its risk.
4. Run the grilling session with the user (cos runs it). Record the choice in Comments.
5. For each chosen fix, create one ticket under `.scratch/missed-ideas/issues/`, numbered from 03. Each new ticket carries a `**Model:**` line with model and effort.
6. Record this case as a training case for Phase 3 tickets 07, 08 and 09.

## Gap analysis

_To be written from the two reports._

## Ranked fixes

_To be filled after the reports are read. Each fix: stage, change, cost, risk, rank._

## Chosen fixes

_To be filled after the grilling session._

## Acceptance

- [ ] Both reports exist and are linked from this ticket: `external.md` and `internal-trace.md`.
- [ ] The gap analysis is written in this ticket and names the failed stage, with the file:line rule from `internal-trace.md`.
- [ ] The user has chosen the fixes, recorded in Comments.
- [ ] There is one ticket per chosen fix, each with a model and effort tag on its `**Model:**` line.
- [ ] This case is recorded as a training case for Phase 3 tickets 07, 08 and 09.

## Interplay

- **Ticket 02** (missed-idea intake) uses the reports from this ticket as its output template.
- Do not implement any fix in this ticket.

## Comments
