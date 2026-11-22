# 14: page:check gets a built-in sample-data (seed) option
**Model:** sonnet / medium. A script option plus a fixture module over APIs that exist (`Datastore`, `testing/meta-current.ts`, `verify-boot`'s private server); no schema or ADR change, no new dependency.

**What to build:** `pnpm page:check --seed <path>...` starts a private War Room on a throwaway DB filled with sample rows, checks the page(s) at 390 and 1240 px exactly as today, then stops the server and deletes the DB. A worker can then check a page whose cards are empty on live data without hand-seeding a `.backup` copy. Approved by the user 2026-11-16 (`.scratch/cos.md`, "yes page:check seed ticket").

Status: done

**Blocked by:** none. (Builds on 11, 12, 13; reads proposal-routing/04 and meta-redesign/02, 03 code, all merged.)

## Why

- `proposal-routing/04`'s `pnpm page:check` box is still open: live has no `meme` Proposal rows, so no meme card of either source was checked (04 Comments, 2026-11-16; `cos.md` PR/04 LIVE entry says the builder's seeded run "is a claim only").
- meta-redesign/02 and /03 ticked their browser boxes on "a seeded private War Room (port 3217, a `.backup` copy of the DB, deleted afterwards)". Each worker hand-rolled that. The seed was never in the repo, so it cannot be re-run or reviewed.
- Pages that only fill from live events (Current Meta, Watching, the New Meta banner, meme cards, a Proposal page of each kind) are the pages most likely to be shipped unchecked.

## What is there today (read 2026-11-16)

- `scripts/page-check.mjs` checks a RUNNING server: `buildUrl(port, path)` is localhost-only, a Playwright route aborts every non-GET/HEAD and every non-localhost-on-port request, `decide()` gives the exit code, `OVERFLOW_FAILS` (`warroom-pages.mjs`) is empty. It starts no server and takes one path. Tests: `scripts/page-check.test.ts` (pure parts, fast tier) and `scripts/page-check-browser.test.ts` (real browser against a throwaway `http` server, slow tier, self-skips without the headless shell).
- The War Room reads its DB from `ARGUS_DB` (`apps/warroom/server/utils/db.ts:7`, default `../../.data/argus.db`). `scripts/verify-boot.mjs` step 4 already starts the real dev server on its own port with its own temp DB, seeds it through `Datastore`, walks `pageRoutes`, and kills the process group.
- `scripts/live-db-guard.mjs` (`isLiveDb`) refuses a path that is the live DB, its `-wal`/`-shm`, a symlink or hard link to it; `backtest-beta.mjs`, `rubric-v3-replay.mjs` and `replay-launchpad-clustering.mjs` use it.
- Fixture helpers: `packages/core/src/testing/meta-current.ts` (`aMeta`, `saveCurrentRun`, `FULL_COVERAGE`); `Datastore.createMemeProposals` (`datastore.ts:1012`) with snapshots v1, v2 and v3 (`meme/types.ts`; v3 is the news-sourced one, key `newsMemeKey(narrativeId)`); `createProposal`; the new-Meta events table via `meta.*`.
- `worker-rules.md`: the live processes are started only by `pnpm dev:*`. A private server on another port and its own DB is the verify-boot pattern, not the live one; this ticket stays on that side.

## Design (the ticket writer's choice, the user can overrule)

