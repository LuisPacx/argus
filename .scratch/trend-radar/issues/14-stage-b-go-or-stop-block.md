# 14: The stage B go-or-stop block on the scorecard
**Model:** sonnet / medium. Plain code over tables stage B already writes. No model, no network.

**What to build:** the day-14 verdict for stage B, read off the page. The scorecard of ticket 05 gains a stage B block that computes what the X API added and what it cost: which source was first for each good Trend, how many only X had, the dollars against the cap per day, the automatic topics and what they found, and the spec's keep-or-drop line. Useful alone: the Operator decides "keep B, drop to A, or open C" from numbers, not memory.

Status: wontfix

**Blocked by:** 05, 12
Spec: section 8, last bullet.

## Design

- **First source with X.** Re-compute measure 2 of the scorecard per good Trend with X Trends and X Counts as sources: how many good Trends had X first, how many X alone (no other source at any time), how many X was never part of. Show the lead time (measure 1) for the X-first set against the rest.
- **What X Counts added.** Of the Trends that got the +20 rise points, how many became a good Trend within 24 hours (a live clone with liquidity of $10K or more and a market cap of $20K or more), and how many of the good Trends never had a rise.
- **Automatic topics (if ticket 13 ran).** How many were started, how many found a Moment that qualified (read from the scanner's tables), how many ended with nothing; the loads they used against the scanner's caps; any wall during their life.
- **Cost.** X API dollars per day and for the window against the $3.00 and $90 caps (days at the cap, requests refused as capped), the radar's haiku runs and Est. usage per day against their caps, and the Operator's one-number minutes a day. Cost per good Trend with X first (dollars over count; shown only when the count is at least 3, else "n too small").
- **The line** (shown as numbers with "passes" or "does not pass" per part, the verdict stays the Operator's): keep B if (a) X was first on at least 20 percent of good Trends or the only source on at least 2 of them (**proposal**), (b) no day passed the cap and no wall happened, (c) the dollars per good Trend with X first are under $15 (**proposal**: a month of $75 over about 5 of them). Otherwise drop to A. Option C is not opened by this block.

## Acceptance criteria

- [ ] **First source** (`scorecard-b.test.ts`, a fixture database with known times): X first, X only and X never are counted right on a hand-computed set, including a Trend where X and a feed were within the same tick (counted as a tie, shown separately); the lead time of the X-first set is computed against the rest.
- [ ] **Counts value** (`scorecard-b.test.ts`): the share of risen Trends that became good and of good Trends without a rise are right on the fixture; a Trend with no Counts answer is in neither group.
- [ ] **Cost and line** (`scorecard-b.test.ts`): dollars per day and for the window match the ledger fixture; days at the cap and capped refusals are counted; the "passes" or "does not pass" line is right on fixtures just above and just below each threshold and names the failing part; with fewer than 3 good Trends with X first it says "n too small" and does not compute a ratio.
- [ ] **Automatic topics** (`scorecard-b.test.ts`): started, found-a-Moment, ended-empty and the loads used are right on a fixture of topics and moments; with ticket 13 not run the block says so.
- [ ] **Render** (`radar-render.test.ts`, `pnpm page:check --seed /radar`, seeded; add stage B rows to the seed): the block with its empty state, every percentage with its n; no overflow at 390 or 1240 px.
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- Follow `docs/agents/worker-rules.md`. Read-only: the page block writes nothing and a GET leaves every table unchanged (tested).
- Commit subject `Trend radar ticket 14: the stage B go-or-stop block`, body ends with `Ticket: .scratch/trend-radar/issues/14-stage-b-go-or-stop-block.md`. No `Closes #N`.

## Comments
- 2026-11-21 cos triage: no paid X; X is read through the logged-in Argus Chrome profile (Operator, 2026-11-21)
