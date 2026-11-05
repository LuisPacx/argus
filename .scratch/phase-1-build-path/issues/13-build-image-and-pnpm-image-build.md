# 13: Build image and `pnpm image:build`
**Model:** sonnet / medium — Containerfile and a small script, versions pinned per section 6.

**What to build:** `containers/build/Containerfile` (digest-pinned Node 22 bookworm-slim, git, pinned pnpm and Claude Code, unprivileged user matching `--userns=keep-id`, `egress-proxy.mjs` copied in), `scripts/image-build.mjs` (computes the tag, `podman build`, idempotently creates the internal network), and a preflight helper `imageReady()` the worker will call.

**Blocked by:** 12, 14

**Status:** done

- [x] Image builds on this host; `claude --version`, `pnpm --version`, `node --version` print the pinned versions
- [x] Tag derives from the pinned versions and a content hash; no `latest`
- [x] The image contains no gh, wrangler, ssh, curl; a test lists installed binaries against an allowlist
- [x] `imageReady()` is false when the tag is absent (tested with the fake podman)
- [x] `pnpm check` passes
