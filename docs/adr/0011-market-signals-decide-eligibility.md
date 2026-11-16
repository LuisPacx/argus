# Market Signals decide eligibility; context Signals are background

Status: accepted (Phase 3 ticket 24, decided by the Operator 2026-11-11).

Every Source has a Source class, declared as data in `packages/core/src/sources/source-class.ts`: `market` (PumpPortal, DexScreener) or `context` (every RSS feed, Google Trends, GitHub trending). A Narrative is judged and proposed only if it holds at least one market Signal. Context Signals are still ingested and clustered, and context-only Narratives stay visible in the War Room (labelled "context"), but they are never judged, never proposed and never start a Brain run, so they do not count against the run cap or the spend cap. A Narrative that later gains a market Signal is eligible at once. Existing Scores and Proposals are untouched; only selection changed.

The reason is measured, not assumed. On a copy of the database of 2026-11-11, 131 of the 132 Proposals came from context-only Narratives (99.2%), none of which was ever a good one, and 679 of the 705 Narratives with a Score (96%) were context-only. Under the rule about 26 Narratives would have been judged. The Operator's finding: no good Proposal ever came from RSS, Google Trends or GitHub trending.

Decisions:
- Market Signals decide eligibility; context Signals are background only. They reach Propose and Judge (and, after Meta ranking slice 5, the Meta summary) as a bounded block of the top 5 context-only Narratives of the last 24 hours, at most 1,500 characters, inside a fresh random boundary as untrusted data. The Rubric is unchanged and the block is not a score input. With no context the prompts are unchanged.
- Unknown Sources fail closed. An id that is not in the table is `context`, so a new Source (Telegram, TikTok) cannot start producing Proposals by being forgotten: it must be declared `market` on purpose. A test fails when a registered Source has no explicit entry.
- The datastore queries take their market id list from the same table; there is no second list.

Consequence the Operator accepted: until the Beta finder (viral-sources/04) ships, the only eligible Sources are PumpPortal and DexScreener, which yielded about one Proposal in 5.3 days (0.2 a day) on the measured data. An empty Proposals list in the interim is the intended result, not a regression.

## Amendment 2026-11-16: a market Signal alone does not make a news Narrative eligible (proposal-routing ticket 05)

A market Signal makes a `news` Narrative eligible only together with at least one non-market Signal. PumpPortal Signals only sit in launchpad Narratives, which are never judged, so a DexScreener token inside a news Narrative was the one way a news Narrative became eligible, and a token could found one (ADR 0007's amendment of this date stops that: a token joins a news Narrative a headline founded, never starts one). The datastore adds `HAS_NEWS_SIGNAL` (a Signal whose Source is not in the market list) beside `HAS_MARKET_SIGNAL` and requires both in `narrativesToJudge`, `narrativesToPropose` and `narrativesToMeme`, one shared fragment. Measured on a copy of 2026-11-16: 20 of the 27 judged or proposed news Narratives with a DexScreener token and no PumpPortal Signal had no headline (all memecoin tickers, buildability 4 or less; the only Tech Proposals from them, 150 and 152, were memecoins dressed up as apps), so this does stop what used to be judged; the Operator approved that on 2026-11-16. Legacy token-only news rows are not rewritten; the guard hides them and they age out.

This contradicts nothing in ADR 0002 (no chain access; the market Sources are the existing read-only ones), ADR 0006 or ADR 0007 (clustering is unchanged).
