# 20: Production temp-dir cleanup

**Model:** sonnet / medium — cleanup on every terminal path of two runners.

**Status:** partly done: per-Build home retention landed with ticket 08; per-path temp-dir cleanup tests and the check/verify:boot box are open (sonnet/medium)

**What to build:** Production paths in `brain.ts` and `build-runner.ts` (`argus-brain-cwd-*`, `argus-build-*`, `argus-seal-*`, env and config files) remove their temp dirs on every terminal path (success, failure, timeout, shutdown), except what ticket 08 and containment-design §13 deliberately keep for `build-failed` resume (the per-Build home). Split from ticket 19.

**Acceptance criteria:**

- [ ] Brain runs and Builds remove their temp dirs on success, failure, timeout and shutdown (a test per path)
- [x] The per-Build home is kept for `build-failed` and removed on `built`/`dismissed` (design §13 Q8)
- [ ] `pnpm check` and `pnpm verify:boot` pass

**Blocked by:** 15
