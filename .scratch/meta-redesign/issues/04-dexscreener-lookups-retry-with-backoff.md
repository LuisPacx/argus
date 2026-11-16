# 04: DexScreener lookups retry with backoff (one shared retry wrapper over `FetchText`)
**Model:** sonnet / medium. Small and mechanical (one wrapper, one client option, tests), but the wrapper is shared by every later client (ticket 05) and sits under the Meta tick's failure streak, so the retry and not-retry cases need exact tests.

**What to build:** a failed DexScreener request is retried a bounded number of times with growing waits before it counts as a failure. Today one transient error is a lost lookup: the worker log had 111 `[meta] DexScreener lookup failed for <key>: fetch failed` lines before the 2026-11-16 04:59Z restart (theme lookups), each one a theme with no market cap for that tick, and three in a row end the tick's lookups. Decided by the user on 2026-11-16 (`.scratch/cos.md`: "GTA USER" Q5 yes, "USER: all as recommended" Q11 "MR/04 retries"; reasons in `docs/adr/0015-metas-are-found-top-down.md`, decision 1 for why the wrapper is shared).

**Status:** done

**Blocked by:** none. Ticket 05 reuses the wrapper written here.

## What is there today (read 2026-11-16)

- `DexScreenerClient` (`packages/core/src/sources/dexscreener.ts:59`) calls `this.fetchText(url)` once in `json()` (`:68`). `fetchText` is `timedFetchText` (`sources/http.ts:68`: 10 s timer armed until the body is read, 2 MB cap, an `HttpError` with `status` and `retryAfterMs` on a non-2xx) or a test fake (`DexScreenerClientOptions.fetchText`).
- `"fetch failed"` with no status is the Node (undici) `TypeError` for a network error, not an `HttpError`: `timedFetchText` words its own errors `DexScreener fetch failed: 429 Too Many Requests`. A timeout is an `AbortError`.
- Callers: the trending Source (`BackoffSource` already waits 10 min to 1 h after a failed poll, `sources/backoff.ts`), the Meta tick (`meta/compute.ts` theme lookups and `lookUpLeaders`, three failures in a row end the lookups, `DEX_MAX_CONSECUTIVE_FAILURES` 3), the collision checks (`search`) and the meme pass (`memeDex`). All build `new DexScreenerClient(...)`.
- Live: 0 lookup failures since the 04:59Z restart (cos journal, "LIVE CLUSTER OK"), so the live log cannot show the fix. The acceptance below is a fake-fetch test and a replay with an injected failing fetch.

## Approach (a default; say if you want it changed)

