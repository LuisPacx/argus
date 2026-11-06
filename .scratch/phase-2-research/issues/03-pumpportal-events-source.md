# 03: PumpPortal events Source
**Model:** sonnet / medium — ports a websocket adapter with reconnect handling.

**What to build:** PumpPortal launch and bonding events arrive as Signals, so the Operator sees what already has a token. Ported from the helios `pumpportal-bonding` adapter.

**Blocked by:** 01

**Status:** done

- [x] PumpPortal adapter ported from helios behind the `Source` interface
- [x] The websocket reconnects with backoff; a dropped connection never crashes the worker; shutdown closes it cleanly and `pnpm verify:boot` still passes
- [x] Events are deduplicated and labelled by Source
- [x] Tests use a fake websocket server or recorded events; no network
- [x] `pnpm check` passes
