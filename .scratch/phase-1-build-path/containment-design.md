> Superseded where it differs from the code by docs/adr/0005-builds-run-in-a-rootless-podman-container.md; see the discrepancies listed in ADR 0005.

# Build containment: rootless podman design note

Status: proposal for the Operator's decision. No code changes in this note. Written against `main` at 784ae1e (Build Runner from 20e49f9). Spike results (ticket 12, run on this host 2026-11-05) are in section 14 and marked inline as **verified**, **refuted** or **adjusted**.

Scope: run the ticket 07 Build agent (`claude -p "/implement-spec <id>"`) inside a rootless podman container. This answers reviewer finding HIGH2 (agent not contained: HOME credentials readable, arbitrary code through `pnpm install/add/test`, exfiltration, writes outside the repo) and the process half of MED4 (only the claude pid is killed, grandchildren survive; template dir writable). It assumes the concurrent fixes land separately: argus-owned `wrangler.jsonc`, git with no repo config plus fresh-clone push (HIGH3), process-group kill, run row (MED5), Worker-name check (MED6), visible-only disclosure (LOW7).

Primary sources cited inline (fetched 2026-11-05): podman docs at docs.podman.io, Claude Code docs at code.claude.com/docs. Anything not covered by a source is marked "unverified" and is a spike item (ticket 12).

## 1. Decision summary

| Question | Choice |
|---|---|
| Boundary | One rootless podman container per Build, `--rm`, started and killed by the worker. Host user namespace is mapped, no root anywhere. |
| What is mounted | The Build repo (read-write, same absolute path inside) and a per-Build scratch HOME under `.data/proposals/<id>/home` (read-write). Nothing else. |
| Credentials in | `CLAUDE_CODE_OAUTH_TOKEN` only, by environment. No gh, wrangler, git, npm or `~/.claude` material. |
| Network | `podman network create --internal` network with no route out, plus a per-Build sidecar container running a small argus-owned CONNECT allowlist proxy (`api.anthropic.com`, `registry.npmjs.org`). The Build container reaches only that proxy. |
| Image | `localhost/argus-build:<claude-version>-n<node>-p<pnpm>`, Debian slim (glibc), Node 22, pnpm and Claude Code pinned, built by the Operator with one command, never pulled or built by the worker. |
| Kill | `podman stop` by name from the worker, plus `--timeout` inside conmon as a crash-proof backstop, plus startup reconciliation by label. |
| Push, deploy, `gh`, global `wrangler` | Unchanged: argus on the host, outside the container. |
| Tests | A `SandboxRunner` seam plus a fake `podman` executable. `pnpm check` needs no podman. A separate `pnpm verify:contain` uses real podman and is skipped (loudly) when it is absent. |

## 2. Host check (this machine, read-only commands only)

Ran `podman --version`, `podman info`, `podman image ls`, `podman network ls`, `podman unshare cat /proc/self/uid_map`. Pulled nothing, created nothing.

- podman 5.8.7 (Fedora 44 package), buildah 1.43.4, skopeo present, conmon 2.2.1, crun 1.28 (OCI runtime), cgroups v2 with the systemd manager, controllers cpu io memory pids available.
- Rootless works: `rootless: true`, uid map `0 -> 1000 (1)` and `1 -> 524288 (65536)`, `/etc/subuid` and `/etc/subgid` both `unknown:524288:65536`, overlay storage on btrfs with native overlay diff.
- Networking: netavark 1.17.2, aardvark-dns 1.17.1, `rootlessNetworkCmd: pasta` (passt 20261002). `slirp4netns` and `runc` are not installed and not needed. Existing networks: `podman` and `supabase_network_supabase-workers`.
- Security: SELinux enforcing, seccomp on, default capability set shown in `podman info`. This matters for bind mounts (section 4.2).
- Not present: any `argus-build` image, any `argus` network, a Node base image. Existing unrelated state: 18 images, 12 stopped containers (Supabase and others). Argus must use its own names, labels and network and must never prune.
- Memory: 31 GiB total, about 1.4 GiB reported free at the time of the check, 8 GiB swap. Relevant for the container memory cap (open question 6).
- Host tools used elsewhere: Node v22.23.1, pnpm 11.2.2, Claude Code 2.1.318 (native), npm `latest` and `next` are 2.1.318, `stable` 2.1.311.

What the Operator must install or configure: nothing to install. They must (1) build the image once (`pnpm image:build`, ticket 13; needs network for the base image and npm), (2) create the internal network once (`podman network create --internal`, done by the same script, idempotent), (3) provide the token (open question 4). Spike result: both held on this host (section 14): rootless netavark honours `--internal` and a two-network sidecar is the only egress, once the internal network is created with `--disable-dns` (**adjusted**); `:Z` plus `--userns=keep-id` behave under enforcing SELinux (**verified**).

## 3. Threat model recap and what the container changes

Taken from reviewer 07 (cos.md) HIGH2 and MED4:

| Threat | Today (20e49f9) | With the container |
|---|---|---|
| Read `~/.config/.wrangler`, `~/.config/gh`, `~/.claude`, `~/.npmrc` | Possible: HOME is inherited and Read/Edit/Write are unscoped. | Not mounted, so not reachable. The container HOME is an empty per-Build dir. |
| Write `~/code/argus`, `~/.bashrc`, the template | Possible. | Only the Build repo and scratch HOME are writable; rootfs is read-only. The template is cloned by the host before the container exists and is never mounted. |
| Arbitrary code via dependency lifecycle scripts, `pnpm test`, git hooks via `mv` | Runs as the Operator on the host. | Runs as an unprivileged mapped user inside the container with no capabilities. |
| Exfiltration over the network | Open. | Only the two allowlisted hosts are reachable (section 5). |
| Orphan grandchildren after a kill | Only the claude pid is killed. | The container has its own PID namespace; stopping it kills everything in it. |

