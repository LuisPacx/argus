# Research widen: find themed coins the literal topic misses

Status: approved by the Operator, 2026-11-22. Tickets: `issues/01` to `issues/03`.

## 1. Problem

A Research brief's coins come from one DexScreener search for the literal topic, capped at 15 candidates. Themed coins are missed: for the topic "christmas" the brief missed CATEMAS, BOSSMAS, Bullmas and Santa Inu. DexScreener search matches whole tokens and returns at most 30 pairs, so "-mas" blends can only be found by a local substring match.

## 2. Design

- **Local bonded set.** The worker's ingest already records every token it sees (name, symbol, created and migrated times) in the Study store, about 13 days of history with gaps. Research reads the tokens that migrated in the last 7 days and matches them in plain code (case-insensitive substring over name, symbol and description; a stem under 4 characters matches only at the start or end of a word, so "mas" does not match "Thomas").
- **Terms.** One Haiku call, started only inside an Operator-triggered request, turns the topic into up to 15 terms and blends ("xmas", "santa", "mas"). Code validates them. Each term feeds the local match and, up to 8 of them, a DexScreener search.
- **Merge.** Literal-search hits are kept as today. Extra candidates from the local set or the term searches are kept only when bonded (a local migration, else a graduation venue with at least $5K liquidity). Bonded first, then market cap, then liquidity; the cap rises from 15 to 25. Each candidate carries a code-set `via` (the term that found it). The model still sees only ids c1..cN, names stay in the fenced untrusted block, and its limits (10 coins, 2 picks) do not change.
- **Brief.** The brief shows "found via <term>" and lists bonded coins first, and its note says which terms were used and that the local set is "last 7 days seen by Argus".

## 3. Rules kept

- Claude runs only when the Operator triggers it (ADR 0017): no new schedule, no new switch.
- The terms run counts in the research spend and the shared research budget; worst case $0.80 per request; the 6 runs and $3 daily caps are unchanged.
- Nothing launches or signs (ADR 0002).
- A failed terms step or a rate-limited search never fails the brief.