- **Where the code goes:** `scripts/page-seed.mjs` (the fixtures, pure data builders plus one `seedDatastore(store, now)`), `scripts/page-check-server.mjs` (start and stop the private server, shared with `verify-boot` only if that is a small move; otherwise leave `verify-boot` alone). `page-check.mjs` gains `--seed`. Keep the browser code where it is.
- **Flow with `--seed`:** (1) create a DB at `~/.cache/argus-scratch/page-seed-<pid>/argus.db` on the home disk (never `/tmp`, never the scratchpad); (2) refuse if the path `isLiveDb`; (3) open it with `new Datastore(path)` and write the fixtures through the Datastore API and the `testing/meta-current.ts` helpers, never raw SQL and never a copy of the live file; (4) spawn the War Room dev server with `ARGUS_DB` set to it on a free port (default `3217`, `--port` overrides; refuse 3100, the live port), as its own process group with `TMPDIR=/var/tmp`; (5) wait until it answers, run the existing check for each path; (6) in a `finally` and on SIGINT/SIGTERM, kill the group by PID and `rm -rf` the DB dir. The browser route guard stays the same: only that port, GET/HEAD only.
- **Sample data (all names plainly fake, `SEED` in the title or key, so a screenshot cannot be mistaken for live):**
  - a Meta Current run with 2 Metas (one holding, one cooling) and 2 Watching subjects, leaders with caps; the New Meta event that triggered the meme pass;
  - a Meta meme trio (snapshot v2) and a news meme trio (snapshot v3, with its news Narrative, Signals and the headline the card shows), each of the three Proposals in `new`;
  - one `narrative`-kind Proposal (Tech) with a Rubric Score and the gate score line (proposal-routing/03);
  - one hostile string (`<script>`-looking name, a very long unbroken ticker) in a card so overflow and escaping are exercised, not just happy text.
- **Pages the standard set covers:** `/`, `/?kind=meme`, `/meta`, `/meta#all-launch-themes`, `/proposals/<id>` for one Tech, one Meta meme and one news meme Proposal. The fixture returns the ids, so the caller does not guess them. `--seed` with explicit paths checks those paths only; `--seed --all` checks the standard set (one server start for all). `<id>` in an explicit path can be written `{tech}`, `{metaMeme}`, `{newsMeme}` and is replaced from the fixture.
- **Output:** the same screenshots and JSON per page and width; the summary adds a `seed:` line (DB dir, port, row counts per table written) so a cited run says it was seeded. A seeded run is never presentable as a live run: the JSON gets `"seeded": true`.

## Constraints

- **Live is never touched:** no `ARGUS_DB` of the live DB, no copy of it, no read of `.data/argus.db`; `isLiveDb` is checked on the DB path and the port is not 3100. The seed writes only to the throwaway DB.
- No `/tmp` writes; the DB dir, any server log and the profile are removed on every exit path (success, failure, signal). A test asserts the dir is gone.
- Kill by PID of the process group the script started, never by name pattern; no `pnpm dev:*` (that is the live pair).
- Everything the page-check does today stays as is without `--seed`: same arguments, same exit codes, same read-only route guard. `--seed` conflicts with `--port 3100` (exit 2).
- Fixtures go through the production write paths so a schema change breaks the seed loudly in its test, not silently in a screenshot. If a write path needs a clock, pass `now` in; no `Date.now()` in the fixture.
- Never `new RegExp(x)`; no `sed`/heredoc edits; one command per Bash call (`worker-rules.md`).

## Acceptance

- [x] `pnpm page:check --seed --all` starts a private War Room, seeds it, checks the standard set at 1240 and 390 px, exits 0 on a healthy tree, and leaves no process, port or DB dir behind (the recorded run in Comments shows the port free and the dir gone afterwards).
- [x] `pnpm page:check --seed /proposals/{newsMeme}` and `{metaMeme}` and `{tech}` each render that Proposal kind's card/page; the screenshots show a meme card of both sources, the Current Meta and Watching cards, the New Meta banner and the Tech card with its gate score (cited from the run, paths in Comments).
- [x] The hostile fixture string is escaped (no script runs: no console or page error) and causes no horizontal overflow at 390 px on the card.
- [x] (proved by ticket 17: `startSeededServer` refusals leave nothing behind) Refusals tested: a seed DB path that `isLiveDb` says is live, `--port 3100`, `--seed` with a path outside the fixture's routes (`//`, absolute URL still refused by `buildUrl`), unknown `{token}`; each exits 2 and writes nothing.
- [x] Fast-tier tests in `scripts/page-check.test.ts` / a new `scripts/page-seed.test.ts`: the fixture builder against an in-memory or temp `Datastore` (rows of each kind exist, snapshot versions 2 and 3, ids returned, deterministic for a fixed `now`), token expansion, argument parsing. A slow-tier test in `page-check-browser.test.ts` (added to `SLOW_TESTS`, self-skips without the headless shell) runs `--seed` on one page and asserts the exit, the `seeded: true` JSON and that the temp dir and the child process group are gone. Temp dirs go through `packages/core/src/testing/temp.ts`.
- [x] `docs/agents/worker-rules.md`: the "Browser boxes" line gains one sentence: for a page whose cards are empty on live data use `pnpm page:check --seed ...` and say in the box that the run was seeded; never hand-seed a `.backup` copy of the live DB.
- [x] Re-run `proposal-routing/04`'s open page:check box with `--seed`, tick it there with the evidence, and add the evidence line to that ticket's Comments.
- [x] Type-check, `pnpm lint` and the full `pnpm check` pass once before the commit.

