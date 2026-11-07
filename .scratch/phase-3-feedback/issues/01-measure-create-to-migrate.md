# 01: Measure create-to-migrate from chain (spike, no feature)
**Model:** sonnet / medium — read-only measurement and a written note, no product code.

**What to build:** The Operator gets a note that settles every "Measured by slice 1" item in the spec, so later tickets use measured numbers instead of starting values. Take a sample of recent migrations from the existing Signals, read the create and migrate events from chain with Helius Free, and compare chain event times with PumpPortal receipt times. No feature ships; the output is the note. Playwright headless vs headed and the empty-app-shell share are not part of this ticket (the X spike and ticket 02 settle them).
Spec: sections 6, 7, 14, 15 (slice 1).

**Blocked by:** None (can start immediately, but starts after the 11-08 deploy)

**Status:** ready-for-agent

- [ ] A note exists in the phase-3-feedback directory and answers each item below with the measured number, the sample size and the date range
- [ ] Snapshot ages: distribution of create-to-complete and complete-to-pool, from chain event times; final metadata/website age and X age window proposed from it
- [ ] Fast threshold: proposed from the measured distribution, replacing the 30-minute starting value or confirming it
- [ ] Migrated timestamp: states whether curve complete or pool creation counts, with the reason
- [ ] PumpPortal migrate scope: states whether migrate events are only pump-to-pumpswap or include other venues
- [ ] Metadata uri source: states whether the PumpPortal create payload carries the uri; if not, the Helius credit cost per create to read it from chain
- [ ] Helius Free: real limits, whether getTransactionsForAddress is allowed on Free, credits per call for each call type used, and a credits-per-Case estimate against the 1M/month budget
- [ ] RugCheck: ToS reading and rate-limit window recorded, with a yes/no on including the sixth signal
- [ ] Missed-create rate: share of migrates with no create row, split into the lid-suspend outage and the unexplained remainder where possible
- [ ] Credit use of the spike itself is kept small and reported; no key or token appears in the note
