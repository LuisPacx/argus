# 02: Google Trends and DexScreener trending Sources
**Model:** sonnet / medium — two polling adapters behind an existing interface.

**What to build:** Signals also arrive from Google Trends RSS (helios `trends-feeds` pattern) and DexScreener trending, on the same ingest tick, and show in the Signals list labelled by Source.

**Blocked by:** 01

**Status:** done

- [x] Google Trends RSS Source following the helios `trends-feeds` pattern
- [x] DexScreener trending Source; its client is reusable for the collision checks in ticket 09
- [x] Both are polled on the ingest tick, deduplicated like RSS, and labelled by Source in the War Room
- [x] Rate limits and errors back off without stopping other Sources
- [x] Fixture-based tests; no network
- [x] `pnpm check` passes
