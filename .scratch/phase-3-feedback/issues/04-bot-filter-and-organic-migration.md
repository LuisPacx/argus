# 04: Bot-filter raw metrics and the Organic migration label
**Model:** sonnet / high — on-chain wallet clustering with a credit budget.

**What to build:** For migrators in the population only, argus analyses the wallets around the migration and stores five raw metrics per migrator. Each migrator is then put in the organic or bot-driven bucket using starting thresholds held in config, and carries the Fast flag from the ticket 01 threshold. The Study page shows the buckets, the Fast and bot-driven cross-tab (the flags are independent) and Helius credits used, so the Operator can see the budget before any paid plan is considered. Raw metrics are kept so thresholds can change without recapture. RugCheck is not used (terms unavailable, user decision 2026-11-08); on-chain risk labels are covered by ticket 03's chain labeller.
Spec: sections 5, 7, 9, 13, 15 (slice 5).

**Blocked by:** 03 Chain labeller at 24h and 7d

**Fixtures:** tests run offline against the PumpPortal and Helius fixtures ticket 01 records in `packages/core/src/fixtures/` (`pumpportal-*.json`, `helius-*.json`).

**Status:** ready-for-agent

- [ ] The five raw metrics are stored per migrator: creation-slot supply share, clustered supply, top-10 holder share, creator holding and selling, buyer count with round-trip volume share
- [ ] Wallet analysis never runs for non-migrators or for tokens outside the population (tested)
- [ ] Thresholds live in versioned config with the starting values; changing them re-buckets from stored metrics without any chain call (tested)
- [ ] Buckets per token: control, organic migrator, bot-driven migrator, plus the Fast flag on any migrator; the bucket is derived from the 7d label
- [ ] CEX funders are excluded from clustering; clustering tests use recorded transactions for a clean case and a bot-driven case
- [ ] A Helius credit counter is kept per run and per day; the job stops at a configured daily credit cap and supports --dry-run, which makes no chain call
- [ ] Study page shows bucket counts, the Fast by bot-driven cross-tab and credits used against the 1M/month Free budget; checked in a browser against seeded data
- [ ] Full test suite and type-check pass once before the commit
