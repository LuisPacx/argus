# 12: Worktree dependencies installed when a worker starts
**Model:** sonnet / effort: low — one small script, one settings entry, one docs line.

Status: done
**User decision:** do NOT replace Claude Code's own worktree creation (no `WorktreeCreate` hook): we keep its lock, its cleanup sweep and `.worktreeinclude`. Install dependencies when a worker starts in a copy that has no `node_modules`. The `tsc` cache is out of scope.

## Problem

Agent worktrees are created under `.claude/worktrees/` from `origin/main` with no `node_modules`. Every worker first runs `pnpm install --offline --frozen-lockfile` before it can test.

## Findings

- `WorktreeCreate` replaces Claude Code's git logic (no lock, no sweep marker, `.worktreeinclude` not processed). Rejected by the user.
- `SubagentStart` (hooks reference): fires when Claude spawns a subagent; matcher is the agent type; input is the common fields plus `agent_id` and `agent_type`; it "can't block subagent creation" (it can only inject `additionalContext`). Command hooks default to a 600 s timeout and `timeout` is in seconds. The doc does not say whether `cwd` in the input is the subagent's worktree or the parent's directory, and it has no worktree-path field. The doc says `cwd` is the worktree root after Claude enters a worktree (`claude --worktree`, `EnterWorktree`), so `SessionStart` sees the path for those sessions.
- Because `SubagentStart` may report the parent's `cwd`, the hook is best effort. The same script is also a manual command, `pnpm wt:setup`, and `worker-rules.md` tells workers to run it first when `node_modules` is missing. The script is a no-op everywhere else.
- The pnpm store is one shared store on the home disk, so an offline install is a hardlink pass and needs no network.

## Approach

Add `scripts/wt-setup.mjs` (exports `shouldInstall(dir)` and `main`):

1. Directory = `cwd` from the hook JSON on stdin if stdin is piped and parses, else `process.cwd()`.
2. No-op (exit 0, no output) unless the directory is the repository root's `.claude/worktrees/<name>` or inside it, the `<name>` directory has a `package.json` and has no `node_modules`. The main checkout is never touched.
3. Run `pnpm install --offline --frozen-lockfile` in `.claude/worktrees/<name>`, output to stderr. On failure print one warning line to stderr and exit 0.
4. No temp writes.

Wire it as `pnpm wt:setup`, as a `SubagentStart` hook (timeout 300 s) and as a `SessionStart` hook in `.claude/settings.json`; the existing `PreToolUse` hook stays. Add one line to `docs/agents/worker-rules.md`.

## Acceptance

- [x] `shouldInstall` is false for the main checkout, for a path outside `.claude/worktrees/`, and for a worktree that already has `node_modules`; true for a worktree dir (or a subdirectory of it) with `package.json` and no `node_modules`. Covered by `scripts/wt-setup.test.ts`.
- [x] A failing install prints one `wt-setup: ... failed` warning to stderr and exits 0 (test with an injected runner).
- [x] The script uses `--offline --frozen-lockfile`, and never writes to `/tmp`.
- [x] `.claude/settings.json` has `SubagentStart` and `SessionStart` hooks that run the script; the `PreToolUse` hook is unchanged; `package.json` has `wt:setup`.
- [x] `docs/agents/worker-rules.md` has one line: run `pnpm wt:setup` first when `node_modules` is missing.
- [x] `pnpm check` passes.

## Not in scope

- The `tsc` incremental cache.
- Any `WorktreeCreate` / `WorktreeRemove` hook.

## Open questions

- Does `SubagentStart` report the isolated worktree as `cwd`? Check in the first new session that spawns a worktree agent; if not, the rules line is what works.
- 2026-11-21 cos triage: already built (subagent-stop sweep hook / Build budget gate / wt-setup SubagentStart hook)

## Comments
- 2026-11-22 20:40 [d37fa1ed] Reopened 2026-11-22: marked done with 6 unticked box(es).
- 2026-11-22 21:37 [0d50a746] Triage 2026-11-22: 6 DONE, 0 SMALL, 0 HUMAN, 0 OBSOLETE; see .scratch/ops/issues/02-reopened-triage-notes.md
- 2026-11-22 21:38 [0d50a746] Boxes ticked on triage evidence, see .scratch/ops/issues/02-reopened-triage-notes.md
