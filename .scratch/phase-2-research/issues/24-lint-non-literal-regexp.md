# 24: Lint rejects a RegExp built from a non-literal
**Model:** sonnet / medium — one local lint rule, four small refactors, a docs line.

**What to build:** Ticket 02's review found `study/website.ts` building RegExps from robots.txt patterns (a ReDoS hole, fixed in 972828c). Operator decision 2026-11-09: make that hard to write again. `pnpm lint` (oxlint, run by `pnpm check` and so by the pre-push hook) now fails on `new RegExp(x)` or `RegExp(x)` whose first argument is not a string, regex or expression-free template literal. Oxlint 1.91 has no `no-restricted-syntax`, so the rule is a small local JS plugin (no new dependency).

**Status:** done on branch worktree-agent-afd1ab45c4c9962ce (not merged)

## Where it lives

- `.oxlintrc.json`: loads the plugin, sets `argus/no-dynamic-regexp` to error, off for `*.test.*`, `test/` and `testing/` paths.
- `config/oxlint/argus-plugin.js`: the rule; its message says why and what to do.
- Existing hits refactored to literals: `sources/rss.ts` `attr()` (one literal pattern per attribute), `spec-drafting.ts` (line compare instead of per-heading regex), `containment-policy.ts` (`--tmpfs` value checked with a literal regex after the validated dir), `scripts/warroom-pages.mjs` (one literal h3 regex, compare texts).
- `docs/agents/worker-rules.md`: one line for reviewers.

## Acceptance criteria

- [x] A temporary `new RegExp(someVar)` in a production file fails `pnpm lint` with a message saying why and what to do.
- [x] Tests are exempt; production sources in `packages/`, `apps/` and `scripts/` are covered.
- [x] Every existing hit is refactored to a literal; no disable comments.
- [x] `docs/agents/worker-rules.md` tells reviewers to enforce it.
- [x] `pnpm check` passes.

## Comments
