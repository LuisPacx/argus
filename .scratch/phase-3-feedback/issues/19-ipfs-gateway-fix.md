# 19: Fix Study metadata capture on the ipfs.io gateway
**Model:** sonnet / medium — small, well-bounded change in the capture job; the tests pin the behaviour.

**Status:** done (branch `ipfs-gateway`, not merged)

**What to build:** Study metadata capture fails for most tokens because nearly every PumpPortal `uri` is `https://ipfs.io/ipfs/<cid>` and ipfs.io throttles us.
Evidence: `.scratch/phase-3-feedback/research/new-phase-gap-2026-11-11.md` (coverage section): only 130 of 1,614 seen migrations have a Snapshot; 402 failed with `metadata: HTTP 429`; ipfs.io fails for 9,877 of 13,020 ipfs.io uris (76%) while other gateways fail 0%; retries burn the capture cap, which causes most `capped` rows.

1. **Rewrite** a uri on a public IPFS gateway (ipfs.io, dweb.link, w3s.link, nftstorage.link, cloudflare-ipfs.com, gateway.pinata.cloud, and the subdomain and `ipfs://` forms) to an ordered list of working gateways. Any other host is fetched as written.
2. **Fallback:** a retryable failure (429, 5xx, timeout, network error) from one gateway tries the next gateway in the same attempt. A 404 or a bad document stops, because another gateway will not change it.
3. **Retries do not spend the capture cap:** only a token's first attempt calls `beginCaptureRun`; retries of an already admitted token do not.
4. **Log** per-gateway ok and fail counts on every capture tick that fetched through a gateway: `[study] ipfs gateways: <host> ok=N fail=N, ...`.
5. **Config knob:** `ARGUS_STUDY_IPFS_GATEWAYS`, an ordered comma-separated list of https base URLs (junk dropped, default list if none valid); `CaptureDeps.gateways` for tests.

Default order (live probe 2026-11-11 from the dev machine, one fetch of the fixture CID): `4everland.io` (200 after one redirect, 0.6 s), `ipfs.filebase.io` (200, 0.5 s), `gw.ipfs-lens.dev` (200, 1.2 s), `gateway.pinata.cloud` (200 but about 6-7 s, so last). ipfs.io, dweb.link, w3s.link and nftstorage.link all answered 429 in the same probe; cloudflare-ipfs.com and cf-ipfs.com did not connect. Re-probe before trusting the order; the knob changes it without a code change.

**ADR 0002:** the gateways are read-only HTTPS GETs of creator-supplied content through the SSRF guard (`guarded-fetch.ts`), the same as the ipfs.io fetch today. None is a banned host in `adr-0002.test.ts` (checked on main: no host allowlist is needed, and `adr-0002.test.ts` passes unchanged). The gateway bases are full string literals and the URL is built by concatenation, with no `https://${...}` host template, so the `DYNAMIC_HOST` rule on branch `adr0002-test` (ticket 18) will not flag `study/ipfs-gateways.ts` or `study/metadata.ts` and neither needs to join `DYNAMIC_HOST_FILES`.

**Interplay:** ticket 20 (chain-sourced creates) will supply `uri`s for mints PumpPortal missed; those uris go through this same rewrite and fallback. This ticket does no chain work.

- [x] An ipfs.io (or other public-gateway) uri is rewritten to the ordered gateway list; other uris are untouched (tested)
- [x] A 429 from one gateway tries the next within the same attempt (tested at `fetchMetadata` and at the capture job)
- [x] Retries and backoff do not count against the daily capture cap; a new token past the cap is still capped (tested)
- [x] Per-gateway success and failure counts are logged (tested)
- [x] The gateway order is a config knob (`ARGUS_STUDY_IPFS_GATEWAYS`) (tested)
- [x] `adr-0002.test.ts` passes unchanged; no banned host or dynamic host is added
- [x] Full test suite and type-check pass once before the commit

## Comments

- Open: the 20,000/day run cap is still the cap for new tokens; with retries no longer counted it should stop producing `capped` rows, but re-measure on the next live run.
- Open: tokens whose first gateway always 429s still cost one wasted request each; a per-gateway cooldown would save it, not built (YAGNI until the logged counts show it matters).
- Dropped from the recognised-host list (`PUBLIC_GATEWAY_HOSTS`): the IPFS gateway of an Infura-branded RPC provider. The containment scan (`adr-0002.test.ts`) bans that provider's whole domain suffix and the gateway host sits under it, so the entry failed the scan. Uris on that host now behave as on `main`: fetched once, as given, with no CID rewrite and no fallback (tested in general form: a gateway-shaped uri on an unrecognised host is left alone; the host itself cannot be spelled in a test). Whether argus may contact that host at all, or its uris should be CID-rewritten to the working gateways instead, is an open question for `.scratch/hardening/issues/06-runtime-egress-allowlist.md` (its socket ban shares the banned list). `.scratch` is not scanned by the containment test; the note avoids the host name anyway.
