# 12: Worktree dependencies installed on create
**Model:** sonnet / effort: medium — one small script and one settings entry, but the hook replaces Claude Code's own worktree creation, so the git steps need care.

**Status:** open

## Problem

Agent worktrees are created under `.claude/worktrees/` from `origin/main` with no `node_modules`. Every worker first runs `pnpm install --offline --frozen-lockfile` before it can test, and its first `tsc` has no incremental cache.

## Findings

- Claude Code has a `WorktreeCreate` hook (docs: hooks reference, `worktrees` page). It has no matcher and fires for `--worktree`, `isolation: "worktree"` and background sessions. It **replaces** the default git logic: the hook gets JSON on stdin (it has `name`; `cwd` is the project), must create the worktree itself, and prints only the path on stdout. A non-zero exit fails creation. There is no "after create" hook, and `.worktreeinclude` is not processed once the hook is set.
- `SessionStart` is not a substitute: it does not fire for `isolation: "worktree"` subagents, which is how workers run.
- `.claude/settings.json` today has only a `PreToolUse` Bash hook (`.claude/hooks/bash-guard.sh`). No `WorktreeCreate`, no `.worktreeinclude`.
- No `scripts/` helper installs dependencies. `scripts/dev-env.mjs` and `scripts/check.mjs` are the nearest style to copy; reuse nothing from them but the `.mjs` conventions.
- The pnpm store is one shared store on the home disk (`pnpm store path` gives `~/.local/share/pnpm/store/v11`), so an offline install is a hardlink pass and needs no network.
- `tsc` has no `incremental` or `tsBuildInfoFile` set in any tsconfig or package.json yet, so there is no cache to warm today. Out of scope here (see Not in scope).

## Approach

Add `scripts/worktree-create.mjs` and register it as the `WorktreeCreate` hook in `.claude/settings.json` (`"command": "node ${CLAUDE_PROJECT_DIR}/scripts/worktree-create.mjs"`). When Claude Code creates a worktree it runs, in order:

1. Read `name` from the stdin JSON. Fetch `origin` main (capped at 5 s, never prompting), then `git worktree add -b worktree-<name> <repo>/.claude/worktrees/<name> origin/main`. If the worktree already exists, reuse it (same as the default). This repeats what Claude Code does by default (`worktree-<name>` branch, `.claude/worktrees/<name>`, `origin/main` base).
2. In the new worktree run `pnpm install --offline --frozen-lockfile`, with all output sent to stderr.
3. Print the worktree path on stdout, nothing else. Exit 0.

No write goes to `/tmp`: git and pnpm use the worktree and the shared pnpm store on the home disk; any temp use goes through `os.tmpdir()` with `TMPDIR` as the session sets it (`/var/tmp`), never a hardcoded `/tmp`.

**Lockfile changed, offline install fails.** `--frozen-lockfile` fails when `pnpm-lock.yaml` does not match `package.json`, and `--offline` fails when the store lacks a package the new lockfile needs. In both cases the hook must not fail creation: print one line to stderr (`worktree-create: pnpm install --offline failed; run "pnpm install --frozen-lockfile" (online) in <path>`), still print the worktree path and exit 0. The worker then sees no `node_modules` and runs the online install as it does today. A missing worktree is worse than a missing install.

## Acceptance

- [ ] `.claude/settings.json` has a `WorktreeCreate` hook that runs `scripts/worktree-create.mjs`; the existing `PreToolUse` hook is unchanged.
- [ ] A new worktree made with `claude --worktree <name>` (or an `isolation: "worktree"` agent) is at `.claude/worktrees/<name>`, on branch `worktree-<name>`, at `origin/main`, and has `node_modules` so `pnpm --dir <wt> test:fast` runs with no further install.
- [ ] stdout of the script is exactly the worktree path plus a newline; pnpm and git output goes to stderr.
- [ ] A unit test (`scripts/worktree-create.test.ts`, temp dirs via `packages/core/src/testing/temp.ts`) covers: path-only stdout; reuse of an existing worktree; a failing install still prints the path, exits 0 and writes the warning line to stderr.
- [ ] A test or grep check shows the script never writes under `/tmp`.
- [ ] `docs/agents/worker-rules.md` gets one line saying worktrees arrive installed and a worker only installs when `node_modules` is missing; `scripts/test-tiers.test.ts` still passes (test in the right tier).
- [ ] `pnpm check` passes.

## Not in scope

- Warming the `tsc` incremental cache (needs `incremental` and `tsBuildInfoFile` under `node_modules/.cache/` added to the typecheck config first; separate ticket).
- A `WorktreeRemove` hook: leave removal to Claude Code, and the periodic sweep will skip these worktrees (no marker), so they need manual `git worktree remove`. Revisit if worktrees pile up.

## Open questions

- Replacing creation also loses Claude Code's own steps (the git-LFS filter-driver guard, the cleanup marker, the lock, the `.worktreeinclude` copy). Acceptable for this repo (no LFS, no `.worktreeinclude`)? The cheaper alternative is no hook at all: a `pnpm wt:setup` script plus a worker-rules line, at the cost of every worker remembering to run it.
