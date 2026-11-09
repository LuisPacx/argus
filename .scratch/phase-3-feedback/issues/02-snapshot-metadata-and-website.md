# 02: Snapshot metadata and website at the fixed age, end to end
**Model:** sonnet / high — spans Source, datastore, worker and War Room; fetches untrusted URLs.

**What to build:** From the Operator's view, the War Room has a Study page that shows how many tokens argus has seen, how many are in the population, how many got a Snapshot, how many were missed and what share of website Snapshots are empty app shells. Behind it, the existing PumpPortal Source keeps each token's metadata uri, links and chain event times (same single connection, no second one). A token whose metadata names a website or an X link is in the population; others are counted for the base rate and not studied. At the fixed age from ticket 01, a capture job writes one frozen, hashed Snapshot per population token: metadata fields plus one website fetch (plain fetch, SSRF guard, size and time caps, robots honoured, empty-app-shell flag). A create the worker never saw is counted as missed and never backfilled.
Spec: sections 5, 6, 13, 15 (slices 2-3).

**Decision (Operator, 2026-11-08, on the ticket 01 measurements; settled):** the metadata and website Snapshot is taken at age 60 s after the create; the X capture (ticket 06) at age 5 min; "Fast" means migrated within 60 s of the create. Written into versioned config as capture rule version 1 in `packages/core/src/study/config.ts` (`STUDY_CAPTURE_RULE`).

**How it was built (notes for later tickets):**
- The PumpPortal payload carries `uri`, creator, signature and pool but no links and no chain time. The links (website, X, Telegram) are in the metadata JSON at the uri, so the capture job reads that document (guarded fetch) at the Snapshot age and applies the population rule there. The create event time is the PumpPortal receipt time, which ticket 01 measured at 0.2 to 1.3 s after the chain time; no Helius call is made (ADR 0002 keeps RPC hosts out of source).
- Non-pump creates (pool other than `pump`) and creates without a uri are stored as `out-of-scope` and left out of `seen`; migrations of mints not ending in `pump` are ignored.
- The worker holds gap markers (`study_gaps`): a connection drop or a clean close opens one, the next connection-up closes it, and a worker restart is a gap from the last event it saw.
- A token the worker reaches after age 60 s plus a 60 s grace window is marked `late` and never captured; the store itself refuses a Snapshot outside that window and for any token that is not `pending`, so a missed create can never get one. Snapshot rows are immutable by trigger.
- The capture job runs every 10 s in the long-running worker, 5 tokens at a time, with a store-enforced cap of 20,000 capture runs per rolling 24 h (`ARGUS_STUDY_CAPTURES_PER_DAY` can only lower it). `--dry-run` on the worker reports what is due and fetches and writes nothing.
- Browser check: `node scripts/seed-study.mjs <new-db-path>`, then the War Room on that database, page `/study`.

**Blocked by:** 01 Measure create-to-migrate from chain

**Fixtures:** tests run offline against the PumpPortal and Helius fixtures ticket 01 records in `packages/core/src/fixtures/` (`pumpportal-*.json`, `helius-*.json`).

**Status:** implemented; waiting on the Operator's browser check of the Study page (the one unticked box)

- [x] The PumpPortal Source keeps uri, links, creator and chain event times and stores gap markers; it still uses one connection; existing Source tests still pass (uri, creator, signature, pool and receipt time come from the payload; links come from the metadata document at the uri, read by the capture job; the event time is the receipt time, within about 1 s of chain per ticket 01)
- [x] Population rule implemented and tested: website or X link present means studied; neither means counted only
- [x] The capture age and capture rule version come from versioned config using the ticket 01 numbers
- [x] A Snapshot is written once and never edited; it stores the content hash, capture time, age at capture and the selection reason
- [x] Website fetch tests cover: private and loopback addresses refused (including via redirect), size cap, time cap, one URL only, robots disallow, non-HTML content, and empty-app-shell detection
- [x] All fetched text is stored as untrusted data, sanitised with the same rules as the PumpPortal Source
- [x] A missed create is recorded as missed and no later-age Snapshot is ever written for it (tested)
- [x] The capture job has its own run cap counted in code and supports --dry-run, which fetches nothing and writes nothing
- [x] War Room Study page shows seen, in population, captured, missed and the empty-shell share; checked in a browser against seeded data (checked 2026-11-08 at :3199 against seed-study.mjs data: 71 seen / 35 population / 35 captured / 6 missed / 23% empty shells; nav link OK; no console errors after load)
- [x] Full test suite and type-check pass once before the commit (run on the committed tree)
