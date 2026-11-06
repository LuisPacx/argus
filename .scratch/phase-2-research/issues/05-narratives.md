# 05: Narratives
**Model:** sonnet / high — the embedding and clustering choices are design work.

**What to build:** Signals are embedded and clustered into Narratives, ported from the helios clustering and embedding approach. A new Signal joins an existing Narrative or starts a new one. The War Room lists Narratives with a two-line summary, age and Signal count, and opens one to show its Signals.

**Blocked by:** 01

**Status:** done

- [x] Embedding and clustering ported from helios; ingestion makes no Brain calls, and if embedding needs a model, the choice is recorded in an ADR (ADR 0006: no model, a local hashing embedder behind an `Embedder` seam)
- [x] Each Signal belongs to at most one Narrative; a Narrative records when it last changed materially (the input for the judge delta)
- [x] Clustering is deterministic in tests with fixture Signals
- [x] War Room Narrative list and detail view; every new route has an endpoint-level test
- [x] `pnpm check` passes
