# 23: adr-0002.test.ts residual bypasses (non-literal scheme, loopback userinfo)
**Model:** sonnet / high — security-sensitive containment test; it must get stricter without breaking the current tree, and the review comes before the verifier.

**What to build:** the round-3 reviewer of ticket 18 (2026-11-11) merged it and accepted two residual bypasses of `packages/core/src/adr-0002.test.ts` as a follow-up. They are not new weaknesses (the file calls itself a tripwire, not a proof), but both are cheap to close. The Operator approved this follow-up on 2026-11-11.

**Blocked by:** 18 ADR 0002 test allows read-only RPC, merging to `main` (branch `adr0002-test`, tip 21bb7ec). The file this edits is on that branch: `git show 21bb7ec:packages/core/src/adr-0002.test.ts`.

**Status:** ready-for-agent (once 18 has merged)

**Bypass (a), medium: non-literal scheme.** `URL_RE` and `DYNAMIC_HOST` both start from a literal `http(s)://` or `ws(s)://`. A URL whose scheme is not literal never matches them: `` `${scheme}://api.helius.xyz/` ``, a protocol-relative `"//api.helius.xyz/"`, or string assembly like `"ht" + "tps://..."` (the concatenation case where the host is a separate literal). Fix: add a scan for bare banned hostnames. For every file (the read-only module included), look for a banned host as a standalone token in the text, whatever precedes it, and apply the same allowances as for URLs (the pinned `mainnet.helius-rpc.com` in `helius.ts` only; `pumpportal.fun` data stream and `pump.fun/coin/` links as allowed today). Reuse `BANNED_HOSTS` and `stripTrailingDots`; do not keep a second host list. Decide and record in Comments how bare hostnames in comments, docs and fixtures are handled (the scan already reads text, so a hostname in a comment of a non-exempt file would be flagged; prefer a narrow, reviewed exemption list over weakening the scan, and keep the list frozen like `DYNAMIC_HOST_FILES`).

**Bypass (b), low: userinfo via the loopback exemption.** `DYNAMIC_HOST` exempts `(localhost|127.0.0.1):${`, meant for test servers on a port variable. `http://127.0.0.1:${p}@api.helius.xyz/` passes the exemption, and a real URL parser reads `127.0.0.1:<p>` as userinfo and `api.helius.xyz` as the host. Fix: after the interpolation's closing `}`, require `/`, `?`, `#`, a quote or backtick, or the end of the literal; anything else (`@`, `.`, a letter, another `${`) is not exempt. Check the same for `localhost:${p}` and for a template with more than one interpolation.

**Acceptance bar:** security change, so the order is failing test first, then the fix, then review, and only then the verifier on the merged result (cos lesson, 2026-11-11: run the reviewer first and the verifier after merge for security changes).

- [ ] Failing-first test for (a): planted source texts (tested through `violations(file, text)` with in-test strings, not planted files in the tree) for `` `${scheme}://api.helius.xyz/` ``, `"//api.helius.xyz/"` and a concatenated scheme with a literal banned host are each reported, and the tests fail on the unchanged `adr-0002.test.ts`
- [ ] Failing-first test for (b): `` `http://127.0.0.1:${p}@api.helius.xyz/` `` is reported, and the tests fail on the unchanged file; the legitimate forms `` `http://127.0.0.1:${port}/x` ``, `` `http://127.0.0.1:${port}` `` and `` `http://localhost:${port}?q=1` `` still pass
- [ ] The bare-hostname scan uses the existing `BANNED_HOSTS`; allowed uses stay allowed: the pinned Helius host only in `packages/core/src/study/helius.ts`, the PumpPortal `/api/data` stream, and `pump.fun/coin/` links
- [ ] No new false positives on the current tree: the whole-repo scan test passes with no new entries in any exemption list, or each new entry is named in Comments with the file and the reason, for the reviewer to see
- [ ] The header comment of the test and the ticket 18 Comments note that the scan is still a tripwire, and list what remains uncovered (a host read from a file or the network, a lookup table, base64)
- [ ] Review before verify: a reviewer (sonnet / high) reads the diff and tries to bypass both fixes (at least: trailing dot, uppercase, `%2e`, userinfo with a second interpolation, scheme-less host in a template, host split across two literals) before the verifier runs; its findings are fixed or recorded in Comments
- [ ] Full test suite and type-check pass once before the commit

Out of scope: widening the allowed RPC methods or hosts (needs the Operator); changing ADR 0002 or its Amendment; the stricter read-only-module rules, which stay as they are.
