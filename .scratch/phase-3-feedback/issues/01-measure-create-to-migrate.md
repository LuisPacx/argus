# 01: Measure create-to-migrate from chain (spike, no feature)
**Model:** sonnet / medium — read-only measurement and a written note, no product code.

**What to build:** The Operator gets a note that settles every "Measured by slice 1" item in the spec, so later tickets use measured numbers instead of starting values. Take a sample of recent migrations from the existing Signals, read the create and migrate events from chain with Helius Free, and compare chain event times with PumpPortal receipt times. The spike also records fixtures (real PumpPortal create and migrate events, the Helius responses it uses) in `packages/core/src/fixtures/`, flat like the existing files and prefixed `pumpportal-` and `helius-`; tickets 02, 03, 04 and 10 test against them offline. The key is read from env `HELIUS_API_KEY`. No feature ships; the output is the note and the fixtures. Playwright headless vs headed and the empty-app-shell share are not part of this ticket (the X spike and ticket 02 settle them).
Spec: sections 6, 7, 14, 15 (slice 1).

**Blocked by:** None (can start immediately, but starts after the 11-08 deploy)

**Status:** ready-for-agent (all boxes ticked except RugCheck: its ToS could not be read programmatically; the Operator reads it, see `measurements.md` item 7)

- [x] A note exists in the phase-3-feedback directory and answers each item below with the measured number, the sample size and the date range
- [x] Snapshot ages: distribution of create-to-complete and complete-to-pool, from chain event times; final metadata/website age and X age window proposed from it
- [x] Fast threshold: proposed from the measured distribution, replacing the 30-minute starting value or confirming it
- [x] Migrated timestamp: states whether curve complete or pool creation counts, with the reason
- [x] PumpPortal migrate scope: states whether migrate events are only pump-to-pumpswap or include other venues
- [x] Metadata uri source: states whether the PumpPortal create payload carries the uri; if not, the Helius credit cost per create to read it from chain
- [x] Helius Free: real limits, whether getTransactionsForAddress is allowed on Free, credits per call for each call type used, and a credits-per-Case estimate against the 1M/month budget
- [ ] RugCheck: ToS reading and rate-limit window recorded, with a yes/no on including the sixth signal
- [x] Missed-create rate: share of migrates with no create row, split into the lid-suspend outage and the unexplained remainder where possible
- [x] Credit use of the spike itself is kept small and reported; no key or token appears in the note
- [x] Fixtures: real PumpPortal create and migrate events and the Helius responses the spike uses are committed under `packages/core/src/fixtures/` (`pumpportal-*.json`, `helius-*.json`); the Helius `api-key=` query value and any other secret are scrubbed, and a check (grep for the key and for `api-key=`) over the files finds nothing
- [x] `.env.example` gains `HELIUS_API_KEY=` with a comment (Helius Free plan; the spike reads it from the environment, never from a file in git)
