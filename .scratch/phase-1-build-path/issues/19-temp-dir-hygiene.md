# 19: Temp-dir hygiene in tests

**Model:** sonnet / medium — many small test edits plus a guard.

Status: in-progress
**What to build:** argus test runs leaked ~9,400 `/tmp/argus-*` entries (~570 MB) on a RAM-backed, quota-limited `/tmp` between 11-04 and 11-05, and were still leaking ~2,000 per hour (`.scratch/cos.md`, entries "FOUND: ~10k leaked", "/tmp is tmpfs" and "/tmp cleanup"). Every `mkdtemp` in tests is removed in `afterEach`/`afterAll` (or uses a shared helper that registers cleanup), including the bare `argus-` dirs from `datastore.test.ts` and `lifecycle.test.ts`. Where a test drives production code that creates its own temp dirs (`argus-brain-cwd-*`, `argus-build-*`, `argus-seal-*`), point that code at a per-test temp root that the test removes, rather than changing production cleanup (that is ticket 20). Extend the vitest globalSetup leak guard (`packages/core/src/testing/no-leaked-fakes.ts`) so a run fails if it leaves `/tmp/argus-*` entries it created.

**Acceptance criteria:**

- [ ] A full `pnpm check` run leaves no new `/tmp/argus-*` entries (guard enforces it; proven by a deliberate leak failing the run)
- [ ] The guard only counts entries created by its own run (concurrent runs unaffected)
- [ ] `pnpm check` and `pnpm verify:boot` pass

**Blocked by:** None (start after the ticket 07 third-round fixes merge; they touch the same test files and the guard)

## Comments
- 2026-11-22 20:40 [d37fa1ed] Reopened 2026-11-22: marked done with 3 unticked box(es).
- 2026-11-22 21:37 [0d50a746] Triage 2026-11-22: 2 DONE, 1 SMALL, 0 HUMAN, 0 OBSOLETE; see .scratch/ops/issues/02-reopened-triage-notes.md
- 2026-11-22 21:49 [0d50a746] 2026-11-22 box 3 left open: pnpm check passed (4237 tests, not stamped: dirty tree of ticket edits) but pnpm verify:boot FAILED step 4 (nuxt dev port 3150 not up in 120s; steps 1-3 pass). Not rerun; log ~/.cache/argus-scratch/boot.log.
