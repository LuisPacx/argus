# 03: Chain labeller at 24h and 7d
**Model:** sonnet / medium — a batched chain read and a small state machine with clear rules.

**What to build:** Every Snapshot'd token gets a migration label read from chain at 24h (provisional) and at 7d (final) after creation, using the migrated timestamp chosen in ticket 01. The Operator sees label health on the Study page: how many are labelled at 24h and 7d, how many late migrators there were, and how many 24h and 7d labels disagree. The 7d label is final and never adjusted; a token not migrated at 7d is a control even if it migrates later, and late migrators are only counted.
Spec: sections 7, 13, 14, 15 (slice 4).

**Blocked by:** 02 Snapshot metadata and website at the fixed age, end to end

**Fixtures:** tests run offline against the PumpPortal and Helius fixtures ticket 01 records in `packages/core/src/fixtures/` (`pumpportal-*.json`, `helius-*.json`).

**Status:** ready-for-agent

- [ ] Labels come from chain through Helius, batched at 100 accounts per call, with the pinned Pump IDL version noted; times are chain event times, never receipt times
- [ ] Both moments (curve complete, pool created) are stored; the label uses the one ticket 01 chose
- [ ] 24h labels are stored as provisional, 7d labels as final; a 7d label is never changed afterwards (tested, including a late migrator)
- [ ] Late migrators and 24h/7d disagreements are counted and shown, not corrected
- [ ] Labels live in a separate table from Snapshots, so a Snapshot is never edited
- [ ] Credits used per run are recorded; the job has a run cap and supports --dry-run, which makes no chain call
- [ ] A chain error or rate limit leaves the token unlabelled for retry and does not write a wrong label (tested)
- [ ] Tests run against recorded chain responses, including the _v2/_v3 and quote_mint variants
- [ ] Study page shows label health (labelled at 24h, labelled at 7d, late migrators, disagreements); checked in a browser against seeded data
