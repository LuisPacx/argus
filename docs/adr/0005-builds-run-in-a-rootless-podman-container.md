# Builds run in a rootless podman container with an allowlisted egress proxy

The Build agent (`claude -p "/implement-spec <id>"`) runs unattended for hours, executes dependency scripts and tests, and its output is untrusted bytes. Running it as the Operator on the host exposed the Operator's credentials (`~/.config/gh`, `~/.config/.wrangler`, `~/.claude`, `~/.npmrc`), let it write anywhere the Operator can, let it exfiltrate over any network, and left grandchildren alive after a kill (reviewer findings HIGH2 and MED4 of ticket 07). Every command that runs agent-written or agent-influenced code now runs in a rootless podman container of a pinned image; push, deploy, `gh` and the global `wrangler` stay on the host. There is no uncontained mode: only `--dry-run` and the fake `podman` of the tests run a Build without a real container.

Design note and spike results: `.scratch/phase-1-build-path/containment-design.md` (tickets 12 to 17). Where that note and the code differ, this ADR describes the code.

## What was decided

- **Boundary.** Three container roles per Build, all from the one image `localhost/argus-build:<tag>`: `agent` (the `claude` run), `install` (`pnpm install --frozen-lockfile` of a fresh export of the checked commit) and `bundle` (`wrangler deploy --dry-run --outdir --metafile`, with no network at all). The host verifies the metafile and deploys the checked output with `--no-bundle` using its own credentials. The `agent` role's container is named `argus-build-<id>-<nonce>`, and the `install` and `bundle` roles are `argus-<role>-<id>-<nonce>` (the names `NAME_RE` in `packages/core/src/sandbox.ts` accepts). Each container is `--rm`, labelled `argus.build`, `argus.role`, `argus.data` and `argus.owner`.
- **Policy of every container.** `--userns=keep-id`, `--cap-drop=all`, `no-new-privileges`, `--read-only`, `--pull=never`, `--init`, `--log-driver=none`, pid, memory and CPU caps, `--timeout` (the caller's wall clock plus 60 s, enforced by conmon), and `noexec,nosuid,nodev` tmpfs on `/tmp` (2 GiB), `/var/tmp` (256 MiB) and `/run` (64 MiB), which together may take at most half of the `--memory` cap, since a tmpfs is memory (a larger configuration is refused when the caps are read, when the argv is built, and by the `verify:boot` and `verify:contain` policy). No `--privileged`, host network, `--env-host`, device or socket.
- **Mounts and env.** Only the job's directories (the Build repo, or the work directory of the install and bundle steps, at the same absolute path, `:Z`) and a per-Build home at `/home/agent`. The container env is an explicit allowlist (`containerEnv`); the only secret is `CLAUDE_CODE_OAUTH_TOKEN`, in the `agent` container only, passed by name so its value is never on a command line.
- **Network.** `argus-build-net` is created `--internal --disable-dns` (10.89.77.0/24). The `agent` and `install` containers reach nothing except an argus-owned CONNECT-only proxy sidecar (same image, `node /opt/argus/egress-proxy.mjs`) at the fixed address 10.89.77.2:3128, which also sits on the default `podman` network and tunnels only `api.anthropic.com:443` and `registry.npmjs.org:443` (exact match, no wildcards, private answers refused, denials logged). Topology enforces the allowlist; a client that ignores `HTTPS_PROXY` simply has no route. The fixed address means one sidecar at a time, so Builds are serial.
- **Kill.** Stop by name (`podman stop -t 5`, then `rm -f`, both `--ignore`) from the worker on timeout, abort and shutdown; sidecar the same. Killing the `podman run` client does not stop the container, which is why the stop is by name. `--timeout` is the backstop if the worker dies. Every podman call of the teardown is bounded (the stop by its grace plus 30 s, the `rm -f` by 30 s) and a call that hangs is killed with SIGKILL, noted in the Build log, and passed over, so a hung podman cannot hold the cleanup up. An abort also ends the podman call in progress while the sidecar is starting. Startup reconcile removes only containers that carry our label, belong to this data directory and whose owning worker process is provably dead.
- **Not built or pulled by the worker.** The Operator builds the image (`pnpm image:build`); the worker only checks that podman, the image, the network and the token exist before each Build, and otherwise leaves the Proposal `approved` with a log line.

## The Operator's answers (2026-11-05)

1. Image builds: manual. The Operator runs `pnpm image:build` when bumping Claude Code, Node or pnpm; the worker refuses Builds while the pinned tag is missing.
2. Allowlist: `api.anthropic.com` and `registry.npmjs.org` only. `github.com` stays out, so a dependency whose postinstall downloads from GitHub fails the Build (the safe outcome). `platform.claude.com` is added only if a real-token check shows the setup-token path needs it; the spike saw only `api.anthropic.com` with a placeholder token.
3. Network: one-time `podman network create --internal` (done idempotently by `pnpm image:build`, with `--disable-dns` and a fixed subnet that clashes neither with `podman` nor with the Supabase network on this host).
4. Token: a separate `claude setup-token` token for Builds only, rotated independently of the brain's. The Operator mints it.
5. Resume: `cd <repo> && CLAUDE_CONFIG_DIR=<data>/proposals/<id>/home/.claude claude --resume <session_id>`, since Builds no longer write to `~/.claude`.
6. Resource caps: 8 GiB memory, 4 CPUs, 1024 pids, 2 GiB `/tmp` (overridable by env; see architecture section 4). Hardening ticket 03 added `/var/tmp` 256 MiB and `/run` 64 MiB (it was 2 GiB `/var/tmp`, which with `/tmp` could take half the cap by itself) and the rule that all tmpfs together stay within half the memory cap.
7. Escape hatch: none. No uncontained mode beyond `--dry-run` and the fake binary in tests.
8. Retention: keep the per-Build home for `build-failed` (resume); delete it on `built` and on `dismissed`.
9. Scope: judge and propose (which read untrusted web content) are out of scope; the `SandboxRunner` seam makes containing them later a config change.

## Differences from the design note

Where `containment-design.md` and the code disagree, the code is described above. The differences:

1. The design has one container; the code has three roles (agent, install, bundle), with two sidecars per Build and no network for the bundle.
2. The token comes from `ARGUS_BUILD_TOKEN_FILE` (mode 600) into the agent container only, not from the client environment; preflight also checks the network and token.
3. tmpfs `noexec,nosuid,nodev` covers `/tmp`, `/var/tmp` and `/run`, not `/tmp` alone.
4. Reconcile removes only containers of this data dir whose owner is provably dead, and containers carry `argus.role`, `argus.data` and `argus.owner` labels.
5. Stop is `stop --ignore` then `rm -f --ignore`, not `rm -f` as a rarely needed fallback.
6. The sidecar has pids, memory and CPU caps; Builds are serial because of its fixed address.
7. The home is deleted on `built` and on `dismissed` (ticket 08: by the lifecycle module when the dismissal is applied, or by the runner when the Proposal was dismissed while `building`), and the War Room card of a `build-failed` Build shows `resumeCommand()`.
8. `verify:contain` uses a dummy token and has no real-token check; `verify:boot` uses the shared `checkDryRunOutput` policy instead of extended `REQUIRED_BUILD_LINES`.
9. The podman binary is `ARGUS_PODMAN_BIN` for the worker and every script. `scripts/image-build.mjs` still accepts the old `PODMAN` when that is unset, with a deprecation warning.

## Considered Options

- **The reference devcontainer firewall (iptables default-deny).** Needs `NET_ADMIN`/`NET_RAW` in the container the agent controls, or a root entrypoint that drops them, and resolves names once, which goes stale for CDN hosts. Rejected for the proxy topology.
- **pasta plus a host-side proxy.** pasta gives the container full outbound, so the proxy would be advisory. Rejected.
- **`--network none` plus a bind-mounted Unix socket to a proxy in the worker.** Tightest on paper, but connecting from `container_t` to a host socket under enforcing SELinux likely needs `label=disable`. Kept as the untried fallback; the internal network worked rootless, so it was not needed.
- **Claude Code's built-in sandbox or a dedicated Linux user.** Rejected earlier by the Operator.
- **The worker builds or pulls the image on first use.** Needs the open network the run-time policy denies, and silently changes what an unattended worker executes. Rejected (answer 1).
- **An "uncontained" debug switch.** Rejected (answer 7).

## Consequences

- Real Builds need podman, the image, `argus-build-net` and the Build token. `pnpm check` needs none of them (fake `podman`, `fake-podman.mjs`); `pnpm verify:contain` uses real podman and prints SKIP when it, the image or the network is missing.
- The returned repo, `.git/` included, is still untrusted. The host keeps its own git directory for checks and push, argus-owned `wrangler.jsonc`, and the metafile and output checks.
- Residual gaps, accepted: the allowed hosts are themselves a channel (the repo already goes to Anthropic as prompts); the Build token is in the agent's environment, so a stolen token means model usage until rotated, and `--max-budget-usd` bounds a run, not a stolen token; domain fronting through a CDN is not detected because the proxy checks the CONNECT host, not SNI; lifecycle scripts of packages the agent adds to `allowBuilds` still run, inside the container.
- Builds are serial because the sidecar has one fixed address; running Builds in parallel needs an address per Build.
- Bumping Claude Code, Node, pnpm, the Containerfile or the proxy changes the tag; the Operator rebuilds.
- Retention is complete: the per-Build home is kept while a Proposal is `build-failed` and deleted on `built` and on `dismissed`. A re-queue does not delete it; the fresh Build reuses the directory.
- A re-queued `build-failed` Proposal gets a fresh Build, which the runner refuses while the old `~/code/<slug>` exists, and `gh repo create` would fail on the old private repo. The Operator removes both first (and the Worker, if the Build deployed one); the re-queue command deletes none of them and is refused while the directory or the repo is still there. The War Room's "Clean up build" action (a separate, confirmed command on a dismissed, closed or build-failed Proposal, never a launched one) deletes only the Worker, repo and directory argus can show it made. Re-using the leftover repo instead is a possible later change.
- Dismissing a `building` Proposal stops its Build (War Room ticket 09). Every runner step checks the Proposal is still `building` in the same tick it spawns it, so no deploy and no `gh repo create` follows a dismissal; a poll every 2 s also stops the agent and the install and bundle containers that are running. The clone, `gh repo create` and `wrangler deploy` are not killed half-way (what they leave is what Clean up build looks for). The Build's run closes as `aborted`, which ends the in-flight refusal of Clean up build. A re-queue and a clean-up of the same Proposal exclude each other through a claim on the Proposal row (`cleanup_claimed_at`, void after 10 minutes).
- Not yet checked: a Build with the real token against the real image (the `claude -p` hostnames, and a session with real content resumed on the host).
