# 07: Cases, Cohorts and the blind study Brain task
**Model:** sonnet / high — new Brain task, caps, untrusted input.

**What to build:** Once a token has a final 7d label, argus creates a Case that pairs its frozen Snapshot with its outcome bucket, grouped in a Cohort (the calendar week of launch). A blind study run then reads exactly one Snapshot and returns structured notes on the Narrative, Identity and Tech axes. It sees no label, no bucket and no other Case, and has no tools. Claude runs are limited by the Study's own rolling-24h cap and a per-run budget; when the subscription window is limited, Study waits and never falls back to the API. The Operator sees Study spend in the War Room. Order when the cap binds: organic migrators and their random controls first, then bot-driven and fast Cases, each with its stored sampling weight.
Spec: sections 5, 8, 9, 15 (slice 8).

**Blocked by:** 04 Bot-filter raw metrics and the Organic migration label

**Status:** ready-for-agent

- [ ] A Case exists only after the 7d label (tested); Cohort is the calendar week and own launches are excluded from Cohorts
- [ ] Controls are drawn at random within the Cohort, not matched on outcome; each Case stores its sampling weight
- [ ] The study task is a new Brain task routed to Claude Code only, with its own rolling-24h run cap (starting about 100) and a per-run budget in config; it never borrows from judge, propose or Build budgets (tested)
- [ ] A rate-limited subscription makes Study wait; no API fallback exists for this task (tested)
- [ ] A study run receives one Snapshot as delimited untrusted data, no label, no tools, no web, no Chrome (tested on the assembled prompt and options)
- [ ] The output validator accepts only the fixed JSON for the three axes and refuses and drops anything else, as the judge validator does (tested, including an injection-style Snapshot)
- [ ] The label is joined to notes by code afterwards, from a separate table
- [ ] Priority order is tested: organic and controls before bot-driven and fast when the cap binds
- [ ] In-flight run rows are recorded so a restart does not double-run a Case; --dry-run lists what would run and makes no Claude call
- [ ] War Room Study spend panel shows runs against cap, estimated usage (informational), Helius credits and X captures against cap; checked in a browser
