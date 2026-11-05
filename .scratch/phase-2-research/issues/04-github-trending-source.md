# 04: GitHub trending Source
**Model:** sonnet / medium — one access decision plus an adapter.

**What to build:** Trending GitHub repos arrive as tech Signals. The access method (HTML scrape of the trending page, or an API route) is decided and recorded as an ADR, closing that open question in the architecture.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] An ADR records the chosen access method, its rate limits and how it can break
- [ ] GitHub trending Source behind the `Source` interface, polled on the ingest tick, deduplicated and labelled
- [ ] Parsing is tested against a saved fixture; a layout change fails loudly in the log instead of silently yielding zero Signals
- [ ] `pnpm check` passes
