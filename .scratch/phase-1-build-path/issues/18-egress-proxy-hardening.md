# 18: Egress proxy hardening

**Model:** sonnet / medium — small, security-adjacent changes to one module with tests.

**Status:** ready-for-agent

**What to build:** Close the LOW findings from the ticket 14 review (`.scratch/cos.md`, entry "Reviewer 14 f6d5df8") in `packages/core/src/egress-proxy.ts`. The test seam `testOverrides` (fake resolver, allow-private addresses, upstream port) is a fail-open switch inside the production module: make it unreachable in production (move it behind a test-only export, or make `startEgressProxy` throw when it is set outside vitest). Also: count connections refused over the cap so a flood cannot exhaust file descriptors; add a `server.on("error")` handler after listen; give each fallback address its own dial deadline; decide `allowHalfOpen` deliberately.

**Acceptance criteria:**

- [ ] Production code cannot enable private addresses or a fake resolver; a test proves `startEgressProxy` refuses `testOverrides` outside the test seam
- [ ] A test exercises the default resolver path and a successful dial with private addresses disallowed (resolver stubbed at the DNS layer, not via `testOverrides`)
- [ ] A test proves the dial goes to the validated IP, not to a re-resolved name
- [ ] Over-cap connections are counted and bounded; a flood test shows no file-descriptor growth
- [ ] `pnpm check` passes

**Blocked by:** None
