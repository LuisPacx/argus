# 02: Sources and notifications hardening
**Model:** sonnet / medium — small fixes across Sources, collision checks, expiry and Telegram.

**What to build:** Fix these LOWs found in review of Phase 2. Failing test first for each code change.

1. **04: `x-ratelimit-reset`.** `sources/http.ts` honours Retry-After only; GitHub's primary rate limit answers 403 with `x-ratelimit-remaining: 0` and `x-ratelimit-reset` (epoch seconds). Treat that as a rate limit with `retryAfterMs` derived from the reset (same `MAX_RETRY_AFTER_MS` clamp). Add one line to ADR 0008 saying so.
2. **09: GitHub collision page.** `collision.ts` searches `per_page=30` (`GITHUB_PER_PAGE`). Use `per_page=100` and add `fork:true` to the query so forks of the name count; fewer results end `unknown`. Update the architecture doc paragraph on collision checks (it says "first page of 30"; also say a DexScreener `clear` means no match in the pairs returned, not on the whole chain).
3. **01: Atom parsing.** `sources/rss.ts`: an Atom feed with a literal `<item` inside CDATA is parsed as RSS (line ~76); decide Atom vs RSS by the root element (`<feed` vs `<rss`/`<rdf`), not by a substring search. Trim the Atom `<id>` (line ~97). If cheap (under ~20 lines): feeds with no `guid` and a changing link dedupe on title plus source instead of link; otherwise note it in Notes and skip.
4. **02: doc nit.** `ARGUS_INGEST_STANDING`: only the exact string `0` disables the standing Sources. Say so in `.env.example` and the log line in `apps/worker/src/main.ts`; do not change the behaviour.
5. **10: expiry from status_history.** Proposal expiry reads `proposals.updated_at`, which any later write moves (the Spec save already does). Derive the expiry base from the `status_history.at` of the latest transition into the current status (`expiry.ts`, `expiresAtFor` and its caller in `datastore.ts`). Test that a Spec edit does not extend the life of a Proposal.
6. **11: Telegram tripwire.** The tripwire test passes `ARGUS_TELEGRAM_URL` explicitly, so it proves nothing about `.env`. Make it prove that a spawned worker with `ARGUS_NO_DOTENV=1` and a `.env` holding a bot token never sends: add a one-line `[worker] .env skipped (ARGUS_NO_DOTENV)` startup log in `main.ts` and assert it in a spawn-level test, with no explicit URL override in that test.

**Files:** `packages/core/src/sources/http.ts`, `packages/core/src/sources/rss.ts`, `packages/core/src/collision.ts`, `packages/core/src/expiry.ts`, `packages/core/src/datastore.ts` (`expiresAtFor` and the proposal row mapping only), `apps/worker/src/main.ts` (startup logs only), `apps/worker/src/telegram.test.ts`, `.env.example`, `docs/adr/0008-github-trending-uses-the-public-search-api.md`, `docs/architecture.md`, and the matching tests.

**Blocked by:** none. Shares `apps/worker/src/main.ts` and `datastore.ts` with ticket 01 (different regions).

**Status:** done

**Notes:** no-guid dedup done (identity is guid, else title, else link). Item 5: a Spec save only happens in `spec-drafted`, which never expires, so the test simulates the later write with a raw `updated_at` update. Item 6: `main.ts` reads an optional `ARGUS_ENV_FILE` (default the repo-root `.env`) so the spawn test can point the worker at a temp `.env` holding a token instead of writing into the repo root.

- [x] A 403 with `x-ratelimit-remaining: 0` and `x-ratelimit-reset` backs off until the reset (clamped); ADR 0008 says so
- [x] Collision GitHub search uses `per_page=100` and `fork:true`; the architecture doc is corrected
- [x] Atom with `<item` in CDATA parses as Atom; Atom `<id>` is trimmed; no-guid dedup done or skipped with a note
- [x] The `ARGUS_INGEST_STANDING` exact-`0` rule is documented
- [x] Proposal expiry derives from `status_history.at`; a Spec edit does not extend it
- [x] A spawn-level test proves `.env` is skipped under `ARGUS_NO_DOTENV`, without an explicit Telegram URL, via the startup log
- [x] `pnpm check` passes
