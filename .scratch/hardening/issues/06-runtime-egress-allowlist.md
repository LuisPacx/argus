# 06: Run-time egress control for ADR 0002 (one egress module, a socket-level ban, a lint rule; the source scan stops growing)
**Model:** sonnet / high — security boundary; five ordered slices below, each with its own tag. The first slice is the minimum that gives real protection.

**What to build:** ADR 0002 ("never trade, sign or hold keys; talk only to known hosts") is enforced today only by a source-text scan, `packages/core/src/adr-0002.test.ts`. Four review rounds (ticket 18 on main; ticket 23 on branch `adr-residual`, tip ee51077) kept finding new spellings of a banned host that a regex cannot see: built at run time, decoded, read from a file or the network, a lookup table. Each round makes the test longer and the list of "Residual, not closed" items in ticket 23 is still open. A text scan can never be complete here. The Operator approved moving the real control to run time: the argus processes (the worker, the War Room server) should be unable to reach a host they are not allowed to, and the scan becomes a tripwire that stops growing.

**Status:** ready-for-agent

**Blocked by:** nothing. Coordinate with 19 (IPFS gateways, unmerged), 20 (Helius client) and 23 (`adr-residual`), see Interplay.

This ticket specifies that move. Its shape was checked against the code on 2026-11-11 (main at f44e0e1, plus branches `ipfs-gateway` d981089 and `adr-residual` ee51077). **Where the code changed the brief:** see "Shape changes" below.

## What exists today (checked)