## Commits

One commit after the full `pnpm check`. Subject `War Room ticket 14: page:check seed option`; body ends with `Ticket: .scratch/warroom-redesign/issues/14-page-check-seed-option.md` before the trailers. No `Closes #N`. No GLOSSARY.md or ADR change.

## Open questions (recommended answers; the user can overrule)

1. **Spawn the server inside `page-check`, or require a separate seeded server the caller starts?** Recommended: spawn it inside, as `verify-boot` does. One command, no leftover server, and the cleanup is the script's own `finally`.
2. **One path per run or several?** Recommended: `--seed` accepts several paths and `--all`, one server start (the Nuxt dev boot is the slow part); without `--seed` the one-path rule stays.
3. **Default seed port.** Recommended: 3217 (the one earlier workers used), refuse 3100; if busy, exit 2 with a message, not a silent other port.
4. **Share the server-start helper with `verify-boot`?** Recommended: only if the move is under about 40 lines and `verify-boot`'s tests stay green; otherwise duplicate the small spawn code now and note a follow-up. Do not change `verify-boot`'s behavior in this ticket.
5. **Should seeded runs count against a test slot?** Recommended: no, same as a plain page check (decided for ticket 11); the dev server is one process.

## Comments

- **Written 2026-11-16** from the user's approval ("yes page:check seed ticket", `cos.md` 11-16 USER) after proposal-routing/04's page:check box stayed open on live data.
- **2026-11-16 (decisions):** the user accepted every recommended answer to the five open questions; they are decisions: spawn the server inside `page-check`; several paths and `--all` on one server start; default port 3217, refuse 3100, busy port exits 2; `verify-boot` left alone (the spawn code is duplicated in `scripts/page-check-server.mjs`, follow-up: share it); seeded runs take no test slot.
- **2026-11-16 (implemented):** `scripts/page-seed.mjs` (fixtures, `{tech}` `{metaMeme}` `{newsMeme}` `{hostile}` tokens, standard set), `scripts/page-check-server.mjs` (private server and cleanup), `--seed`/`--all` in `scripts/page-check.mjs`; tests in `scripts/page-seed.test.ts` (fast) and `scripts/page-check-browser.test.ts` (slow). Run `pnpm page:check --seed --all`: 8 pages at 1240 and 390 px, exit 0, 0 console/page/failed-request errors; final line `seed cleanup: port 3217 free, dir removed`; JSON has `"seeded": true`. The run found a real bug: the hostile ticker overflowed the home list and the meme Proposal page at 390 px; fixed in `index.vue`, `proposals/[id].vue` and `MemeCard.vue` (long unbroken text). In a seeded run horizontal overflow fails (exit 1) except on `/pipeline`. Known risk: relative times ("40 minutes ago") are computed from the real clock, so one run in about 20 showed a one-off "Hydration completed but contains mismatches" console error on a page whose text crossed a minute boundary between server render and hydration; a rerun passed. Acceptance boxes are left for cos; the 04 evidence is in proposal-routing/04 Comments (its box also left for cos).
- 2026-11-16: review: no test that refusals write nothing; signal-path cleanup reviewed by reading only; page-seed-<pid> dir may be reused after SIGKILL (rmSync first). Follow-ups.
