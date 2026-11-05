# 05: Narratives
**Model:** sonnet / high — the embedding and clustering choices are design work.

**What to build:** Signals are embedded and clustered into Narratives, ported from the helios clustering and embedding approach. A new Signal joins an existing Narrative or starts a new one. The War Room lists Narratives with a two-line summary, age and Signal count, and opens one to show its Signals.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Embedding and clustering ported from helios; ingestion makes no Brain calls, and if embedding needs a model, the choice is recorded in an ADR
- [ ] Each Signal belongs to at most one Narrative; a Narrative records when it last changed materially (the input for the judge delta)
- [ ] Clustering is deterministic in tests with fixture Signals
- [ ] War Room Narrative list and detail view; every new route has an endpoint-level test
- [ ] `pnpm check` passes
