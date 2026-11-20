# Human researcher: the Operator is the researcher

Status: approved by the Operator, 2026-11-20. Tickets: `issues/01` to `issues/09`.

## 1. Problem

The automatic research loop (ingest, cluster, judge, propose, meme-ideas after each Meta tick) ran for days and never improved. Of 84 Proposals, 0 were launched, and nothing records which ones were good: there are no labels. The Study and Playbook that were meant to learn from outcomes (phase-3-feedback 07 to 10) were never built, and `narrative_verdicts` is unread. More automatic runs on the same signal only spend the research budget.

The Operator can pick good coins by hand. The new shape: the Operator types a topic (for example "GTA") and pastes the coin addresses he thinks are valuable; Argus researches on request, files ideas on request, and learns from his picks until the machine beats him.

## 2. Principle

**Claude runs only when the Operator triggers it.** Every model call is the answer to a button press or a form submit.

Kept automatic, by decision:
- `meta-group` and `meta-summary` (haiku) for Metas, and `radar-name` (haiku) for the radar. All haiku tasks stay.
- Plain-code jobs stay scheduled: ingest, Meta counting and ranking, the radar's counting, pick outcome tracking. They make no Claude call.

Switched off (switches, nothing deleted): the automatic research tick (judge and propose), the automatic Meta meme-ideas runs, the moment scanner.

## 3. Operator decisions

- A **Pick** is a coin the Operator names by its contract address (CA).
- The label of a Pick is **bonded within 24 hours** of the Pick being recorded.
- The radar stays, as a list of suggestions for what to research; it starts nothing.
- A new War Room page, **Research**, holds Picks, the topic box, briefs and the Scoreboard.
- Metas are kept as they are.
- The moment scanner is off.
- A Meta's meme-ideas becomes a per-Meta **Make ideas** button; no automatic runs.
- A **Shadow pick** is made only on Operator-triggered research, never on its own schedule.
- The Playbook is rebuilt by a **Rebuild playbook** button, not on a timer.

## 4. Success

The machine's bonded-24h rate beats the Operator's over enough Picks. "Enough" is shown, never assumed: the Scoreboard prints the rate with n beside it, and no verdict is drawn while either side has fewer than 20 Picks. Until then the Operator keeps researching and the machine only learns.

## 5. Glossary (new terms; ticket 01 adds them to `GLOSSARY.md`)

**Pick**: a coin the Operator named by its contract address, with an optional reason and topic, recorded with a snapshot of the coin at that moment (name, ticker, market cap, liquidity, age, bonded yes or no). A Pick is the Operator's label-bearing choice.

**Research brief**: the stored result of one Operator-triggered research run on a topic: the story, its sources, the existing coins on that topic with market cap and bonded state, and names still free. It is text for the Operator, filed under the topic.

**Shadow pick**: the coin or coins the researcher agent chooses from a brief's coin list, made without seeing the Operator's Picks, timestamped when made. Only made on Operator-triggered research. It is tracked like a Pick and never acted on.

**Scoreboard**: the comparison of the Operator's and the machine's bonded-within-24h rate over a window (7 days), with the number of Picks on each side.

## 6. Design notes

- The Research page follows the War Room rule that the page writes request rows only; the worker does the work. Pasted text (CAs, reasons, topics) is untrusted: it is cleaned, cut and fenced under a fresh random boundary before it reaches any model.
- X is read only through the existing logged-in session path (ADR 0009), never a bundled Chromium. Lookups of coins use DexScreener, already a declared host.
- Cost: every model run records its cost in `brain_runs`; research has a daily cap and a per-run cap, and Make ideas keeps the existing angle allowance and research budget.
- Fairness of the Scoreboard (ticket 08): same candidate set (the brief's coin list), a Pick timestamped before its outcome can be known, the agent never sees Operator Picks, and an Operator Pick is compared with the machine's Picks on the same topic.
- Tech Proposals still need a news Narrative and a market Signal (ADR 0011, 0013); a topic produces `meme` Proposals only.

## 7. Tickets

| # | Title | Model | Blocked by |
|---|-------|-------|-----------|
| 01 | ADR "the Operator is the researcher" and switch off the automatic agents | sonnet/medium | none |
| 02 | "Make ideas" button on each Meta | sonnet/medium | 01 |
| 03 | Research page with Picks | sonnet/medium | none |
| 04 | Pick outcomes | sonnet/medium | 03 |
| 05 | Topic to Research brief | sonnet/high | 03 |
| 06 | Brief to Make ideas to Proposals | sonnet/medium | 02, 05 |
| 07 | Radar suggestions on the Research page | sonnet/medium | 05 |
| 08 | Shadow pick and Scoreboard | sonnet/high | 04, 05 |
| 09 | Playbook | sonnet/medium | 04, 06 |

Supersedes: phase-3-feedback 09 (by 09), trend-radar 07 (by 07), moment-scanner 06 (by 01: the scanner is off).
