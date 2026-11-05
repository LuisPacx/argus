# 09: Collision checks
**Model:** sonnet / medium — external lookups with clear failure states.

**What to build:** Each Proposal's name and ticker are checked against DexScreener, and its repo name against GitHub. Results show on the card, and `propose` avoids names that collide.

**Blocked by:** 02, 08

**Status:** ready-for-agent

- [ ] DexScreener check by name and ticker, and GitHub check by repo name; results are stored and shown on the card
- [ ] `propose` receives the collision results and retries a colliding name once; a name that still collides is flagged, not hidden
- [ ] Checks are time-bounded; a failed check shows "unknown", never "clear"
- [ ] Fixture-based tests; no network
- [ ] `pnpm check` passes