There is no common outbound path. Network calls are scattered over twelve in-process sites, three mechanisms (global `fetch`, global `WebSocket`, node `http`/`https` in the Study's SSRF guard) and one hidden one (the Anthropic SDK, which calls global `fetch` inside `@anthropic-ai/sdk`, so a lint rule on the word `fetch` never sees it). Only the Study's creator-URL fetches have a guard (`study/guarded-fetch.ts` + `study/ssrf.ts`: http(s), default ports, no userinfo, public addresses only, every redirect hop re-checked, connection pinned to the validated address). The RSS Sources, which fetch hosts named in `config/rss-feeds.json`, use plain `fetch` through `timedFetchText` (`sources/http.ts:73`): redirects are followed to any host, private and banned ones included.

### Egress inventory (in-process; all are in the worker unless noted; the War Room server has none today)

Class (a): fixed-host API clients. Host is a literal in the client; a static allowlist fits.

| # | Site | Host(s) | Env override (test mirror) | Mechanism | Guard today |
|---|------|---------|----------------------------|-----------|-------------|
| 1 | `sources/pumpportal.ts:117` (stream) | `wss://pumpportal.fun/api/data` | `ARGUS_PUMPPORTAL_URL` | global `WebSocket` | none (the scan allows exactly this path) |
| 2 | `sources/dexscreener.ts` via `timedFetchText`; ingest Source and collision checks | `api.dexscreener.com` | `ARGUS_DEXSCREENER_URL`, `ARGUS_DEXSCREENER_SEARCH_URL` | global `fetch` | none; redirects followed |
| 3 | `sources/github-trending.ts` and `collision.ts:109` via `timedFetchText` | `api.github.com` | `ARGUS_GITHUB_URL`, `ARGUS_GITHUB_SEARCH_URL` | global `fetch` | none; redirects followed |
| 4 | `sources/google-trends.ts` via `timedFetchText` | `trends.google.com` | `ARGUS_TRENDS_URL` | global `fetch` | none; redirects followed |
| 5 | `telegram.ts:105,162` | `api.telegram.org` (bot token in the path) | `ARGUS_TELEGRAM_URL` | global `fetch` (injectable) | none |
| 6 | `api-brain.ts:201` (`new Anthropic(...)`) | `api.anthropic.com` | `ARGUS_ANTHROPIC_URL` | SDK, global `fetch` inside | none; the SDK's own `ANTHROPIC_BASE_URL` is deliberately not read |
| 7 | `apps/worker/src/semantic-embedder.ts:77,85` `fetchModel`; also `scripts/fetch-models.mjs` | `huggingface.co`, and whatever hosts its `resolve/` URLs redirect to (a CDN) | `ARGUS_MODEL_HOST` | global `fetch` | sha-256 of every file; no host guard. `@huggingface/transformers` itself is set to `allowRemoteModels = false` (line 123) |
| 8 | `build-runner.ts:603` (Cloudflare Worker-name check) | `api.cloudflare.com` (carries the Operator's API token) | none | `o.fetch ?? fetch` | none |
| 9 | `build-runner.ts:840` -> `disclosure.ts:156` (preview check) | `https://<name>.workers.dev`, taken from `wrangler` output by `WORKERS_DEV_URL_RE` | none | `o.fetch ?? fetch`, `redirect: "manual"` | the regex only |

Class (b): open-web fetchers. The host comes from data; no static allowlist can exist.

| # | Site | Where the host comes from | Mechanism | Guard today |
|---|------|---------------------------|-----------|-------------|
| 10 | `sources/rss.ts` via `timedFetchText`; `sources/feeds.ts` | `config/rss-feeds.json` (13 feeds today; Operator-edited, re-read every ingest pass) and wherever they redirect | global `fetch` | **none**: redirects to private or banned hosts are followed |
| 11 | `study/metadata.ts:82` `fetchMetadata` | the token's `uri`, written by the creator. Almost always an IPFS gateway URL. On branch `ipfs-gateway` (ticket 19, not merged) a public-gateway uri is rewritten to an ordered list of gateways (`DEFAULT_IPFS_GATEWAYS`, overridable by `ARGUS_STUDY_IPFS_GATEWAYS`); any other host is fetched as given | `guardedGet` (node `https`) | SSRF guard |
| 12 | `study/website.ts` (page and `robots.txt`) | the website link inside the metadata document | `guardedGet` | SSRF guard |

Not egress sites, but they import network modules and the lint rule must know them: `egress-proxy.ts` and `egress-proxy.mjs` (the Build's own CONNECT allowlist proxy, baked into the image and run in a sidecar container, not in an argus process), `study/ssrf.ts` (`isIP` only), `testing/**` and `*.test.ts` (loopback fake servers), `scripts/dev-server.mjs` and `scripts/verify-boot.mjs` (loopback probes of the dev servers), `packages/core/scripts/x-capture-spike.mjs` (imports `playwright-core`).

Not yet on main: the Helius client (`study/helius.ts`, ticket 18 allowance, ticket 20 builds it; host `mainnet.helius-rpc.com`, `https`, path `/`), and the X capture job (ADR 0009, Playwright in a dedicated Chrome profile).

## Shape changes against the brief (and why)

1. **"Check the final URL after redirects" becomes "check every hop before it is sent".** Checking only the final URL means the request to a banned host has already left. `guarded-fetch.ts` already does it per hop; the new module does the same for fixed-host clients (`redirect: "manual"`, loop, re-check).
2. **The IPFS gateways are class (b), not class (a).** The brief expects them in a static allowlist next to the client. They cannot be: the same fetch path serves the gateways and every other host a creator writes into a `uri`, and the gateway list is env-configurable (`ARGUS_STUDY_IPFS_GATEWAYS`). They get the open-web rule. The default gateway list stays plain data for documentation and tests only; an operator typo that puts a banned host there is refused at run time by the ban list.
3. **One module is not enough to make the process unable.** A module only controls code that calls it; a lint rule only stops spellings it can see (`globalThis[["fe","tch"].join("")]`, a library that opens its own socket, an SDK). The brief's goal, "the processes themselves unable to reach a host that is not allowed", is only met for the ban list by a socket-level check inside the process. So the ticket has two controls: **(i)** a ban-list tripwire on every Node socket connect, installed once per process (slice 1; spiked on 2026-11-11 in a scratch script on Node 22.23: patching `net.Socket.prototype.connect` sees undici `fetch` TLS connections by host name; plain-http connects arrive with normalised arguments and need unwrapping, which the slice must handle and test), and **(ii)** the egress module with per-client allowlists (slices 2 to 4), kept honest by a lint rule (slice 5). A strict allowlist can only be enforced where the hosts are known, which is class (a); for class (b) the run-time rule is "public addresses only + the ban list".
4. **The banned list becomes data, not regexes.** The repo forbids `new RegExp(nonLiteral)` (`argus/no-dynamic-regexp`), and a list shared between the test and run-time code has to be matchable without one. `BANNED_HOSTS` in `adr-0002.test.ts` is a list of regex literals; it moves to structured entries (`{ suffix: "solana.com" }` matched on a label boundary, and `{ loopbackPorts: [8899, 8900] }` for a local validator in any spelling of loopback). Same coverage; the match function is linear, no regex.
5. **Test mirrors.** Every client has an env override that tests point at loopback (`ARGUS_TELEGRAM_URL`, `ARGUS_DEXSCREENER_URL`, ...). The egress module accepts an override only if its host is on the client's allowlist, or it is loopback **and** `VITEST` is set (the precedent is `egress-proxy.ts` `testOverrides`, refused outside vitest). Anything else is a startup error, not silently ignored.
6. **DNS rebinding.** Out of scope for class (a): rebinding needs control of an allowed host's DNS. It is already handled for class (b) because `guarded-fetch.ts` connects to the validated address. The socket tripwire sees the name before DNS, so it cannot see an IP address or CNAME that points at a banned provider; listed under out of scope.

## Slices (do them in this order; each is its own commit and passes `pnpm check`)

Names: the new code lives under `packages/core/src/net/`. The word "egress" is already used for the Build's proxy (`egress-proxy.ts`, `ARGUS_EGRESS_*` env vars, `EGRESS_ALLOW` in `sandbox.ts`); use `net/egress.ts` for the module and `ARGUS_NET_*` for any new env var, and say "host egress" against "Build egress" in comments.

### Slice 1 (sonnet / high): the single banned-host list and the socket-level ban — **the minimum that gives real protection**

After this slice no code in a worker or War Room process can open a socket to a banned host or to a local validator port, however the host was spelled, decoded or read, with no call site changed.

- `packages/core/src/net/banned-hosts.ts` exports `BANNED_HOST_SUFFIXES` (the 19 `BANNED_HOSTS` entries of the test, expanded: `solana.com`, `solana.org`, `helius.com|xyz|dev`, `helius-rpc.com|xyz|dev`, `quiknode.pro`, `quicknode.com|pro`, `alchemy.com`, `ankr.com`, `rpcpool.com`, `chainstack.com`, `getblock.io|us`, `infura.io`, `triton.one`, `jup.ag`, `jito.wtf`, `raydium.io`, `pumpportal.fun`, `pump.fun`), `BANNED_LOOPBACK_PORTS` (8899, 8900) and `BAN_EXCEPTIONS`: the only things the ADRs allow inside the banned set, each naming its client: PumpPortal `wss://pumpportal.fun/api/data` (and `/api/data/...`) for client `pumpportal`, and the Amendment's `https://mainnet.helius-rpc.com/` (path `/`, default port) for client `helius`. `pump.fun/coin/` links are not an exception: nothing fetches them.
- `isBannedHost(host, port)`: lower-cases, strips all trailing dots, takes the URL parser's output (so `%2e`, the ideographic full stop and decimal/hex IPv4 are already normalised), matches suffixes on a label boundary (`evilsolana.com` and `solana.com.evil.example` do not match), treats any loopback spelling (`localhost`, `127.0.0.0/8`, `::1`, `::ffff:127.0.0.1`, `0.0.0.0`) with a banned port as banned. No regex built from data.
- `installSocketBan(log)`: patches `net.Socket.prototype.connect` once per process (idempotent), unwraps the argument forms (options object, `(port, host)`, normalised array, `path` for unix sockets, which pass), and for a banned target destroys the socket with an `EgressRefused` error and logs `[egress] refused <host>:<port> (banned)`; the log line has the host only, never a path or query. Called first thing in `apps/worker/src/main.ts` and from a Nitro server plugin in `apps/warroom/server/plugins/`. It has no off switch (an env kill switch would be a bypass); it needs none, because it blocks nothing an allowed client uses.
- The vitest setup installs it too, so the whole suite runs under it (a test that reaches a banned host fails by name).
- `adr-0002.test.ts` imports the list from `net/banned-hosts.ts` instead of owning `BANNED_HOSTS`; its own checks still use it. The file `net/banned-hosts.ts` necessarily spells the banned hosts: it is the one frozen exemption of the scan (named in the test, like `DYNAMIC_HOST_FILES`; on branch `adr-residual` also like `BARE_APEX_FILES`), and the test asserts that file contains the list and nothing else (no URL, no code beyond the exports).

Acceptance (slice 1):
- [ ] A test connects, with each of `fetch`, `new WebSocket`, `http.request`, `https.request`, `tls.connect`, `net.connect` and `net.Socket#connect`, to a banned host (`https://api.helius.xyz/`, `wss://pumpportal.fun/api/trade`, `https://quote-api.jup.ag/`, `http://localhost:8899/`) and gets `EgressRefused` **before any DNS lookup** (asserted with a `lookup` spy or a resolver that fails the test if called). No real network.
- [ ] Spellings the scan cannot see are refused at run time: host assembled from variables, read from a JSON file, base64-decoded, trailing dot, `%2e`, ideographic full stop, upper case, `[::ffff:127.0.0.1]:8899`, `0.0.0.0:8900` (tested through the connect path, not through `violations()`).
- [ ] Not refused (tested): a loopback server on an ordinary port (what every test fake uses), a unix-socket `path`, `api.telegram.org`, a host that merely ends in a banned suffix without the label boundary.
- [ ] The two allowances survive: `wss://pumpportal.fun/api/data` reaches a local stand-in for client `pumpportal` (via the exception data, with a test-only host mapping), and `https://pumpportal.fun/api/trade-local` and `https://mainnet.helius-rpc.com/` for any other client id are refused.
- [ ] `adr-0002.test.ts` passes with its list imported; an equivalence test runs the old regex list (copied into the test as a literal fixture) and the new matcher over every URL sample already in `adr-0002.test.ts` plus a generated corpus, and they agree.
- [ ] The tripwire is installed in the worker and in the War Room server (a boot test or a unit test of each entry point asserts `installSocketBan` ran), and the startup config line (`startup-config.ts`) says `egress-ban=on`.
- [ ] Full test suite and type-check pass once before the commit.

### Slice 2 (sonnet / high): the egress module (no call site moves yet)

`packages/core/src/net/egress.ts`, the only file besides the open-web transport that names the global `fetch` or `WebSocket`.

- **Fixed-host clients.** `declareClient({ id, hosts, schemes?, ports?, pathPrefix?, redirects? })` at the top of each client file, "declared next to the client". Entries are exact host names or `*.suffix`, string literals only. Declaring a banned host is a throw at import time unless `BAN_EXCEPTIONS` names that client for that host. `egressFetch(clientId, input, init)`: parses the URL, rejects userinfo, non-default ports not declared, IP literals, any scheme not declared; strips trailing dots and lower-cases; matches the allowlist exactly or by label-boundary suffix; applies the ban list first; sets `redirect: "manual"` and follows at most 5 redirects **only for GET without an `authorization` or `cookie` header**, re-running all checks on each hop before sending (a redirect for any other request is an error, so the Telegram bot token and the Cloudflare token never travel to a second host). `openSocket(clientId, url)`: same checks for `wss:`, then `new WebSocket(url)` (a WebSocket handshake does not follow redirects). `egressFetch` also accepts the `Request` objects the Anthropic SDK passes.
- **Open-web.** `openWebGet(url, opts)` wraps the existing `guardedGet` (move `study/guarded-fetch.ts` and `study/ssrf.ts` to `net/`, git mv, imports and test names updated) and adds the ban list to its per-hop `beforeRequest`/URL check. It keeps its seams (`resolve`, `transport`) for tests. Class (b) rule: http(s), default ports, no userinfo, no internal name, every resolved address public, connection pinned to the validated address, not banned.
- **Test seam.** A loopback override of a client's base URL is accepted only when `process.env.VITEST` is set; otherwise only a host on the client's allowlist is accepted; a rejected override throws at construction with the client id and host.
- **Errors and logs.** `EgressRefused` carries the client id, the host and the reason, never the path or query (the Telegram token is in the path).
- **Registry.** `declaredClients()` returns the declarations, for the tests and for `startup-config.ts`'s one-line summary (client ids and host counts, `loopback=test-only`).

Acceptance (slice 2):
- [ ] For a declared client, a request to a host not on its list is refused with a connection counter on a local server staying at 0 (tested table-driven over `declaredClients()`, with a test-mode host mapping to a local server).
- [ ] A redirect from an allowed host to a non-allowed host is refused before the second request is sent (the counter of the second server stays 0); a redirect between two allowed hosts is followed; the 6th hop fails; a redirect on a POST, or on a GET carrying `authorization`, is an error.
- [ ] Spelling checks on the final URL and every hop: trailing dot, several trailing dots, `%2e`, ideographic full stop, upper case, userinfo (`https://allowed@banned/` and `https://banned@allowed/`), undeclared port, IPv4 and IPv6 literals, decimal and hex IPv4 forms, `http` where only `https` is declared, label-boundary suffix (`evilallowed.com`, `allowed.com.evil.example`) — each refused.
- [ ] Declaring a banned host without a `BAN_EXCEPTIONS` entry throws; every shipped declaration is checked against the ban list in a test; the ban exceptions and the allowed-use samples in `adr-0002.test.ts` (PumpPortal data stream, the pinned Helius URL) are asserted equal to the exception data, so the two cannot drift.
- [ ] `openWebGet` refuses banned hosts on the first request and on a redirect hop, in all of the spellings above, plus the existing SSRF cases (its current tests move with the files and stay green unchanged); the connection is still pinned to the validated address.
- [ ] A loopback base URL is accepted under `VITEST` and refused (startup error naming the client and host) when `VITEST` is unset; a non-loopback, non-allowlisted override is refused in both.
- [ ] No error message or log line from the module contains a query string or the path of a Telegram request (tested with a token-bearing URL).
- [ ] Full test suite and type-check pass once before the commit.

### Slice 3 (sonnet / medium): move the class (a) clients (inventory 1 to 9)

Each client declares itself and calls the module; the injectable seams used by tests (`fetchText`, `fetch`, `createSocket`, `client`) stay, so existing tests keep passing unchanged.

- `timedFetchText` takes a required `client` id and calls `egressFetch` (its callers: DexScreener, GitHub trending, collision checks, Google Trends). The RSS caller moves in slice 4.
- `PumpPortalSource` default `createSocket` = `openSocket("pumpportal", url)`; `TelegramNotifier` default `doFetch` = `egressFetch("telegram", ...)`; `ApiBrain.#getClient` passes `fetch: (i, init) => egressFetch("anthropic", i, init)` to the SDK (its constructor accepts `fetch`, checked in `@anthropic-ai/sdk@1.3.0` `client.d.ts`); `fetchModel` default `fetchFn` = client `huggingface`; Build Runner defaults `o.fetch ?? egressFetch("cloudflare")` and `egressFetch("workers-dev")` with host `*.workers.dev`.
- **HuggingFace redirects must be recorded, not guessed.** The implementer records the real redirect chain of one model file once (a `HEAD`/`GET` with manual redirects, hosts only, in a fixture) and declares exactly those hosts; any other redirect makes `fetchModel` fail loudly with `ModelUnavailableError`, as a checksum failure does today.
- `startup-config.ts` prints the declared clients.

Acceptance (slice 3):
- [ ] All nine sites use `egressFetch` or `openSocket` by default (a table-driven test per client: a base URL on a non-allowlisted host, and on a banned host, is refused at construction or first call, with no connection made).
- [ ] Every existing test of these clients passes unchanged; the env mirrors (`ARGUS_TELEGRAM_URL` and the rest) still work under vitest.
- [ ] The Anthropic SDK path is covered: `ApiBrain` with a base URL on a banned host fails with `EgressRefused` (injected nothing, local counter 0), and one allowed call reaches the existing `fake-anthropic` server.
- [ ] The HuggingFace declaration matches the recorded redirect chain, and a fake server that redirects a model file to an unlisted host makes `fetchModel` throw `ModelUnavailableError`.
- [ ] Full test suite and type-check pass once before the commit.

### Slice 4 (sonnet / high): move the class (b) open-web fetchers (inventory 10 to 12)

- Metadata and website (and `robots.txt`) call `openWebGet` instead of `guardedGet` directly (rename of the import; same behaviour plus the ban list). Gateway candidates from ticket 19 (once merged) go through the same call.
- **RSS moves onto `openWebGet`.** This is the one real behaviour change for an allowed host, and the reason this slice is `high`: the 13 feeds now see the Study's transport (default ports only, at most 3 redirects, `accept-encoding: identity`, a `user-agent` set per call, not the Study's string, public addresses only). `timedFetchText` for RSS keeps its timeout and byte cap (`FEED_FETCH_TIMEOUT_MS`, `FEED_MAX_BYTES`) and its `HttpError`/`Retry-After` behaviour. The implementer must check every feed in `config/rss-feeds.json` still polls (see the live check below) and report any that does not, instead of loosening the transport.
- A website or metadata uri on a banned host is now recorded as `blocked` in the Snapshot (today it is fetched); the implementer counts how many existing Snapshot rows that would have been (read-only query on the Study tables) and writes the number in Comments.

Acceptance (slice 4):
- [ ] A feed URL, a metadata `uri` and a website link each on a banned host, and each redirecting to one, are refused with the connection counter at 0 (tested with local servers and the `resolve`/`transport` seams; no real network).
- [ ] The old RSS gap is closed: a feed that redirects to a loopback or private address is refused (tested).
- [ ] RSS tests with recorded XML pass unchanged; a new test drives `RssSource` with its default fetch against a local fake server through the test seam and gets the same Signals as with `fetchText` injected.
- [ ] `HttpError` and `Retry-After`/`x-ratelimit-reset` behaviour of `timedFetchText` is unchanged (its existing tests pass unchanged, now for both transports).
- [ ] **Live check, one time, recorded in Comments** (the only step that touches the real network; never in the suite): with `ARGUS_DB` and `ARGUS_DATA_DIR` pointing at a throwaway directory on the home disk (never the live `.data/`), run the worker once (`--once`) before and after the slice and compare the `ingest tick: N source(s), M new signal(s), K failed` line and the per-source results; the failed count must not grow, and each of the 13 RSS feeds and the three standing Sources must still return Signals.
- [ ] Full test suite and type-check pass once before the commit.

### Slice 5 (sonnet / high): the lint rule that keeps new code on the module, and the docs

`argus/no-direct-network` in `config/oxlint/argus-plugin.js` (beside `no-dynamic-regexp`; switched on in `.oxlintrc.json`, off through `overrides` for tests, `testing/`, and a short named list of files, so the reviewer sees every exemption in one place). It reports, outside the exempt files:
- imports and `require`/`import()` of `node:http`, `node:https`, `node:http2`, `node:net`, `node:tls`, `node:dgram`, `node:dns` (and the unprefixed names), `undici`, `ws`, `node-fetch`, `cross-fetch`, `axios`, `got`, `superagent`, `@anthropic-ai/sdk` (allowed only in `api-brain.ts`), `playwright-core`/`playwright`/`puppeteer*` (allowed only in the X capture module and the spike script), and `@huggingface/transformers` (allowed only in `semantic-embedder.ts`, where remote loading is switched off);
- any import, `require` or `import()` whose specifier is not a literal, and `createRequire`, `process.binding`, `process.dlopen`;
- any reference to the unshadowed globals `fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource`, and any `globalThis`/`global`/`self`/`window` member named like them or accessed with a computed non-literal key; passing the global as a value (`fetchFn = fetch`, `o.fetch ?? fetch`) counts, a property named `fetch` (`opts.fetch`) does not;
- in `apps/warroom/server/**`: `$fetch`, `useFetch`, `ofetch` unless the first argument is a literal path starting with `/`;
- `child_process` calls whose command is the literal `curl`, `wget`, `nc`, `ncat`, `socat`, `ssh`, `scp` or `telnet`;
- a `declareClient` call whose host arguments are not string literals.

Exempt files (all named in `.oxlintrc.json`): `net/**`, `egress-proxy.ts`, `egress-proxy.mjs`, `scripts/dev-server.mjs`, `scripts/verify-boot.mjs`, `packages/core/scripts/x-capture-spike.mjs`, plus tests and `testing/**` as the existing rule does. Browser-side War Room code (`apps/warroom/app/**`) calls its own server with `$fetch("/api/...")`; that is the browser's traffic to the same origin and is allowed.

Docs, in this slice: one line in `docs/agents/worker-rules.md` ("outbound HTTP, WebSocket and socket calls go through `packages/core/src/net/egress.ts`; `pnpm lint` rejects the rest; a new fixed host is a `declareClient` entry, never a bypass"), a new rule in `CODING_STANDARDS.md` next to #16, and the header comment of `adr-0002.test.ts` (see "The test afterwards").

Acceptance (slice 5):
- [ ] Each reported construct has a failing-first test that runs `oxlint` with the repo config on a planted file under `tempDir` (`packages/core/src/testing/temp.ts`, removed afterwards) and expects a non-zero exit naming `argus/no-direct-network`; the table covers every bullet above, including `const f = fetch`, `globalThis["fe" + "tch"]`, `await import(name)` and `new WebSocket(...)`.
- [ ] The rule is clean on the whole tree: every site in the inventory has moved, and the exempt list holds no entry beyond those named above.
- [ ] A rule-level `oxlint-disable` is rejected by review unless it carries a one-line reason (as for `no-dynamic-regexp`); none is added in this ticket.
- [ ] `docs/agents/worker-rules.md` and `CODING_STANDARDS.md` carry the new line; the glossary and ADR items below are written or explicitly deferred by the Operator.
- [ ] Full `pnpm check` passes once before the commit (lint included).

## The test afterwards (`packages/core/src/adr-0002.test.ts`)

No deletion in this ticket except the host list moving out. After slice 1 it imports the list; after slice 5 its header says it is a tripwire for spelled-out hosts and that the run-time control is `net/`.
- **Stays, because run time cannot see it:** the package scan (`BANNED_PACKAGES`, `package.json` dependencies: a wallet SDK can be installed without ever opening a socket), key handling (`Keypair`, `secretKey`, `PRIVATE_KEY`, `mnemonic`), the signing-primitive scan, the JSON-RPC method scan and the read-only-module rules (`READ_ONLY_RPC_*`, "no generic `rpc(method)`"). The egress module is host-level: `mainnet.helius-rpc.com` is allowed, so `sendTransaction` to it would pass the host check. Method-level protection stays in the test and in the per-method wrappers of ticket 18/20.
- **Stays as a cheap early tripwire, frozen:** the URL-endpoint scan (rule 2) over spelled-out URLs.
- **Becomes redundant for hosts, kept but frozen (no new evasion cases, no new exemption entries):** `DYNAMIC_HOST` / `DYNAMIC_HOST_FILES`, and, if ticket 23 has merged, the bare-hostname scan, its normalisers and `BARE_APEX_FILES`. Everything ticket 23 lists as "Residual, not closed" about hosts (read from a file or the network, base64, a lookup table, a host assembled from variables, non-canonical local-validator spellings) is covered at run time by slice 1, except an IP address or CNAME of a banned host.
- **Ticket 23 (`adr-residual`):** see Open question 5.

## Out of scope (and why)

- **`claude -p` subprocesses** (the Brain: judge, propose, spec; `brain.ts`), **the `git`, `gh`, `wrangler` and `podman` children** of the Build Runner (`build-runner.ts:132`, `github-repo.ts`, `sandbox.ts`, `build-image.ts`, `scripts/deploy-site.mjs`): separate processes with their own network stacks; no in-process check can see them, and they carry their own credentials. They stay under CODING_STANDARDS #13 (argus-owned cwd, scrubbed env) and the Build container rules. Listed here so nobody assumes the module covers them.
- **The contained Build** (agent and its code in the rootless container, ADR 0005): it has its own CONNECT allowlist proxy (`EGRESS_ALLOW` in `sandbox.ts`, `egress-proxy.ts`). Not an argus process; unchanged.
- **The Chrome profile for X capture** (ADR 0009): Chrome's own traffic is invisible to the module. Not built yet (only `x-capture-spike.mjs` and `x-capture/detect.mjs` exist). Lint keeps `playwright-core` out of every other file; restricting the browser to X hosts (Playwright request routing) belongs in the X capture ticket.
- **Build and dev tooling** (`pnpm install`, the Nuxt build, `nuxi`, vitest): not run by the worker or the War Room server at run time.
- **DNS-level evasion:** an IP address or CNAME of a banned provider (needs a provider IP list that does not exist), DNS exfiltration, UDP, and native addons (`onnxruntime` does no networking; `@huggingface/transformers` is switched off from remote loading).
- Changing ADR 0002 or its Amendment, widening the allowed hosts or RPC methods, and ticket 20's wrappers. This ticket only enforces them.

## Needs an ADR and a GLOSSARY entry (not written here)

- **ADR 0010** "Argus's own processes reach the network only through one egress module": records that the control is run time (socket ban + per-client allowlist + open-web rule), that the scan is a frozen tripwire, and that it enforces ADR 0002 without changing it. Cross-reference ADR 0002 and its Amendment, ADR 0005 (Build egress) and ADR 0008 (a fixed-host client: `api.github.com`).
- **GLOSSARY: Egress guard**, with `_Avoid_` "proxy" for it (the Build container's allowlist proxy is a different thing, already described under Build container). One sentence: the one module through which argus's own processes make outbound calls, with a host allowlist per fixed-host client and a ban on trading and chain hosts.

## Interplay

- **19 (IPFS gateways, branch `ipfs-gateway`, not merged):** touches `study/metadata.ts` and `capture.ts`, which slice 4 edits. Whichever lands second rebases; 19 needs no change of behaviour, only its call into `openWebGet`.
- **18 / 20 (Helius, chain-sourced creates):** `study/helius.ts` is not on main. When it lands it declares client `helius` (`mainnet.helius-rpc.com`, `https`, path `/`, per the `BAN_EXCEPTIONS` entry), and its declaration may carry a body check that the JSON-RPC `method` is one of `READ_ONLY_RPC_METHODS` (the same constant the test uses), so the Amendment is enforced at run time as well. Add one line to ticket 20 pointing here.
- **23 (`adr-residual`):** see Open question 5.
- **X capture ticket (Phase 3):** adds its own Chrome restriction; lint already keeps Playwright confined.

## Open questions for the Operator

1. **Is a socket-level ban (slice 1) acceptable?** It patches `net.Socket.prototype.connect` in the worker and War Room processes; it is the only control that does not depend on every call site being moved and on lint seeing every spelling. Risk: a Node internals change breaks argument unwrapping (tests catch it at upgrade). **Default: yes**, it is the minimum, fails loudly, and has no off switch.
2. **RSS through the Study's SSRF-guarded transport (slice 4)?** Stricter than today (default ports, 3 redirects, identity encoding). A feed that breaks is fixed in `config/rss-feeds.json`, not by loosening the transport. Alternative: keep plain `fetch` for RSS and allowlist the catalog's hosts, which breaks every time a feed redirects to a new host. **Default: guarded transport**, decided by the live check.
3. **Operator-run local mirrors** (`ARGUS_MODEL_HOST`, `ARGUS_TRENDS_URL`, ...): under this design an override outside the client's allowlist is accepted only under vitest. **Default: no production mirrors; a new host is a reviewed `declareClient` change.**
4. **Websites and metadata on banned hosts** (a token site on `jup.ag`, `raydium.io` or a `pump.fun` page) are no longer fetched and are recorded as `blocked`. **Default: accept**; the count of affected past Snapshots goes in Comments.
5. **Ticket 23 (`adr-residual`, three review rounds, a fourth pending):** slice 1 supersedes its remaining host-spelling work. **Default: no fourth review round and no new evasion cases; merge it as is only if the Operator wants its bare-hostname scan, with its exemption lists frozen; otherwise drop the unmerged branch.** Its header "Residual, not closed" list then points at ADR 0010.
6. **`*.workers.dev` for the preview check** is a suffix allowance (any account's Worker), as wide as `WORKERS_DEV_URL_RE` is today. **Default: keep it as wide as today**; narrowing needs the Operator's Cloudflare account subdomain.
7. **HuggingFace redirect hosts** are whatever the recorded chain shows (CDN hosts are not fixed by the vendor). **Default: declare exactly the recorded hosts and fail loudly on any other**; re-record if the download breaks.
8. **Browser traffic for X capture** (Chrome restricted to X hosts by Playwright request routing). **Default: yes, as a requirement of the X capture ticket**, not of this one.

## Commits

One commit per slice, in order, each after a full `pnpm check`. Subject `Hardening ticket 06: <slice and what changed>` (for example `Hardening ticket 06: slice 1, one banned-host list and a socket-level ban`), body ending with `Ticket: .scratch/hardening/issues/06-runtime-egress-allowlist.md` before the trailers. Tick the boxes of a slice in the commit that completes it only if the full check does not stamp the tree afterwards (as in ticket 05), otherwise in a follow-up docs commit. No `Closes #N`: this repo has no GitHub issues.

## Comments
