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

Source: `.scratch/missed-ideas/2026-11-12-nvidia-ceo/internal-trace.md` (a `.backup` copy of the DB, 2026-11-12 about 14:57Z) and `external.md`. Argus saw everything: the story from 2026-11-06, the Jensen Huang coin cluster from 2026-11-06, the resignation at 13:52Z on 11-12, and the mint (`dS222UNv...`, NVIDIHIA) five minutes after its creation. The idea fell out after Sources, at four places:

| Stage | Saw it | Failed because | Rule (file:line) |
|---|---|---|---|
| Source missing | partly | X is not a Source, so no X post was seen; the Study captures X only for tokens already created. Ingestion lag for news is 8 to 19 minutes. | `docs/architecture.md` section 6 ("No X as a Source"); Phase 3 ticket 06 not built |
| Signal dropped | no | no Signal was dropped; the mint was ingested at 14:56:24Z | none |
| Clustering (main failure) | split | All 911 Nvidia/Jensen/Huang/NVDA/Kress launchpad Signals sit in Narrative 351 (63,033 Signals, a generic "pump.fun launch" centroid), 12 in 851, 1 in 353. No Narrative is both about the story and market-backed with a score. Cause inferred from the shared title template, not measured. | `packages/core/src/narratives.ts:114` (`JOIN_THRESHOLD` 0.90), `:173` (join); title template `packages/core/src/sources/pumpportal.ts:305-309` |
| Judge | 351 stale, 485 blocked, 662 judged and gated | 351 was last judged 11-09 (re-judge needs 65,536 Signals, has 63,033) and the judge shows only the newest 15 of them. 485 (the news story, 68 context Signals) is ineligible after ticket 24. 662 ("jensen huang") scored buildability 3, legitimacy 1. | `packages/core/src/datastore.ts:1146` (re-judge only on material change), `:182` and `:1145` (`HAS_MARKET_SIGNAL`), `packages/core/src/sources/source-class.ts:16-18` (ADR 0011), `packages/core/src/judge.ts:51` and `:71` (`JUDGE_MAX_SIGNALS`), `narratives.ts:143-144` (`isMaterialJoin`) |
| Propose | no | 485 buildability 4, 662 buildability 3, both under the gate; 485 also context-only. Legitimacy fell on "unverified allegations about a named real person". | `datastore.ts:1204` (`gate_min_score` 5.0), `:1203` (market rule) |
| Meta | yes, rank 2 | The Meta ranked it 2nd (256 tokens, 141 creators in 24 h, 10 migrations) but a Meta is context by design and feeds no Proposal. Its summary prompt sees only token names and counts, so it missed the CEO story. | ADR 0012; `packages/core/src/meta/prompt-block.ts`, `judge.ts:228`, `propose.ts:349` |

Failed stage, in one line: **Narratives (clustering)** first, then **Judge/Propose** (gates built for "buildable web app" kill a named-person story), then **Meta** (ranked 2nd, no path to an idea). Caps were not the cause (`judge_runs_24h=300`, 22 used).

## Ranked fixes

Rank is by what it would have changed on 11-12 per unit of cost and risk. Cost is the work and the running cost; risk is what it could break on the live path.

| Rank | Stage | Change | Cost | Risk |
|---|---|---|---|---|
| 1 | Clustering | Launchpad Signals cluster by theme/subject, not into one bin (the NVIDIA wave gets its own Narrative). Already ticketed as viral-sources/01; add the 11-12 replay as acceptance. | sonnet/high, one ticket, opt-in replay | medium: live Narrative path; precision first (ADR 0007) |
| 2 | Meta | "Hot now" alert in the War Room when a Meta enters the top 5 or doubles its creators within 1 h; Meta summary gets matching news. | sonnet/medium, small, no new Brain task | low: read-only, War Room only |
| 3 | Meta to idea | Meme ideas per Meta: Proposals of kind `meme` (3 ideas per Hot Meta, measured outcome). The only fix that produces the idea itself. | sonnet/high, one Brain task plus kind plus UI; 40 runs/day | medium: new Proposal kind; name copies and real-person tokens |
| 4 | Judge | Rubric v3: legitimacy penalises impersonation and fraud only; satire about public figures is allowed. New scores only. | sonnet/medium | low to medium: changes scoring; old scores stay as history |
| 5 | Measurement | Track every idea's outcome (+6 h, +24 h, later name matches) and review the hit rate weekly against the 1.3% base. | sonnet/medium | low |
| 6 | Judge/Propose | Join a market-backed Meta to the matching context-only news Narrative (eligibility exception to ADR 0011). | sonnet/high, touches ADR 0011 | medium: widens eligibility |
| 7 | Meta to idea | Unpause the Beta finder with the news match as input. | already built to slice 2; slices 3-4 paused | medium: backtest showed no lift |
| 8 | Judge | Re-judge a Narrative whose launchpad join rate jumps (rate rule beside `isMaterialJoin`). | sonnet/medium | medium: more judge runs |
| 9 | Source | X capture as a Source (Phase 3 ticket 06, ADR 0009). | large, needs a logged-in browser | high: account and rate risks |
| 10 | Source | Faster RSS poll so news is a trigger (lag 8 to 19 min). | small | low, but news is the slow signal; the launch wave led it |

## Chosen fixes

The user chose on 2026-11-14 (grilling rounds 1 to 4, Q1 to Q15; see Comments). Nothing here is reopened.