Not changed by the container (still argus's job, and the repo is the untrusted artifact):

- The repo comes back from the container as untrusted bytes, including `.git/` (config, hooks, objects, refs). The host must keep treating it that way: fresh-clone push (HIGH3 fix), `SAFE_GIT`, argus-owned `wrangler.jsonc`, and the protected-path comparison against the template commit. Suggest the HIGH3 worker also pass `--no-replace-objects` so `git replace` refs in the agent-written `.git` cannot alter what `git diff templateCommit..head` compares.
- Never run anything from the returned `node_modules` on the host (already the rule: global `wrangler`, argus's own `checkDisclosure`). Wrangler bundles and reads `src/` and `node_modules` at deploy time, which is data reading, not execution of their scripts; the argus-owned `wrangler.jsonc` fix removes the config-driven paths.
- Whatever the agent can read inside the container can be sent to an allowlisted host. That is the token (inference-only, section 4.3) and the repo (already going to Anthropic as prompts). The residual gaps are in 5.4.

The docs say the same thing: "Any approach that allows network egress can still leak data the agent can read, and any approach that mounts your project directory writable can still modify that code" (code.claude.com/docs/en/sandbox-environments).

## 4. The container

### 4.1 What goes in

Mounts (the only two):

| Host | Container | Mode | Why |
|---|---|---|---|
| `~/code/<slug>` | same absolute path | rw, `:Z` | The repo. Same path so `claude --resume` finds the session by cwd (4.4). |
| `.data/proposals/<id>/home` | `/home/agent` | rw, `:Z` | `HOME`, `CLAUDE_CONFIG_DIR=/home/agent/.claude`, pnpm store and caches. Per Build, not shared, so a poisoned cache cannot carry to the next Build. |

Explicitly not mounted: the user's HOME or any of its subdirs, `~/code` itself, `argus/.data` beyond the one `home` dir, `argus-build-template`, any podman/docker socket, any `--device`. No `--privileged`, no `--network host`, no `--env-host` (podman: "--env-host: Use host environment inside of the container").

Environment, set only by explicit `--env NAME=value` flags (the container starts from the image's env, so there is nothing to scrub):

- `CLAUDE_CODE_OAUTH_TOKEN`: passed as `--env CLAUDE_CODE_OAUTH_TOKEN` with no value, which podman fills from the `podman` client's own environment ("If an environment variable is specified without a value, Podman checks the host environment for a value", podman-run). This keeps the token out of argv and `ps`. It does appear in `podman inspect` for the lifetime of the `--rm` container; that is the same user, so no new exposure. `ANTHROPIC_API_KEY` is never set; with it unset the OAuth token is used (authentication precedence, code.claude.com/docs/en/authentication). The token "can only make model requests" and "does not save the token anywhere" (same page).
- `HOME=/home/agent`, `CLAUDE_CONFIG_DIR=/home/agent/.claude`
- `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` (already set by `ClaudeCodeBrain`)
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1` (devcontainer page: telemetry opt-out and no self-update; also removes the Datadog hosts from the allowlist)
- `HTTPS_PROXY`, `https_proxy`, `NO_PROXY=` (5.2), plus the npm/pnpm proxy variables (**verified**: npm 10.9.9 and pnpm 11.2.2 honour `HTTPS_PROXY`/`https_proxy` from the environment; no `/etc/npmrc` needed)
- `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL` = `argus` / `argus@localhost`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`. The agent's `git commit` currently relies on the Operator's `~/.gitconfig` for identity; that file is gone inside the container, so identity must be explicit.
- `CI=1`

The `claude` argv is unchanged: `ClaudeCodeBrain.buildArgs` output (`--max-budget-usd`, `--permission-mode acceptEdits`, scoped `--allowedTools`, `--strict-mcp-config --setting-sources project`, `stream-json --verbose`) is appended after the image name. The `--tools`/`--allowedTools` scoping stays as defence in depth; the container is the boundary, the tool scope is a seatbelt.

### 4.2 Flags (proposed `podman run` shape)

```
podman run --rm --name argus-build-<id>-<nonce> --label argus.build=<id> \
  --pull=never --init --log-driver=none \
  --userns=keep-id --cap-drop=all --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=2g \
  --pids-limit 1024 --memory <cap> --cpus <cap> \
  --timeout <build timeout + 60 s> \
  --network argus-build-net \
  -v <repo>:<repo>:Z -v <data>/proposals/<id>/home:/home/agent:Z -w <repo> \
  --env ... localhost/argus-build:<tag> claude <buildArgs...>
```

Why each, with sources:

- `--userns=keep-id`: "creates a user namespace where the current user's UID:GID are mapped to the same values in the container" (podman-run). Files the agent writes in the bind mounts belong to the Operator on the host, so argus reads and the Operator resumes without chown. The agent runs as a non-root uid, which Claude Code also requires for the bypass flags ("Claude Code refuses to start with this flag when running as root", sandbox-environments; argus does not use the bypass flag, this is a bonus).
- `:Z`: SELinux is enforcing here. "The Z option tells Podman to label the content with a private unshared label" (podman-run `--mount` options). It relabels the mounted directory; apply it only to the per-slug repo dir and the per-Build home, never to `~/code` or `$HOME`. Without it the agent gets permission denied. `--security-opt label=disable` ("Turn off label separation for the container") works but removes MCS isolation between containers; avoid.
- `--cap-drop=all`, `no-new-privileges` ("Disable container processes from gaining additional privileges through the execve(2) system call"), `--read-only` ("Mount the container's root filesystem as read-only"): standard hardening. `--read-only-tmpfs` defaults to true, so `/tmp`, `/run`, `/dev/shm`, `/var/tmp` are tmpfs; **Adjusted**: `--tmpfs /tmp:rw,nosuid,nodev,size=2g` is NOT `noexec` (the default options only apply when none are given), and the implicit `/tmp`, `/run`, `/var/tmp` tmpfs are exec too; only `/dev/shm` is `noexec`. Add `noexec` explicitly (`--tmpfs /tmp:rw,noexec,nosuid,nodev,size=2g`). **Verified**: `pnpm check` (tsc, oxlint, vitest, both html checks) passes in the template with `--read-only` and that `noexec` `/tmp`.
- `--init` ("Run an init inside the container that forwards signals and reaps processes"): claude spawns shells and pnpm spawns workers; without an init, zombies and signal handling are wrong.
- `--pids-limit`, `--memory`, `--cpus`: "The default is 0.0 which means no limit" for cpus and memory 0 means unlimited (podman-run), so the caps must be explicit. A fork bomb or a runaway vitest stays in the container's cgroup (cgroups v2 with pids and memory controllers confirmed on this host).
- `--pull=never` ("missing: Pull the image only when the image is not in the local containers storage" is the default; `never` fails instead). The worker must never fetch an image during a Build.
- `--log-driver=none`: stdout is already consumed by the worker. podman lists `k8s-file, journald, none, passthrough` and defaults to journald; journald would copy every stream-json line (the repo's contents, tool output) into the system journal. **Verified**: an attached `podman run --log-driver=none` still streams stdout and stderr incrementally and separately, passes 50 MB intact and propagates the exit code; a marker written under `none` was absent from the system and user journals while `journald` put it in both. No `k8s-file` fallback needed.
- `--timeout`: "Maximum time a container is allowed to run before conmon sends it the kill signal." This is enforced by conmon, not the worker, so a worker crash still ends the Build at the wall clock. Set to the route timeout plus a minute so the worker's own, cleaner timeout fires first in normal operation.
- No `--hostname`, `--dns`, `--add-host` games needed; DNS is handled by the network (5.1).

Not rootful, not `--privileged`, no nested container runtime. Claude Code's own Bash sandbox is not enabled inside (it would need bubblewrap and extra permissions in an unprivileged container, per sandbox-environments).

### 4.3 Token

Use `claude setup-token`'s output as `CLAUDE_CODE_OAUTH_TOKEN` (architecture §5 already does this for the brain). Facts from the authentication page: one-year token, needs a paid plan, "can only make model requests" (cannot establish Remote Control or fetch claude.ai connectors), and `--bare` does not read it (argus does not use `--bare`). Whether the token path also contacts `platform.claude.com` (refresh) or `claude.ai` is not stated for `CLAUDE_CODE_OAUTH_TOKEN`; the sandbox runtime page says "OAuth sign-in and token refresh" need them and "Runs authenticated with an API key can drop these two". **Partly answered, open for a real token** (section 14): with an invalid placeholder token in `CLAUDE_CODE_OAUTH_TOKEN` the only host `claude` 2.1.318 contacted was `api.anthropic.com:443`, with and without `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. The allowlist stays `api.anthropic.com` and `registry.npmjs.org` until the Operator runs the one-command check with the real Build token.

Open choice: reuse the brain's token or mint a second one just for Builds (question 4).

### 4.4 Sessions, resume, logs

- Session transcripts land in `CLAUDE_CONFIG_DIR` inside the per-Build home, not in the Operator's `~/.claude`. Claude Code keys sessions by project directory, which is why the repo is mounted at the same absolute path. To resume a `build-failed` Build (ticket 08's card command) the Operator runs on the host: `cd ~/code/<slug> && CLAUDE_CONFIG_DIR=<argus>/.data/proposals/<id>/home/.claude claude --resume <session_id>`. The card should print exactly that. (`CLAUDE_CONFIG_DIR` semantics: devcontainer page and authentication page. **Verified** with a container-written session: `CLAUDE_CONFIG_DIR=<home>/.claude claude -p --resume <id>` on the host finds it and keeps the session id; a wrong id gives `No conversation found`. **Adjusted**: it was also found from a different cwd, so the same-path mount is harmless but not required for `--resume` by id. Not tested: the interactive TUI, and a session with real content (the only session available was an authentication failure).)
- Streaming: `podman run` without `-t` and without `-d` stays attached and relays the container's stdout to the client's stdout, so the existing `exec()` in `brain.ts` (pipes, `onOutput`, `build.log`) is unchanged. The sidecar's denial lines are appended to the same log as `# argus-egress: denied <host>` notes.
- The retry in ticket 08 starts a fresh container on the same repo dir and home dir after the runner resets the tree; container identity (`--name`) has a nonce so a leftover cannot collide.

## 5. Network

### 5.1 What podman can and cannot do (verified from docs)

- Podman has no domain allowlist. The `podman-run` network options (`none`, `host`, `private`, `pasta`, bridge) are all connectivity modes; `--dns`, `--dns-search`, `--add-host` change resolution only. Nothing in podman-run or podman-network-create filters by hostname. (Absence in the two pages read; netavark's own docs were not exhaustively read.)
- Rootless default is `pasta` ("This is the default for rootless containers and only supported in rootless mode"). pasta options visible in podman-run are about port forwarding and reaching the host (`-t`/`-u`/`-T`/`-U`, `--map-gw`, `--map-guest-addr`); none restricts outbound destinations. `-T none -U none` only stop container-to-host forwarding.
- `--network none`: "Create a network namespace for the container but do not configure network interfaces for it". Total isolation, which is also useless for `api.anthropic.com` unless something is bridged in.
- `podman network create --internal`: for bridge networks "Restrict external access of this network", implemented by disabling IP forwarding on the bridge and adding no default route to the container; aardvark-dns "resolves only container names, and other queries return NXDOMAIN" on internal networks (podman-network-create). So containers on it can talk to each other and nothing else, and external DNS names do not resolve (which also closes DNS-tunnelling exfiltration). **Verified, with one correction**: this holds, but a dual-homed sidecar then inherits that NXDOMAIN-only resolver as its only nameserver (the default `podman` network has no DNS of its own, `--dns` is appended after it, network order does not help), so the sidecar cannot resolve upstream. Fix: create the internal network with `--disable-dns`; the sidecar then gets the host's resolvers and the Build container has no DNS server at all (section 14).
- A container can join several networks (`--network` can be given multiple times; `--ip` only works with a single network).

### 5.2 Chosen mechanism: internal network plus allowlist proxy sidecar

```
Build container  --(argus-build-net, internal, no route)-->  proxy sidecar  --(second network, pasta egress)-->  internet
  HTTPS_PROXY=http://<sidecar>:3128                           CONNECT allowlist
```

- One-time: `podman network create --internal --disable-dns --subnet 10.89.77.0/24 --gateway 10.89.77.1 argus-build-net` (**adjusted** with `--disable-dns`; created on this host with that exact subnet, which clashes with neither `podman` 10.88.0.0/16 nor the Supabase network 10.89.0.0/24; the sidecar gets a fixed address so the Build container needs no DNS for it). A fixed address allows one sidecar at a time: a second `--network argus-build-net:ip=10.89.77.2` fails with `IPAM error: requested ip address ... is already allocated`, so either serialise Builds or allocate a distinct address per Build.
- Per Build, before the Build container: `podman run -d --rm --name argus-egress-<id>-<nonce> --label argus.build=<id> --network argus-build-net:ip=10.89.77.2 --network podman --cap-drop=all --read-only --security-opt no-new-privileges --userns=keep-id <image> node /opt/argus/egress-proxy.mjs`, config by `--env ARGUS_EGRESS_ALLOW=api.anthropic.com:443,registry.npmjs.org:443`. Same image as the Build, different command (one image to build and pin). The worker waits for the proxy's "listening" line, then starts the Build container, and removes the sidecar in `finally` and in startup reconciliation.
- The proxy accepts only `CONNECT host:port` where `host:port` is in the allowlist (exact match, no wildcards in v1), refuses every other method (so no plain-HTTP forwarding), resolves the name itself, refuses loopback, private, link-local and CGNAT answers, and logs every denial to stdout. It tunnels bytes and does not terminate TLS, so there is no CA to install and no MITM of Anthropic traffic.
- Claude Code honours `HTTPS_PROXY`/`https_proxy`, and `NO_PROXY`; "Claude Code does not support SOCKS proxies" (network-config), which is why the proxy speaks HTTP CONNECT. pnpm reads proxy settings from `.npmrc` (`httpsProxy`, pnpm.io/settings); **Verified**: pnpm 11.2.2 and npm 10.9.9 both honour `HTTPS_PROXY`/`https_proxy` from the environment (`pnpm install --frozen-lockfile` of the template: 47 CONNECTs to `registry.npmjs.org:443` in the sidecar log; without the variables it hangs on the unreachable network). No `/etc/npmrc` needed.
- Because the Build container has no route at all, a client that ignores the proxy variables simply fails; the allowlist is enforced by topology, not by cooperation. That is the main reason to prefer this over an in-container firewall.

Allowlist (network-config "Network access requirements"): `api.anthropic.com` (Claude API) and `registry.npmjs.org` (the npm package registry; also used for plugin installs and npm installs). With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` the Datadog hosts are not needed; `downloads.claude.ai` is only for updates (disabled); `github.com` is deliberately absent (dependencies whose postinstall downloads release assets from GitHub will fail; template has `allowBuilds` for `esbuild` and `workerd` only, which ship via npm).

### 5.3 Alternatives considered

1. **Reference devcontainer firewall (`init-firewall.sh`, iptables default-deny).** Anthropic's example; it "adds the `NET_ADMIN` and `NET_RAW` capabilities" and notes they "are not required for Claude Code itself" (devcontainer page). Rejected: needs capabilities in the same container the agent controls (it could flush the rules unless caps are dropped after setup, which needs a root entrypoint), and resolves domains to IPs once, which goes stale for CDN-fronted hosts.
2. **pasta plus a host-side proxy.** pasta gives the container full outbound, so a proxy on the host would be advisory. Rejected.
3. **`--network none` plus a bind-mounted Unix socket to a proxy in the worker, bridged to loopback in the container.** Structurally the tightest and needs no `podman network create`, and the proxy would live in the worker process. Not chosen as the default because connecting from `container_t` to a host process socket under SELinux enforcing very likely needs `--security-opt label=disable` or a policy tweak (**untested**: not needed, because the internal network worked rootless), which weakens the very isolation we want. Kept as the fallback if the internal network misbehaves rootless; not tried in the spike.
4. **Claude Code's built-in sandbox / dedicated Linux user.** Already rejected by the Operator.

### 5.4 Gaps (what this does not stop)

- **Domain fronting / CDN co-tenancy.** The proxy checks the CONNECT hostname, not the TLS SNI or the inner Host header. A client could CONNECT to an allowed host and then ask the CDN for another tenant. Mitigation would require TLS interception; not proposed. Low practical risk because the agent has no credential for anything but the model API.
- **The allowed hosts themselves are channels.** The token can be used against `api.anthropic.com` (the Operator's own account, inference only, per the docs) and the agent could embed repo content in model requests (it already sends the repo as prompt). Package names in registry GETs are a theoretical one-way channel to anyone who can read npm's logs. The container therefore protects the host and the Operator's other credentials; it does not make the repo secret from the model provider.
- **Token theft by the agent is possible by design** (it is in env). Blast radius is model usage on the Operator's subscription until the token is rotated. The `--max-budget-usd` flag bounds a single run, not a stolen token. Treat as a known residual; rotate yearly or after any suspected incident.
- **pnpm lifecycle scripts still run inside the container** for packages the agent adds to `allowBuilds` in `pnpm-workspace.yaml` (not a protected path). Contained, but the Build repo's committed result can carry whatever the agent wrote; argus never executes it on the host.
- **Sidecar compromise.** The proxy is small argus code running unprivileged with no mounts; a bug in it is the one place the egress policy can fail open. It gets the strictest tests (ticket 14).
- **Verified on this host:** rootless netavark internal network plus two-network sidecar (ticket 12, section 14), with `--disable-dns`.

## 6. Image

- **Base:** `docker.io/library/node:22-bookworm-slim`, pinned by digest in the `Containerfile` (`FROM ...@sha256:...`). Debian (glibc), not Alpine: the template pulls `workerd`, which has no musl build, and Claude Code on musl needs extra packages and `USE_BUILTIN_RIPGREP=0` (setup page). Node 22 matches the template's `engines: >=22.18` and the npm package's "Node.js 22 or later" requirement. The digest is recorded by the Operator when bumping; the note does not invent one.
- **Added with apt (build time only):** `git`, `ca-certificates`. Nothing else; no curl, no wget, no ssh client, no gh, no wrangler.
- **pnpm:** `npm install -g pnpm@11.2.2` (the template's `packageManager` pin), exact.
- **Claude Code:** `npm install -g @anthropic-ai/claude-code@2.1.318` (exact; the devcontainer page recommends exactly this for reproducible builds, with `DISABLE_AUTOUPDATER=1`). The npm package installs the same native binary through a per-platform optional dependency (`linux-x64`; `linux-x64-musl` exists but is not used) and "the installed `claude` binary does not itself invoke Node" (setup page). Do not use `sudo`; install as the unprivileged build user or set an npm prefix.
- **argus files baked in:** `/opt/argus/egress-proxy.mjs` (the sidecar). The `/implement-spec` skill stays in the template repo (ADR 0003), not in the image.
- **Tag:** `localhost/argus-build:cc2.1.318-n22.<minor>-p11.2.2-<short hash of Containerfile and proxy file>`. The worker's config names the tag; it never uses `latest`.
- **Who builds, when:** the Operator, with `pnpm image:build` (script wraps `podman build`, creates the internal network if absent, prints the tag). Rebuild when bumping Claude Code, Node, pnpm or the proxy. The worker only checks (`podman image exists <tag>`) at startup and before each Build and refuses to start a Build without it; it never builds or pulls. Rationale: a build needs the open network and the registry, which is exactly what the run-time policy denies, and an unattended worker should not silently change what it executes.
- Image supply chain: base by digest, Claude Code and pnpm by exact version from npm over TLS. The base image digest and the npm packages are trusted at build time; there is no signature verification beyond npm's integrity hashes (the binary's signed manifest is documented for the native installer, not the npm route; acceptable, noted).
- The host's Claude Code (2.1.318) and the image's are decoupled; the brain tasks (judge, propose, spec) still run on the host.

## 7. Spawn, kill, timeouts

Interface: introduce a `SandboxRunner` seam in `ClaudeCodeBrain`/`exec()`:

```
prepare(ctx): { command, args, env, cwd }   // podman run ... image claude <args>
stop(handle): Promise<void>                 // podman stop -t 5 <name>; podman rm -f <name>
```

The default (host) implementation keeps today's behaviour for judge/propose/spec. The build route selects the podman implementation. The worker passes the podman client a minimal environment: `PATH`, `HOME`, `XDG_RUNTIME_DIR` (podman needs these to find its rootless store and runtime dir) and `CLAUDE_CODE_OAUTH_TOKEN` for the passthrough. The container's environment is only what section 4.1 lists.

Kill story, with facts:

- `podman run` proxies signals to the container process by default (`--sig-proxy`, default true) but "SIGCHLD, SIGURG, SIGSTOP, and SIGKILL are not proxied" (podman-run). So `SIGTERM` to the client works; `SIGKILL` of the client (the current `killChild` escalation) kills only the client and leaves the container running under conmon. That is the one behavioural trap of this design.
- Therefore the kill path is by name: on timeout, abort, or shutdown, call `podman stop -t 5 <name>` ("By default, containers are stopped with SIGTERM and then SIGKILL after the timeout", `--time` default 10, podman-stop), then `podman rm -f <name>`, then reap the client. `--init` is PID 1, so claude, pnpm, vitest and every grandchild die with the container's PID namespace, which is the process-group fix for MED4 without process groups. The sidecar is removed the same way.
- Backstops: `--timeout` (conmon kills at the wall clock even if the worker is gone) and startup reconciliation: on worker start, `podman ps -a --filter label=argus.build --format json`, stop and remove anything found, and note it in the log. Labels (`argus.build=<proposal id>`) keep this from touching the Operator's other 12 containers.
- Timeouts unchanged in value: `TaskRoute.timeoutMs` (4 h build) and `--max-budget-usd`, `--max-turns` if any, all passed through untouched. Budget flags are inside the `claude` argv, so nothing about spend caps moves. A container killed by `--timeout` yields no `result` line, same as today's timed-out case ($0 recorded, ticket 07's noted undercount).
- Run-row crash story (MED5) is independent: with the sidecar and label, a crashed worker's leftovers are reconciled at startup in the same place the stale run row is.

## 8. Push and deploy stay outside

Unchanged and, with containment, easier to reason about: the container has no `gh`, no GitHub or Cloudflare token, no route to either. The runner (host) clones the template, creates the repo, writes the Spec, pushes the Spec commit, runs the container, then verifies and deploys using the global `wrangler` and its own env. The final push uses a fresh clone or bundle per the HIGH3 fix. The agent's work reaches GitHub only through that host-side path.

## 9. Tests and `verify:boot`

Hermetic by default (`pnpm check` must not need podman, per project convention of fakes for claude, gh, wrangler):

- **Pure argv builder** `buildPodmanRunArgs(config)`: unit tests assert the policy, not the string. Must contain `--cap-drop=all`, `--read-only`, `no-new-privileges`, `--pull=never`, `--userns=keep-id`, the `--timeout`, an `--env` for `CLAUDE_CODE_OAUTH_TOKEN` without value; must not contain `--privileged`, `--network host`, `--env-host`, `--device`, a mount outside the two allowed, any env name outside the allowlist, `ANTHROPIC_API_KEY`, `GH_TOKEN`, `CLOUDFLARE_*`. A test fails if a new mount or env var is added without updating the allowlist.
- **Fake `podman` executable** (`packages/core/src/testing/fake-podman.mjs`, like `fake-claude.mjs`, `fake-gh.mjs`): parses `run`, `stop`, `rm`, `ps`, `image exists`, `network exists`; for `run` of the build container it maps the in-container path back and execs the existing fake claude in the repo dir. Existing runner tests (`build-runner.test.ts`, `build-runner-verify.test.ts`) switch to it and keep their assertions. New tests: stop is invoked on timeout, on abort and on shutdown; the sidecar is started first and always removed (including on failure); a leftover labelled container is reconciled at startup; missing image or missing podman makes the worker refuse a Build with a clear log and leaves the Proposal `approved`; dry run logs the full `podman run` and sidecar commands and runs none.
- **Egress proxy unit tests** with real loopback sockets and a local fake upstream: allowed CONNECT is tunnelled; non-allowlisted host, non-443 port, plain `GET http://...`, absolute-URI requests, IP-literal hosts, hosts resolving to loopback or private ranges are all refused and logged; slow clients and oversized headers do not hang it.
- **`verify:boot`** (no podman): extend the Build dry-run step's `REQUIRED_BUILD_LINES` with `podman run`, `--cap-drop=all`, `--read-only`, `--network argus-build-net` and the sidecar line, and add forbidden-substring checks (`--privileged`, `--network host`, the Operator's HOME path as a mount source). The existing step 3 (no survivors from the worker's process group) stays.
- **`pnpm verify:contain`** (new, real podman, not part of `pnpm check`, run by the verifier on a machine that has the image; prints SKIP with the reason when podman or the image is missing): from inside the real container, assert that `~/.config`, `~/.ssh`, `~/.npmrc` of the host user do not exist; a write outside the repo and home fails; `curl`-equivalent via Node to `https://example.com` fails with and without the proxy; `https://registry.npmjs.org` through the proxy succeeds; `pnpm install` of the template's lockfile succeeds through the proxy; a grandchild `sleep` started by the agent is gone after `podman stop`; `--timeout` kills a container the worker abandoned; `claude -p` with a real token answers a one-line prompt (opt-in via env, costs a few cents). This is where HIGH2 and MED4 are shown fixed, so the reviewer can re-test against it.

## 10. Rollout and ordering

1. Spike first (ticket 12), on this machine, because four assumptions were unproven (internal network rootless, SELinux mounts and sockets, attached streaming with `--log-driver=none`, pnpm proxy env). Done: section 14.
2. Image, proxy, then the runner seam; verification last; docs with the ADR.
3. Until ticket 15 lands, keep the current gate: no real Build (ticket 10 acceptance run stays blocked). After it lands, containment is mandatory for non-dry-run Builds: no "run uncontained" switch except tests' fake binary (open question 7).
4. Ticket 08 (retry, caps) should build on the seam; it needs the stop path and the reset-between-attempts to work with the per-Build home. Suggest 08 is blocked by 15 or lands after.

## 11. Open questions for the Operator

1. **Image builds**: OK that the Operator runs `pnpm image:build` by hand when bumping Claude Code, Node or pnpm, with the worker refusing to start Builds when the pinned tag is missing? Alternative: the worker builds on first use (needs open network, silently changes what runs). Recommendation: manual.
2. **Allowlist**: start with only `api.anthropic.com` and `registry.npmjs.org`? Add `platform.claude.com` only if the spike shows the setup-token path needs it. Keep `github.com` out even if some dependency postinstalls then fail (they fail the Build, which is the safe outcome)?
3. **Network creation**: one-time `podman network create --internal argus-build-net` (and a fixed subnet that must not clash with the Supabase network already on this machine). OK?
4. **Token**: reuse the brain's `CLAUDE_CODE_OAUTH_TOKEN` or mint a second one for Builds so it can be rotated separately (via `claude setup-token`; whether tokens can be revoked individually is not stated in the docs read)? The Build holds it in env for up to 4 h.
5. **Resume workflow**: is `CLAUDE_CONFIG_DIR=<argus>/.data/proposals/<id>/home/.claude claude --resume <id>` acceptable for the Operator's tmux recovery (ticket 08), given Builds no longer write to `~/.claude`?
6. **Resource caps**: defaults proposed 8 GiB memory, 4 CPUs, 1024 pids, 2 GiB `/tmp`. The machine showed about 1.4 GiB free at check time (31 GiB total). Lower the cap, or accept?
7. **Escape hatch**: no "uncontained" mode beyond `--dry-run` and the fake binary in tests. Agree, or do you want a debug override?
8. **Per-Build home retention**: keep for `build-failed` (resume) and delete on `built`/`dismissed`, or keep everything for N days? Rough size is the pnpm store plus transcripts, hundreds of MB per Build.
9. **Scope**: should judge and propose (which use WebFetch/WebSearch on untrusted web content) later run in the same kind of container with their own allowlist? Out of scope here; the seam makes it a config change.

## 12. Proposed tickets (continue numbering in `.scratch/phase-1-build-path/issues/`; style of 06 to 08)

### 12: Spike: prove rootless podman containment on this host
**Model:** sonnet / high — hands-on environment debugging with unknowns; output is facts in this note.

**What to build:** By hand (no argus code), prove the unverified parts on this machine and record answers under `## Answers` in this note: create `argus-build-net --internal`, run a two-network sidecar and a Build container, confirm no route and no DNS from the Build container; `:Z` mounts and `--userns=keep-id` under enforcing SELinux; attached `podman run` streaming with `--log-driver=none` (else `k8s-file`); `podman stop` kills grandchildren; `--timeout` fires without the client; pnpm proxy via env or `/etc/npmrc`; `claude -p` with a setup-token through the proxy (which hosts it contacts); a host-side `claude --resume` of a container-written session; `pnpm test` in the template under `--read-only` and `noexec` `/tmp`.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] Each unverified claim in sections 4 to 7 is marked confirmed, refuted or adjusted, with the command and output
- [ ] The final `claude` hostnames the sidecar saw are listed, and the allowlist decision recorded
- [ ] If the internal network fails rootless, alternative 3 (socket) is tried and the choice updated
- [ ] No images pulled beyond the one base image; no existing containers, images or networks touched; test objects removed afterwards

### 13: Build image and `pnpm image:build`
**Model:** sonnet / medium — Containerfile and a small script, versions pinned per section 6.

**What to build:** `containers/build/Containerfile` (digest-pinned Node 22 bookworm-slim, git, pinned pnpm and Claude Code, unprivileged user matching `--userns=keep-id`, `egress-proxy.mjs` copied in), `scripts/image-build.mjs` (computes the tag, `podman build`, idempotently creates the internal network), and a preflight helper `imageReady()` the worker will call.

**Blocked by:** 12, 14

**Status:** ready-for-agent

- [ ] Image builds on this host; `claude --version`, `pnpm --version`, `node --version` print the pinned versions
- [ ] Tag derives from the pinned versions and a content hash; no `latest`
- [ ] The image contains no gh, wrangler, ssh, curl; a test lists installed binaries against an allowlist
- [ ] `imageReady()` is false when the tag is absent (tested with the fake podman)
- [ ] `pnpm check` passes

### 14: Egress allowlist proxy
**Model:** sonnet / high — security-critical, small, exhaustively tested.

**What to build:** `packages/core/src/egress-proxy.ts` (plus the `.mjs` entry baked into the image): HTTP CONNECT-only proxy per section 5.2, allowlist from env, denial logging to stdout, private-address refusal.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Allowed CONNECT is tunnelled to a local fake upstream; every case in section 9's proxy list is refused and logged
- [ ] No wildcard or suffix matching in v1; hostnames compared case-insensitively and without trailing dot tricks
- [ ] Resolves and checks the address it actually connects to (no check-then-resolve gap)
- [ ] Idle and header-size limits; no unbounded buffers
- [ ] `pnpm check` passes

### 15: Run the Build agent in the container
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

### 16: Containment verification (`verify:contain`) and `verify:boot` extension
**Model:** sonnet / medium — scripted checks against real podman and the dry-run output.

**What to build:** `scripts/verify-contain.mjs` per section 9 (SKIP with reason when podman or the image is missing), and the `verify:boot` additions (required `podman run` flags, forbidden substrings).

**Blocked by:** 15

**Status:** ready-for-agent

- [ ] `pnpm verify:contain` passes on this host with the image built; every HIGH2 and MED4 bullet in the reviewer's list has a corresponding check
- [ ] Skips cleanly (exit 0, prints SKIP) without podman; never pulls or builds
- [ ] `pnpm verify:boot` passes and fails if the dry run drops a required flag or adds `--privileged`
- [ ] `pnpm check` passes

### 17: Docs and ADR for containment
**Model:** sonnet / low — documentation only.

**What to build:** ADR `0005-builds-run-in-a-rootless-podman-container` (decision, rejected options, consequences), update `docs/architecture.md` §4 (command shape inside the container, scoped env paragraph) and §10 invariant 1, add the Operator setup steps (image build, network, token, resume command), and mark 07 findings HIGH2 and MED4 resolved in the journal.

**Blocked by:** 15

**Status:** ready-for-agent

- [ ] ADR records the Operator's answers to questions 1 to 9
- [ ] Architecture §4 and §10 match the implemented behaviour
- [ ] Ticket 10's acceptance run lists "image built, network created, token set" as prerequisites

## 13. Operator decisions (2026-11-05)

- Q1, Q2, Q3, Q5, Q7, Q9: accepted as recommended.
- Q4 Token: a separate `claude setup-token` token for Builds only, rotated independently of the brain's token. The Operator mints it.
- Q6 Resource caps: 8 GiB memory, 4 CPUs, 1024 pids, 2 GiB /tmp.
- Npm dependencies (decided after ticket 07 round 3, commit 1fcdf6d): the deploy bundle step (`wrangler deploy --dry-run --outdir --metafile`) runs inside the Build container, where `node_modules` exists but no host files do. argus then checks the metafile on the host and uploads with `--no-bundle`. Until ticket 15 lands, Builds bundle from a clean `git archive` export on the host, so only Workers with no runtime npm dependencies can build.
- Q8 Retention: keep the per-Build home for `build-failed`; delete it on `built` and `dismissed`.

## 14. Answers (ticket 12 spike, 2026-11-05)

Run by hand on this host (podman 5.8.7, rootless, netavark, SELinux enforcing), no argus code. Image `docker.io/library/node:22-bookworm-slim` (id 8700da48cc6592503feabf399d242414f932197c3b44f43970d2cbc5671e06b0, digest `sha256:aaa4b5baf1ecff3b283486bb1f90405cdda225a3e6f79660d2c559fa510a7292`, node 22.23.4, npm 10.9.9) was the only pull. pnpm 11.2.2 and `@anthropic-ai/claude-code@2.1.318` were installed with npm into a mounted scratch dir through the proxy, so no custom image was built. The sidecar was a 20-line Node CONNECT allowlist proxy (spike code, not kept). The scratch dir (`~/.cache/argus-spike`) and all `argus-spike-*` containers were removed afterwards; `argus-build-net` and the node image stay. Commands are abbreviated; `RUN` = `podman run --rm --pull=never --init --userns=keep-id --cap-drop=all --security-opt no-new-privileges --read-only --log-driver=none`.

| Claim | Result | Evidence |
|---|---|---|
| `--internal` network works rootless; no route, no DNS from the Build container | **Verified** | `podman network create --internal --disable-dns --subnet 10.89.77.0/24 --gateway 10.89.77.1 argus-build-net`. In `RUN --network argus-build-net ... node probe.mjs`: `/proc/net/route` has one route (10.89.77.0/24); TCP to 1.1.1.1:443, 8.8.8.8:53, 192.168.1.1:80, 10.88.0.1:22 and IPv6 2606:4700:4700::1111 all `ENETUNREACH`; UDP DNS to 192.168.1.1, 169.254.1.1, 1.1.1.1 `ECONNREFUSED`; `getaddrinfo` `EAI_AGAIN` for every name; the net gateway 10.89.77.1 refuses port 22. With DNS left enabled the same names gave `ENOTFOUND` (aardvark NXDOMAIN). |
| Two-network sidecar is the only egress | **Verified, adjusted** | Sidecar `--network argus-build-net:ip=10.89.77.2 --network podman`. Build container `CONNECT` through it: `api.anthropic.com:443` and `registry.npmjs.org:443` tunnel (TLS, 404 and 200); `github.com:443`, `platform.claude.com:443`, `api.anthropic.com:80` get 403 from the proxy and are logged. Adjusted: needs `--disable-dns` on the network (see 5.1). A second sidecar with the same fixed IP fails (IPAM error). |
| `:Z` and `--userns=keep-id` under enforcing SELinux | **Verified** | Without `:Z`: `cat` and `touch` in the bind mount give `Permission denied`. With `:Z`: read, create file and dir work, host `ls -ln` shows uid/gid 1000 (the Operator), label `container_file_t:s0:cNNN,cMMM`. Process runs as `uid=1000(node)`; rootfs and `/home/node` writes fail with `Read-only file system`. `uid_map`: `0 1 1000`, `1000 0 1`, `1001 1001 64536`. |
| Attached `podman run --log-driver=none` streams | **Verified** | stdout lines arrived one per second as produced; 50 MiB through a pipe intact (52428800 bytes) with 1000 stderr bytes separate; `exit 7` returned 7; marker absent from journald while `--log-driver=journald` put it there. |
| `podman stop` kills grandchildren; client SIGKILL leaves the container | **Verified** | `sh -c 'sleep A & (sleep B & sleep C) & wait'` under `--init`: SIGTERM to the client stopped the container (client exit 143, no sleeps left). SIGKILL of the client left `argus-spike-k2 Up`; `podman stop -t 5 argus-spike-k2` took 0.1 s, container gone (`--rm`), no sleeps left. A grandchild with `trap '' TERM`: `stop -t 2` warned and SIGKILLed after 2.09 s, none left. `podman rm -f` is then unnecessary with `--rm` (not run: blocked by the harness's removal check). |
| `--timeout` fires without the client | **Verified** | `--timeout 8`, client SIGKILLed at +2 s, TERM ignored in the container: container and its `sleep` gone at about +9 s after start, by conmon alone. |
| pnpm/npm proxy via environment | **Verified** | See 5.2: `HTTPS_PROXY`/`https_proxy` is enough; `NO_PROXY=` empty. |
| `pnpm test` / `pnpm check` under `--read-only` and `noexec` `/tmp` | **Verified** | `RUN --tmpfs /tmp:rw,noexec,nosuid,nodev,size=2g --pids-limit 1024 --memory 8g --cpus 4`, repo and home `:Z`: `pnpm install --frozen-lockfile` (esbuild and workerd postinstalls ran), `pnpm check` all green in 6 s. cgroup files inside: `memory.max 8589934592`, `pids.max 1024`, `cpu.max 400000 100000`, so the rootless caps apply. |
| `--env NAME` without value passes the client's value | **Verified** | Value visible in the container, absent from `ps -eo args` (0 matches), present once in `podman inspect` Config.Env. The container env contains only `HOME HOSTNAME NODE_VERSION PATH PWD YARN_VERSION container` plus what is passed. |
| `claude -p` hostnames through the sidecar | **Partly; open** | Placeholder token `sk-ant-oat01-spike-invalid-token` (no real token exists yet): `claude` 2.1.318 stream-json run returned `authentication_failed` 401 retries; the sidecar saw only `api.anthropic.com:443` (3 CONNECTs with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1`, 11 without). No `platform.claude.com`, `claude.ai`, `downloads.claude.ai` or Datadog attempt. With a valid token a refresh or profile call could differ: open. |
| Host-side `claude --resume` of a container-written session | **Verified (limited)** | Container wrote `<home>/.claude/projects/-<path-with-dashes>/<id>.jsonl`, owner 1000. Host `claude -p --resume <id>` with `CLAUDE_CONFIG_DIR=<home>/.claude` found it; wrong id: `No conversation found`; also found from a different cwd. Content was only an auth failure; interactive TUI untested. |
| Claude Code in the container needs no `git` for init | **Observed** | The base image has no git or curl; `claude -p` started and `pnpm check` ran without them. The Containerfile still adds git (agent `git commit`). |

Allowlist decision: unchanged, `api.anthropic.com:443` and `registry.npmjs.org:443` only, exact match; `platform.claude.com` is added only if the real-token check below shows it. Alternative 3 (socket) was not needed and not tried.

Consequences for the tickets:

- 13: `scripts/image-build.mjs` creates the network with `--internal --disable-dns --subnet 10.89.77.0/24 --gateway 10.89.77.1` (idempotent: check `podman network exists`; if it exists, inspect `Internal=true` and `DNSEnabled=false`, else refuse rather than recreate). Subnet is configurable; this host's choice is verified free. `--userns=keep-id` ran the process as uid 1000 here, which the node base image names `node`; the Containerfile should keep a named uid-1000 user.
- 14: no change to the proxy contract; it must resolve names itself (the sidecar has the host's resolvers). Name lookups in the sidecar return both A and AAAA records, but the sidecar had only link-local IPv6 addresses, so connect over IPv4 or fall back; check the address actually connected to. Denial log lines are on the sidecar's stdout, readable with `podman logs` under the default log driver.
- 15: tmpfs must say `noexec` explicitly; `--log-driver=none` is fine for the Build container; one fixed-IP sidecar means serial Builds, or per-Build IPs; kill path is `podman stop -t 5 <name>` (`rm -f` only as a fallback, `--rm` already removes); stop the sidecar by name too; `PATH` in the container must include `/usr/local/bin` when Node's `docker-entrypoint.sh` is the entrypoint; set explicit `HTTPS_PROXY`/`https_proxy` and `NO_PROXY=` in the env list.
- 12 left open for the Operator: the real-token check.

Open for the Operator, once the separate Build token exists (one command, from a throwaway dir; it costs a few cents; start a sidecar like the one above with `ALLOW=api.anthropic.com:443,registry.npmjs.org:443` and read `podman logs` afterwards):

```
CLAUDE_CODE_OAUTH_TOKEN=<token> podman run --rm --pull=never --init --userns=keep-id --cap-drop=all --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev --network argus-build-net -e CLAUDE_CODE_OAUTH_TOKEN -e HOME=/home/agent -e CLAUDE_CONFIG_DIR=/home/agent/.claude -e HTTPS_PROXY=http://10.89.77.2:3128 -e https_proxy=http://10.89.77.2:3128 -e NO_PROXY= -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 -e DISABLE_AUTOUPDATER=1 -v <home>:/home/agent:Z <image-with-claude> claude -p "say hi" ; podman logs <sidecar> | sort | uniq -c
```

Any `DENY CONNECT` line other than expected noise names a host the setup-token path needs.