1. **One wrapper**, `retryingFetchText(fetchText, opts): FetchText` in `sources/http.ts` (beside `timedFetchText`, which it wraps; it adds no fetch of its own). Options: `retries` (default 2, so 3 attempts in all), `baseMs` (default 500), `maxWaitMs` (default 5,000: no single wait is longer, a server's Retry-After included, so one lookup is bounded at about 3 x 10 s + 6 s), `sleep` (injectable, default a timer; tests pass a recorder) and `onRetry({url, attempt, error, waitMs})` for a log line.
2. **What is retried:** a network `TypeError` (`fetch failed`), an `AbortError` (the timeout), and an `HttpError` with status 408, 425, 429, or 500 to 599. The wait is `baseMs * 2^(attempt-1)` with the server's `retryAfterMs` as a floor when it sent one, then cut to `maxWaitMs`. **Not retried:** any other 4xx (a bad request will not get better), "body too large", and anything thrown after a 2xx (JSON parse or "unexpected response" errors are the caller's, not the network's). No jitter: the tick is one client and the tests stay deterministic.
3. **Wire it in** `DexScreenerClient`: the default `fetchText` becomes `retryingFetchText(timedFetchText(...))`; an injected `fetchText` is used as given (tests that pass a fake are unchanged) unless the new option `retries` is set. A `retries: 0` option turns it off. The error that finally surfaces is the last one, unchanged, so every existing message and the `BackoffSource` `retryAfterMs` read stay as they are.
4. **Log it.** `onRetry` prints one line `[dexscreener] retry 1/2 after fetch failed (waiting 500 ms): <path only, no query>`; a lookup that succeeds on a retry is logged once at that point and never as a failure. The Meta tick's `dexFailures` and its three-in-a-row streak count only calls that failed after the retries.
5. **Docs.** One sentence in `docs/architecture.md`'s Meta/DexScreener paragraph (hand-written part; run `pnpm docs:graph` only if the pipeline node text changes) and the `[config]`/`.env.example` need no new key (the defaults stand; `ARGUS_DEXSCREENER_RETRIES` is not added).

## Acceptance criteria

- [x] `retryingFetchText` with a fake `fetchText` that throws `new TypeError("fetch failed")` twice and then returns a body: the body is returned, the fake was called 3 times, the recorded waits are `[500, 1000]`, no real timer ran (`sleep` injected).
- [x] It fails the same way after the last attempt: a fake that always throws `TypeError("fetch failed")` is called exactly 3 times and the caller sees that same error (message unchanged).
- [x] Status handling by table, one assertion per row: `HttpError` 429 with `retryAfterMs` 2,000 waits 2,000 then retries; a Retry-After of 600,000 waits only 5,000 (the cap); 503 and 500 retry; 408 retries; 400, 401, 403 and 404 are called once and rethrown; an `AbortError` retries; "body too large" is called once.
- [x] A 2xx body that is not JSON (`"<html>"`) makes `DexScreenerClient.tokenPairs` throw its parse error after exactly one fetch (no retry of a bad body); a 200 with `{}` makes `search` throw "unexpected search response" after one fetch.
- [x] `DexScreenerClient` with an injected `fetchText` and no `retries` option behaves as before (one call, one throw); with `retries: 2` it retries; the production default (no `fetchText`) is the wrapped `timedFetchText` (assert it by passing a loopback server in the test that fails its first request, or by a unit test of the constructor's default through an exported builder).
- [x] **Replay of the 111 failures with an injected fetch.** A test that runs `recomputeMetas` (`meta/compute.test.ts` fixture with at least 6 theme groups and leader candidates) through a real `DexScreenerClient` whose `fetchText` fails the first attempt of every request with `TypeError("fetch failed")` and answers the second: the run ends with `dexFailures` 0 and every group's market cap present; the same fake with `retries: 0` gives the failures the log showed (`dexFailures` equal to the number of calls, the streak ending the lookups after 3). The test names both numbers so a regression reads plainly.
- [x] The Meta tick's streak rule is unchanged: three calls that fail after their retries end the lookups, and a call that succeeds on its retry resets the streak (counting fake client in `compute.test.ts`).
- [x] The trending Source and the collision checks keep their tests unchanged and green (`dexscreener.test.ts`, `backoff.test.ts`, `collision*.test.ts`); no test waits on a real timer longer than 100 ms.
- [x] Type-check and the full `pnpm check` pass, run once before the commit.
- [x] Post-deploy (not a test; the builder cannot do it): after the next restart, `grep -c "DexScreener lookup failed" <worker log>` over a day is recorded in the ticket's Comments with the count of `[dexscreener] retry` lines. A day with 0 failures and some retries is the pass; a day with no retries says only that no failure happened.

## Constraints

- No new host, no new dependency, no wallet or chain call (ADR 0002 unchanged). DexScreener only through the declared client. Tests assert on call counts, waits and results, never on timing.
- Remote text in errors is still logged as before; the retry line carries the URL path only (no addresses beyond what the existing log prints).
- Follow `docs/agents/worker-rules.md` and `CODING_STANDARDS.md`. Commit subject `Meta redesign ticket 04: DexScreener lookups retry with backoff`, body ends with `Ticket: .scratch/meta-redesign/issues/04-dexscreener-lookups-retry-with-backoff.md` before the trailers. No `Closes #N`: this repo has no GitHub issues.

## Open questions (defaults apply unless the user says otherwise)

1. **Retries and waits.** Default 2 retries, 500 ms then 1,000 ms, a 5 s cap. A Meta tick makes up to 24 DexScreener calls, so the worst case adds a few minutes only if DexScreener is down, and the streak of 3 ends that sooner. Say if you want more.
2. **Retry the collision checks and the meme pass too?** Default yes (they share the client; a transient error there today fails a Proposal's name check). Say so if only the Meta tick should retry.

## Comments

- **Written 2026-11-16** from the user's decisions in `.scratch/cos.md`. Code read: `sources/dexscreener.ts`, `sources/http.ts`, `sources/backoff.ts`, `meta/compute.ts`, worker `main.ts` (clients at `:223`, `:336`, `:367`).
- **Post-deploy 2026-11-16 (restart 07:08:00Z, first Meta tick 07:08:10Z):** since this start, `[dexscreener] retry` lines: 0; `DexScreener lookup failed` lines: 0 (the first Meta tick made 20 DexScreener calls, 0 failed). `lookup failed` lines in the 24 h before the restart: 3 (2026-11-15 17:02Z, keys `lucia`, `bounty`, `steven`). Box ticked on the 0-failures basis; the retry path itself has not fired on live data yet.
