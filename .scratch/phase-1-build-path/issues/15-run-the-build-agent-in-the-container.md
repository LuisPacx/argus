# 15: Run the Build agent in the container
**Model:** sonnet / high — touches the spawn, kill, log and failure paths of 07; must not leak spend or containers.

**What to build:** The `SandboxRunner` seam, `buildPodmanRunArgs`, the sidecar lifecycle, stop/rm by name, startup reconciliation by label, preflight (podman and image present), dry-run logging, per-Build home directory, explicit git identity env, and `fake-podman.mjs`. Config: `ARGUS_PODMAN_BIN`, `ARGUS_BUILD_IMAGE`, caps. Resume command text for the card (consumed by 08).

**Blocked by:** 12, 13, 14, and the concurrent 07 fixes (process-group kill, run row, HIGH3 git handling)

**Status:** ready-for-agent

- [ ] The `claude` argv, budget and timeout are byte-identical to today's (tested by comparing `buildArgs` output)
- [ ] Policy tests from section 9 (argv builder) pass; adding a mount or env var without updating the allowlist fails a test
- [ ] Timeout, abort and shutdown each call `podman stop` then `rm -f` and leave no container or sidecar (fake podman records calls)
- [ ] Worker start reconciles labelled leftovers; unrelated containers are never touched
- [ ] Missing podman or image refuses the Build and leaves the Proposal `approved` with a clear log line
- [ ] Existing 07 runner tests pass against the fake podman unchanged in what they assert
- [ ] `pnpm check` passes
