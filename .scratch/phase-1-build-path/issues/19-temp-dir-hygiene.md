# 19: Temp-dir hygiene

**Model:** sonnet / medium — many small test edits plus two production cleanup paths and a guard.

**Status:** ready-for-agent

**What to build:** argus test runs leaked ~9,400 `/tmp/argus-*` entries (~570 MB) on a RAM-backed `/tmp` between 11-04 and 11-05 (`.scratch/cos.md`, entries "FOUND: ~10k leaked" and "/tmp is tmpfs"). Every `mkdtemp` in tests is removed in `afterEach`/`afterAll` (or uses a shared helper that registers cleanup), including the bare `argus-` dirs from `datastore.test.ts` and `lifecycle.test.ts`. Production paths in `brain.ts` and `build-runner.ts` (`argus-brain-cwd-*`, `argus-build-*`, `argus-seal-*`, env/config files) remove their temp dirs on every terminal path (success, failure, timeout, shutdown), except what ticket 08 / design §13 deliberately keep for `build-failed` resume. Extend the vitest globalSetup leak guard (`packages/core/src/testing/no-leaked-fakes.ts`) so a run fails if it leaves new `/tmp/argus-*` entries it created.

**Acceptance criteria:**

- [ ] A full `pnpm check` run leaves no new `/tmp/argus-*` entries (guard enforces it; proven by a deliberate leak failing the run)
- [ ] Production Build and brain runs remove their temp dirs on success, failure, timeout and shutdown (tests per path)
- [ ] The guard only counts entries created by its own run (concurrent runs unaffected)
- [ ] `pnpm check` and `pnpm verify:boot` pass

**Blocked by:** 15
