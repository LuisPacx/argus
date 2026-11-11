# Market Signals decide eligibility; context Signals are background

Status: accepted (Phase 3 ticket 24, decided by the Operator 2026-11-11).

Every Source has a Source class, declared as data in `packages/core/src/sources/source-class.ts`: `market` (PumpPortal, DexScreener) or `context` (every RSS feed, Google Trends, GitHub trending). A Narrative is judged and proposed only if it holds at least one market Signal. Context Signals are still ingested and clustered, and context-only Narratives stay visible in the War Room (labelled "context"), but they are never judged, never proposed and never start a Brain run, so they do not count against the run cap or the spend cap. A Narrative that later gains a market Signal is eligible at once. Existing Scores and Proposals are untouched; only selection changed.

The reason is measured, not assumed. On a copy of the database of 2026-11-11, 131 of the 132 Proposals came from context-only Narratives (99.2%), none of which was ever a good one, and 679 of the 705 Narratives with a Score (96%) were context-only. Under the rule about 26 Narratives would have been judged. The Operator's finding: no good Proposal ever came from RSS, Google Trends or GitHub trending.

Decisions:
- Market Signals decide eligibility; context Signals are background only. They reach Propose and Judge (and, after Meta ranking slice 5, the Meta summary) as a bounded block of the top 5 context-only Narratives of the last 24 hours, at most 1,500 characters, inside a fresh random boundary as untrusted data. The Rubric is unchanged and the block is not a score input. With no context the prompts are unchanged.
- Unknown Sources fail closed. An id that is not in the table is `context`, so a new Source (Telegram, TikTok) cannot start producing Proposals by being forgotten: it must be declared `market` on purpose. A test fails when a registered Source has no explicit entry.
- The datastore queries take their market id list from the same table; there is no second list.

Consequence the Operator accepted: until the Beta finder (viral-sources/04) ships, the only eligible Sources are PumpPortal and DexScreener, which yielded about one Proposal in 5.3 days (0.2 a day) on the measured data. An empty Proposals list in the interim is the intended result, not a regression.

This contradicts nothing in ADR 0002 (no chain access; the market Sources are the existing read-only ones), ADR 0006 or ADR 0007 (clustering is unchanged).
