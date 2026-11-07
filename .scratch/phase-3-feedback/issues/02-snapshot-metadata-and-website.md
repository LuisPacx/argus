# 02: Snapshot metadata and website at the fixed age, end to end
**Model:** sonnet / high — spans Source, datastore, worker and War Room; fetches untrusted URLs.

**What to build:** From the Operator's view, the War Room has a Study page that shows how many tokens argus has seen, how many are in the population, how many got a Snapshot, how many were missed and what share of website Snapshots are empty app shells. Behind it, the existing PumpPortal Source keeps each token's metadata uri, links and chain event times (same single connection, no second one). A token whose metadata names a website or an X link is in the population; others are counted for the base rate and not studied. At the fixed age from ticket 01, a capture job writes one frozen, hashed Snapshot per population token: metadata fields plus one website fetch (plain fetch, SSRF guard, size and time caps, robots honoured, empty-app-shell flag). A create the worker never saw is counted as missed and never backfilled.
Spec: sections 5, 6, 13, 15 (slices 2-3).

**Blocked by:** 01 Measure create-to-migrate from chain

**Fixtures:** tests run offline against the PumpPortal and Helius fixtures ticket 01 records in `packages/core/src/fixtures/` (`pumpportal-*.json`, `helius-*.json`).

**Status:** ready-for-agent

- [ ] The PumpPortal Source keeps uri, links, creator and chain event times and stores gap markers; it still uses one connection; existing Source tests still pass
- [ ] Population rule implemented and tested: website or X link present means studied; neither means counted only
- [ ] The capture age and capture rule version come from versioned config using the ticket 01 numbers
- [ ] A Snapshot is written once and never edited; it stores the content hash, capture time, age at capture and the selection reason
- [ ] Website fetch tests cover: private and loopback addresses refused (including via redirect), size cap, time cap, one URL only, robots disallow, non-HTML content, and empty-app-shell detection
- [ ] All fetched text is stored as untrusted data, sanitised with the same rules as the PumpPortal Source
- [ ] A missed create is recorded as missed and no later-age Snapshot is ever written for it (tested)
- [ ] The capture job has its own run cap counted in code and supports --dry-run, which fetches nothing and writes nothing
- [ ] War Room Study page shows seen, in population, captured, missed and the empty-shell share; checked in a browser against seeded data
- [ ] Full test suite and type-check pass once before the commit
