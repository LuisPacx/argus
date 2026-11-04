# 01: Monorepo skeleton and tooling
**Model:** sonnet / medium — greenfield setup with known conventions, some judgment on tool choices.

**What to build:** An agent or developer can clone argus, install, and run one check command that type-checks, lints and tests the whole workspace. The workspace has the worker app, the War Room app (Nuxt 4 + Nuxt UI 4) and the core package, laid out as in `docs/architecture.md` §9. The worker runs a re-entrancy-guarded tick loop (ported from helios, §11) and the War Room serves a placeholder page. A coding-standards document gives reviewers rules to enforce.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] pnpm workspace with the worker, War Room and core packages per §9
- [x] `typescript` 7.x pinned to an exact version; typecheck script is `tsc --noEmit --checkers 1`
- [x] vitest and a linter configured; one root `pnpm check` runs typecheck, lint and tests, and passes
- [x] Worker starts and logs a tick on an interval; a test shows overlapping ticks do not re-enter
- [x] War Room dev server serves a placeholder page
- [x] `.data/` and `.env` are gitignored; `.env.example` lists expected variables with no values
- [x] `CODING_STANDARDS.md` at the repo root covers: the worker is the only writer of state transitions, no secrets in the repo or logs, dry-run on anything that spends, caps are never silently raised (§10), type-check and test once before committing
- [x] Incremental type-check build info added only if warm runs are measurably faster; the measurement is noted under Comments

## Comments

Done. Incremental type-check build info NOT added: on apps/warroom (the largest project) warm runs with `--incremental` took 1.36-1.53 s versus 0.81-1.31 s without, so no measurable gain. Revisit when the codebase grows.

Notes: `pnpm check` runs typecheck (per package; War Room runs `nuxt prepare` then `tsc` on `.nuxt/tsconfig.json`, so `.vue` files are not type-checked since vue-tsc is not used with TS 7), oxlint, and vitest. `pnpm-workspace.yaml` allows the esbuild build script (pnpm 11 blocks it otherwise).
