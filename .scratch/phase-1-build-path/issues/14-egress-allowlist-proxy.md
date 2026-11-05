# 14: Egress allowlist proxy
**Model:** sonnet / high — security-critical, small, exhaustively tested.

**What to build:** `packages/core/src/egress-proxy.ts` (plus the `.mjs` entry baked into the image): HTTP CONNECT-only proxy per section 5.2, allowlist from env, denial logging to stdout, private-address refusal.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Allowed CONNECT is tunnelled to a local fake upstream; every case in section 9's proxy list is refused and logged
- [x] No wildcard or suffix matching in v1; hostnames compared case-insensitively and without trailing dot tricks
- [x] Resolves and checks the address it actually connects to (no check-then-resolve gap)
- [x] Idle and header-size limits; no unbounded buffers
- [x] `pnpm check` passes
