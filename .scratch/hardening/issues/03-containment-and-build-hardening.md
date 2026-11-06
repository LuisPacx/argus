# 03: Containment and Build hardening
**Model:** sonnet / high — touches the sandbox, cleanup and the Build lifecycle; a mistake leaks processes or home files.

**What to build:** Fix these LOWs from the Phase 1 reviews (ticket 16 round 4, ticket 08). Failing test first for each; run `pnpm verify:contain` and `pnpm verify:boot` if podman is available on the host.

1. **16 r4: Teardown timeout.** Container teardown (the `podman rm -f` / stop path in `sandbox.ts`) has no timeout, so a hung podman blocks cleanup forever. Bound it, log, and fall through to the process-group kill.
2. **16 r4: `job.signal`.** `job.signal` is checked only between logs polls; abort during a long poll or during the start sequence is not seen until the poll returns. Make the abort interrupt the wait.
3. **08: home sweep.** A crash during a dismissed Build leaves its home dir; sweep it at the next worker start.
4. **08: lifecycle to build-runner coupling.** `lifecycle.ts` reaches into `build-runner.ts`; invert it with a small seam (a callback or interface passed in) with no behaviour change.
5. **08: `gh` exit-1 tightening.** Treat a `gh` exit 1 as "not found" only when its output says so; any other exit-1 output fails closed.
6. **08: no-access ambiguity.** Separate "repo does not exist" from "no access" in the `gh` result handling and the failure message.
7. **PODMAN vs ARGUS_PODMAN_BIN.** `scripts/image-build.mjs` reads `PODMAN`, the worker and `verify-contain.mjs` read `ARGUS_PODMAN_BIN`. Use `ARGUS_PODMAN_BIN` everywhere (accept `PODMAN` in `image-build.mjs` as a deprecated fallback with a warning); update docs and `.env.example`.
8. **tmpfs vs memory cap.** `/tmp` and `/var/tmp` are 2g tmpfs each against an 8g `--memory` cap, so full tmpfs plus the process can exceed memory and be OOM-killed. Choose sizes that fit under the cap together (or raise the cap), in `containment-policy.ts` and `sandbox.ts` together, with the policy test and the ADR 0005 / architecture numbers updated.

**Files:** `packages/core/src/sandbox.ts`, `packages/core/src/containment-policy.ts`, `packages/core/src/build-runner.ts`, `packages/core/src/lifecycle.ts`, `packages/core/src/process-group.ts` (if needed), `scripts/image-build.mjs`, `scripts/verify-contain.mjs`, `.env.example`, `docs/adr/0005-builds-run-in-a-rootless-podman-container.md`, `docs/architecture.md`, and the matching tests.

**Blocked by:** none. No file overlap with tickets 01, 02 or 04 except `docs/architecture.md` (different paragraphs, with 02).

**Status:** done

- [x] Teardown has a timeout and falls through to the group kill; a test with a hung fake podman
- [x] An abort during a logs poll or during start is seen promptly; tests for both
- [x] The home dir of a Build dismissed before a crash is swept at the next start
- [x] `lifecycle.ts` no longer imports `build-runner.ts`
- [x] `gh` exit 1 means not-found only on matching output; "no access" is told apart from "does not exist"
- [x] One podman variable (`ARGUS_PODMAN_BIN`) across worker and scripts, `PODMAN` as a warned fallback
- [x] The tmpfs sizes and the memory cap are consistent, with the policy test and docs updated
- [x] `pnpm check` passes

**Notes.** Teardown: each `podman stop` / `rm -f` is bounded (the stop by its grace plus `teardownTimeoutMs`, default 30 s) and a hung client gets SIGKILL, is noted in the Build log and passed over; the host process group is killed as before. Abort: the signal now kills the podman call in progress (SIGKILL, not execFile's SIGTERM) and cuts the sleep between polls. Home sweep: `sweepDismissedHomes` at worker start (one line in `apps/worker/src/main.ts`) skips a dismissed Proposal whose Build run was alive in the last 5 minutes. Decoupling: `buildHomeFor` and `removeTree` moved to `build-home.ts`, which both `lifecycle.ts` and `build-runner.ts` import (still re-exported from the runner). `gh`: after a not-found the token's `X-OAuth-Scopes` is read; without `repo`, or with no scopes header (fine-grained token), the check throws `GithubNoAccessError` and the command is retried rather than read as "absent". tmpfs: `/tmp` 2 GiB (the Operator's Q6), `/var/tmp` 256 MiB, `/run` 64 MiB, together at most half the memory cap; enforced when caps are read, when the argv is built, in the dry-run policy and in `verify:contain`'s probe of the real mounts.
