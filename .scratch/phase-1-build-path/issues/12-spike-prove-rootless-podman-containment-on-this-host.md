# 12: Spike: prove rootless podman containment on this host
**Model:** sonnet / high — hands-on environment debugging with unknowns; output is facts in this note.

**What to build:** By hand (no argus code), prove the unverified parts on this machine and record answers under `## Answers` in this note: create `argus-build-net --internal`, run a two-network sidecar and a Build container, confirm no route and no DNS from the Build container; `:Z` mounts and `--userns=keep-id` under enforcing SELinux; attached `podman run` streaming with `--log-driver=none` (else `k8s-file`); `podman stop` kills grandchildren; `--timeout` fires without the client; pnpm proxy via env or `/etc/npmrc`; `claude -p` with a setup-token through the proxy (which hosts it contacts); a host-side `claude --resume` of a container-written session; `pnpm test` in the template under `--read-only` and `noexec` `/tmp`.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] Each unverified claim in sections 4 to 7 is marked confirmed, refuted or adjusted, with the command and output
- [ ] The final `claude` hostnames the sidecar saw are listed, and the allowlist decision recorded
- [ ] If the internal network fails rootless, alternative 3 (socket) is tried and the choice updated
- [ ] No images pulled beyond the one base image; no existing containers, images or networks touched; test objects removed afterwards
