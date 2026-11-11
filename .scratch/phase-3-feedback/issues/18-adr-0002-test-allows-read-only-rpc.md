# 18: adr-0002.test.ts allows the read-only RPC the ADR 0002 Amendment permits
**Model:** sonnet / high — security-sensitive containment test; must be no looser than the ADR.

**What to build:** `packages/core/src/adr-0002.test.ts` banned every RPC host and read method in all source, which contradicts the ADR 0002 Amendment (Phase 3 spec, 2026-11-07: argus reads chain read-only through public RPC; no wallet, no keys, no transaction) and blocked ticket 03 (chain labeller), and with it 04, 07, 08 and 09. The Operator approved changing the test on 2026-11-11 (not the ADR).
Source: `.scratch/phase-3-feedback/research/proposal-quality-2026-11-11.md` finding 4. First consumer: `03-chain-labeller.md`.

**Status:** done

**Decision (the ADR names no module; narrowest rule proposed):** the Amendment says "public RPC" and the spec says Helius (section 7), but neither says where the code may live. The test now allows read-only RPC in exactly one file, `packages/core/src/study/helius.ts` (the one Helius client; tickets 03, 04 and 10 call chain through it). In that file only:
- the host `mainnet.helius-rpc.com`, `https:`, path `/`, no port, no userinfo;
- the read methods `getMultipleAccounts`, `getTransactionsForAddress`, `getAccountInfo`, `getSignaturesForAddress`, `getTransaction`.

Still banned everywhere, that file included: chain SDKs and `@helius*` / `helius-sdk` imports, key handling (`Keypair`, `secretKey`, `privateKey`, `PRIVATE_KEY`, `mnemonic`), every write or signing method (`sendTransaction`, `sendRawTransaction`, `signTransaction`, `signAllTransactions`, `simulateTransaction`, `requestAirdrop`, plus `sendBundle`, `sendSmartTransaction`, `sendJitoBundle`), `getBalance`, `getTokenAccountsByOwner`, `getLatestBlockhash`, `getProgramAccounts`, every other RPC provider, `sender.helius-rpc.com` and every other Helius host, `wss://`, Jupiter, Jito, Raydium, pumpportal `/api/trade*`. Outside the module the Helius host and the read methods (now including `getMultipleAccounts`, `getTransactionsForAddress`, `getProgramAccounts`) are banned as before.

Widening the allowance (another method, another file such as a separate own-launch reader) is a one-line change to the constants in the test and needs the Operator's say-so.

- [x] Read-only Helius host and the five read methods pass inside `packages/core/src/study/helius.ts` and nowhere else
- [x] Tests prove the ban fires for: the same host or methods in any other file (including look-alike paths), `sender.helius-rpc.com`, other Helius hosts, `http:`/`wss:`/port/userinfo/path variants, write and signing methods inside the allowed file, key handling and SDK imports inside the allowed file, other RPC providers inside the allowed file
- [x] The ADR is unchanged; wording gaps are reported to the Operator (below)

**Hardening after security review (second commit):**
- Hostnames are compared with trailing dots stripped (`host.com.`, `%2e`, ideographic full stop all normalise to a trailing dot in `new URL`), for every ban and for the pumpportal/pump.fun exceptions. The pinned Helius host must still be spelled exactly (no dot).
- A URL whose host is built at run time (`https://${h}/`, `"https://" + h`, `["https://", h].join("")`) is a violation in every file except a frozen list of ten files that already do it (`DYNAMIC_HOST_FILES`: loopback test servers, fake hosts, a link normaliser; a new entry is a visible change to the test). In the module even a partial host (`https://api.${d}/`, `helius-rpc.com${path}`) is a violation.
- `jsonrpc` outside the module, and any RPC endpoint or Helius setting read from env or config (`RPC_URL`, `rpcHost`, `HELIUS_RPC_URL`, any `HELIUS_*` except `HELIUS_API_KEY`), are violations everywhere. The host is pinned in the module, never configured.
- In the module the word `method` may only appear as `method: "<one of the five reads>"` (or `method: "POST"`); so no generic `rpc(method: string)` can be written, only typed per-method wrappers. Write "RPC verb" in comments there. The module also may not use eval or `Function(...)`, `fromCharCode`, `atob`, `Reflect`, `Proxy`, adjacent string-literal concatenation, computed literal keys or dynamic `import()`.
- Signing primitives (`createPrivateKey`, `createSign`, `generateKeyPair*`, `crypto.sign(`, `subtle.sign/importKey/generateKey`, `webcrypto`, an `"ed25519"` literal) are banned everywhere; none exist in the repo.

**This scan is a tripwire, not a proof.** It reads text. It cannot see a method or host assembled in ways it does not list (a base64 blob, a lookup table, a value read from a file or the network), calls through a dependency, or what a typed wrapper does inside. The real guarantees are that no chain SDK, key or signing primitive is present, and code review of `study/helius.ts`; any change to that module gets a security review.

## Comments
ADR wording gaps for the Operator: (1) the Amendment says "public RPC" and never names Helius or a module; Helius comes from spec section 7 and `docs/architecture.md` invariant 5. (2) "no transaction" is read here as no transaction sending or signing; reading transactions (`getTransaction`, `getTransactionsForAddress`) is allowed since the spec's labeller and bot filter need them. (3) The Amendment covers own-launch outcomes, but the Study reads other tokens' chain data too; the ADR sentence "the Phase 3 Study reads the same chain data for other tokens anyway" is taken as covering that.
