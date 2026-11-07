# 10: Own-launch tracking
**Model:** sonnet / medium — reuses the chain reader from the labeller.

**What to build:** When the Operator marks a Proposal launched with its mint, argus follows that token on its own: it reads the mint from chain, read-only, at 1h, 24h and 7d, adds DexScreener market data, and shows the outcomes on the Proposal's details page and in the Study page. At 7d argus closes the Proposal itself and records the outcome, replacing the manual launched-to-closed step. Manual outcome entry is dropped. There is no wallet, no key and no transaction. Own launches stay out of Cohort statistics.
Spec: sections 10, 11, 15 (slice 11).

**Blocked by:** 03 Chain labeller at 24h and 7d (reuses its chain reader)

**Status:** ready-for-agent

- [ ] Marking launched schedules reads at 1h, 24h and 7d after the launch time; each read stores whether the curve completed, the migration, and DexScreener price and liquidity
- [ ] All reads are read-only; no wallet, key or transaction code is added (tested by the absence of any signing path)
- [ ] A missed or failed read is retried within a window and recorded as missing if it never succeeds; no outcome is invented
- [ ] At 7d the Proposal moves to closed by argus with the outcome stored (tested through the lifecycle)
- [ ] The manual outcome entry and manual close are removed from the UI and the API, with the migration of existing launched rows handled and tested
- [ ] Own launches are excluded from Cohorts, Cases and lesson statistics (tested)
- [ ] Outcomes show on the Proposal details page and on the Study page; checked in a browser with a seeded launched Proposal
- [ ] The job has a run cap and --dry-run, which makes no chain or DexScreener call
