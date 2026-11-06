# 01: RSS Source and Signals end to end
**Model:** sonnet / medium — ports a known adapter and adds a second worker tick.

**What to build:** The worker polls the RSS catalog every 5 minutes and stores each item as a Signal, deduplicated across polls, and the Operator sees the latest Signals in the War Room. This lays down the `Source` interface (ported from helios) that every later Source plugs into, and runs the ingest tick beside the existing worker tick, each guarded against re-entrancy.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] `Source` interface (`id`, `label`, `poll()` returning normalized Signals) ported from helios, with the RSS adapter and its time-bounded fetch; the feed list is data, not code (`config/rss-feeds.json`)
- [x] Signals are stored with an additive, idempotent migration; a Signal seen again is not stored twice; tested
- [x] The worker runs a 5-minute ingest tick alongside its existing tick; each tick is re-entrancy guarded; a failing feed is logged and does not stop the others
- [x] Ingestion makes no LLM calls
- [x] The War Room shows the latest Signals (Source, title, link, time); every new route has an endpoint-level test with the exact UI payload
- [x] Tests use recorded feed fixtures; no network in tests
- [x] `pnpm check` and `pnpm verify:boot` pass
