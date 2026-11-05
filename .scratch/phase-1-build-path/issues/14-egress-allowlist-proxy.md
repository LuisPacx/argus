# 14: Egress allowlist proxy
**Model:** sonnet / high — security-critical, small, exhaustively tested.

**What to build:** `packages/core/src/egress-proxy.ts` (plus the `.mjs` entry baked into the image): HTTP CONNECT-only proxy per section 5.2, allowlist from env, denial logging to stdout, private-address refusal.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Allowed CONNECT is tunnelled to a local fake upstream; every case in section 9's proxy list is refused and logged
- [ ] No wildcard or suffix matching in v1; hostnames compared case-insensitively and without trailing dot tricks
- [ ] Resolves and checks the address it actually connects to (no check-then-resolve gap)
- [ ] Idle and header-size limits; no unbounded buffers
- [ ] `pnpm check` passes