- **Chosen, rank 1** (clustering): edit viral-sources/01 and add the NVIDIA 11-12 replay as an acceptance criterion. Done in this commit.
- **Chosen, rank 2** (Meta): "Hot now" alert and news in the Meta summary: ticket 03.
- **Chosen, rank 4** (Judge): Rubric v3, legitimacy for impersonation and fraud only: ticket 04.
- **Chosen, rank 3** (Meta to idea): the `meme` Proposal kind, replacing the planned `beta` kind: ticket 05 (ADR and GLOSSARY), ticket 06 (idea generation), ticket 07 (outcome tracking, rank 5 above).
- **Chosen** (training): record the NVIDIA case for Phase 3 tickets 07 to 09: ticket 08.
- **Not chosen:** rank 6 (RSS is context only, ideas come from the Meta), rank 7 (folded into the `meme` kind; viral-sources/04 slices 3 and 4 superseded; the 2026-11-18 re-run still runs), rank 8 (Q13, dropped), rank 9 (Q8: X stays Phase 3 ticket 06), rank 10 (Q2: RSS is not a trigger).
- **Order:** warroom-redesign/10 slice c, then 03, 04, 05, 06, 07 (missed-ideas); viral-sources/01 in a parallel worktree; 08 any time. Then the TikTok spike, Phase 3 ticket 20, hardening/06 and warroom-redesign/02.

## Acceptance

- [x] Both reports exist and are linked from this ticket: `external.md` and `internal-trace.md`.
- [x] The gap analysis is written in this ticket and names the failed stage, with the file:line rule from `internal-trace.md`.
- [x] The user has chosen the fixes, recorded in Comments.
- [x] There is one ticket per chosen fix, each with a model and effort tag on its `**Model:**` line. (viral-sources/01 edited; missed-ideas/03 to 08 written.)
- [x] This case is recorded as a training case for Phase 3 tickets 07, 08 and 09. The ticket that does it exists (`08-record-nvidia-training-case.md`); **the record itself is pending** until that ticket is done.

## Interplay

- **Ticket 02** (missed-idea intake) uses the reports from this ticket as its output template.
- Do not implement any fix in this ticket.
- Tickets 03 to 08 and the viral-sources/01 and 04 edits come from this ticket; their order is in "Chosen fixes".

## Commits

Subject `Missed ideas ticket 01: <what changed>`, body ending with `Ticket: .scratch/missed-ideas/issues/01-nvidia-ceo-miss-gap-and-fixes.md` before the trailers. No `Closes #N`: this repo has no GitHub issues.

## Comments

### 2026-11-14, the user's choices (grilling rounds 1 to 4, Q1 to Q15, run by cos; source `.scratch/cos.md`)

- **Q1:** a "Hot now" alert for the overview, and ideally Proposals based on Metas: a list of possible ideas and memes per Meta (as its own feature).
- **Q2:** drop RSS as a trigger. RSS is only context for the agent; ideas come mainly from the Meta.
- **Q3:** add the NVIDIA 11-12 replay as an acceptance test to viral-sources/01.
- **Q4:** surface real-person tokens: "not impersonating, memes about it is normal ... comedy".
- **Q5:** Meta meme ideas now, measured, no name copies, no Spec and no Build. This replaces the 11-11 decision that a meme kind waits for a replicated lesson.
- **Q6:** Hot now = a Meta enters the top 5, or distinct creators double within 1 h (as the user wrote it: "creators x2 within 1h"). It shows the summary, matching news (context), top tokens and migrations. The Meta summary gets matching news. War Room only.
- **Q7:** Rubric v3: legitimacy penalises impersonation and fraud only; satire is OK. It applies to the judge and to meme ideas.
- **Q8:** X stays Phase 3 ticket 06.
- **Q9:** meme ideas are Proposals of kind `meme`: a list filter and under each Meta on `/meta`; Shortlist, Dismiss with a reason, Why; no Spec or Build; expire after 6 h unless shortlisted; ADR and GLOSSARY first.
- **Q10:** generate only on the Hot now trigger, at most once per Meta per 6 h, one sonnet run producing 3 ideas, its own cap of 40 runs a day taken from the research budget.
- **Q11:** fold the Beta finder in: `meme` replaces `beta`; viral-sources/04 slices 3 and 4 are superseded; the room-left ranking is an input; the 2026-11-18 backtest re-run still runs.
- **Q12:** measure: Meta stats at creation, the outcome at +6 h and +24 h (migrations after 60 s, top market cap), later launches matching the name or ticker and their outcome; a weekly review of the hit rate against the 1.3% base.
- **Q13:** drop the join-rate re-judge rule.
- **Q14:** a meme idea has: name, ticker, angle (the joke and why now), how it differs from the leader (name copies are rejected), a short description, an X first-post hook, an image idea as text, risk labels (for example "real person"), and evidence links (the Meta's top tokens and matching news). No image or logo generation.
- **Q15:** the ticket list. The user's T1 to T7 became: T1 = the edit to viral-sources/01 (s/high), T2 = ticket 03, T3 = ticket 04, T4 = ticket 05, T5 = ticket 06, T6 = ticket 07, T7 = ticket 08. Order as in "Chosen fixes".

Written by the ticket writer on the same day. The training-case box is ticked because ticket 08 exists; the case record itself is pending until ticket 08 is done. This ticket's Status stays `open` until then.
