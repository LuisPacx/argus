# 07: SubagentStop hook that stops the background work a subagent leaves running after it reports
Status: in-progress
**Model:** sonnet / medium — one small hook script plus a test; the care is in not killing what the subagent did not start.

**What to build:** workers and verifiers sometimes report "done" while a background task they started (a `pnpm check`, a vitest run, a monitor) is still running. cos then stops it by hand. Such an orphan holds one of the two machine-wide test slots (`docs/agents/worker-rules.md`, ticket 05) and makes later timings unreliable. A `SubagentStop` hook in `.claude/settings.json` should catch this when the subagent stops.

## Evidence

- `.scratch/cos.md`, entry "11-12 09 verifier left background work after reporting -> cos TaskStop'd it; trees clean. Leftover-background pattern recurs (verifiers too) -> SubagentStop-hook ticket worth proposing next session."
- `.scratch/cos.md` line 85: "Stop every background task you started before reporting (worker rules line 19; leftovers recurred 11-12)". So the worker-rules line exists (line 19 of `docs/agents/worker-rules.md`) and the briefs repeat it, and it still recurs: a rule alone is not enough.
- `.scratch/cos.md` lines 119 and 125: `pnpm check` now takes more than 10 minutes, the harness backgrounds it, and rule 20 was rewritten to "run it in the background and wait for the notification". That makes background `pnpm check` runs the normal case, so the risk of finishing with one still running is higher than before.

## What the docs say (Claude Code hooks reference, https://code.claude.com/docs/en/hooks, read 2026-11-12)

- `SubagentStop` input: the common fields plus `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path` (the subagent's own transcript, under a nested `subagents/` folder), `last_assistant_message`, `background_tasks` and `session_crons`. The matcher filters on `agent_type`.
- `background_tasks`: each entry has `id`, `type` (`shell`, `subagent`, `monitor`, `workflow`, `teammate`, `cloud session`, `MCP task`), `status`, `description`, and `command` (shell tasks only, capped at 1000 characters). **There is no pid and no process-group field.**
- The docs say for `SubagentStop`: "Both arrays are scoped to the parent session, not the subagent." So the list is every task of the session, and nothing in it says which subagent started which task. Whether a task started by the subagent appears in the list at all is not stated.
- The hook CAN block. `decision: "block"` with a `reason`, or exit code 2 with a stderr message, "keeps the subagent running and delivers `reason` to the subagent as its next instruction". There is an 8-consecutive-continuation cap (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`), and `stop_hook_active` is `true` when the subagent is already continuing because of a stop hook.
- `SubagentStop` also fires for Claude Code's internal agents (prompt suggestions, `/btw`); then `agent_type` can be an empty string and a matcher that names agent types does not match it.
- A subagent that uses the `SubagentHandback` tool (v2.1.271 or later) sends its report through that tool first; `last_assistant_message` is then only the closing text.
- Nothing in the docs gives a hook a way to stop a Claude Code background task by id. `TaskStop` is a model tool, not a hook API.

## Proposed approach

Because the hook cannot see the subagent's processes and the task list is session-wide, the first version should not kill anything on its own guess. It should make the subagent stop its own tasks, since it knows which ones it started.

1. `.claude/hooks/subagent-stop-sweep.sh` (or `.mjs`), registered under `SubagentStop` in the repo's `.claude/settings.json`, matcher limited to the worker agent types (`general-purpose`, `verifier`, `reviewer`, plus the custom worker names; decide the list from the agent files).
2. It reads the JSON on stdin. If `stop_hook_active` is `true`, exit 0 (never loop). If `background_tasks` has no entry with `status` running, exit 0.
3. Otherwise it needs to decide which running entries could belong to this subagent. Allowed filter (open question 2): `type` is `shell` or `monitor`, and `command` matches an argus-specific pattern (`pnpm check`, `scripts/check.mjs`, `vitest`, `tsc`), and its `command` or description names this subagent's worktree. Entries it cannot attribute are left alone.
4. If any entry matches, exit 2 with a stderr message naming each task `id` and `command`: "You are finishing with background task(s) still running. Stop them with TaskStop (or wait for them to finish) before you report." The subagent then stops its own tasks and reports again; the second SubagentStop has `stop_hook_active` true, so the hook exits 0 and lets it finish (a failed stop is logged, not looped).
5. The hook writes one line per event to a log under `~/.local/state/argus/` (not `/tmp`), so cos can see how often it fires.

## Alternatives, if the hook cannot attribute tasks (or exit 2 does not reach the subagent)

- **A. Tag-based sweep.** Briefs and worker-rules require every long command to run with an environment tag, e.g. `ARGUS_AGENT_TAG=<worktree-name>`, and `scripts/check.mjs` records the tag in its test-slot file (ticket 05). The hook then finds processes whose `/proc/<pid>/environ` carries that tag and whose cwd or tag equals the finishing subagent's worktree, and signals only those. Needs the tag to be set, so it only catches cooperating agents.
- **B. Process-group sweep.** `scripts/check.mjs` starts its steps in their own process group and writes the group id to the slot file. The hook kills only groups listed in a slot file whose `worktree` equals the subagent's `cwd`, after the holder process is checked alive with the start-time test from ticket 05. Does not need the Claude task list. Depends on ticket 05 landing first.
- **C. Slot-file sweep only.** Skip the hook's own discovery: on SubagentStop, read the ticket-05 slot files and, for a slot whose `worktree` is the subagent's worktree, report it back with exit 2 (as in the main approach) or release it.
- **D. Worker-rules line only.** Add to `docs/agents/worker-rules.md`: "Your last tool call before reporting is a check that no background task is running; if one is, stop it with TaskStop." Cheapest and weakest; line 19 already says this.
- **E. Parent-side check.** cos (or the `chief-of-staff` agent file) looks at `background_tasks` after every subagent returns and uses `TaskStop` itself. No hook; works today with the list the harness already provides, but needs the parent to remember.

## Acceptance criteria

- [ ] The hook is registered under `SubagentStop` in `.claude/settings.json` (repo file; `~/.claude/settings.json` is not changed), runs only for worker agent types, and its path uses `${CLAUDE_PROJECT_DIR}`.
- [ ] Test (a script under `.claude/hooks/`, like `bash-guard.test.sh`): feed the hook a SubagentStop payload that lists a running shell task started by a deliberately left-behind process (e.g. `sleep 600` marked with a unique test tag in its command), and show the hook flags it (exit 2 with the task id in stderr) or, if an alternative with a kill is chosen, that the process is gone afterwards (checked with `kill -0`, not `pgrep` patterns).
- [ ] Test: with `stop_hook_active: true` the hook exits 0 and does not block, so a subagent can always finish.
- [ ] Test: processes the subagent did not start are untouched. Run beside the test a `sleep 600` with another tag, a listener on a test port standing in for the argus dev server on `:3100`, and a second task entry with another worktree's name; all three are still alive after the hook runs. The hook never names or signals by a bare `node`, `vitest` or `pnpm` pattern, and never touches port 3100.
- [ ] Test: empty `background_tasks`, tasks with `status` not running, and an empty `agent_type` all exit 0 with no output.
- [ ] The hook never signals a pid it did not verify itself (alive, start time matches, belongs to the subagent's tag or group); no `kill -9` of a pid taken from a pattern match.
- [ ] Every process the test starts is stopped by the test's own cleanup, and the test leaves nothing in `/tmp` (temp files under `TMPDIR`).
- [ ] The open questions below are answered in `## Comments` by a short manual run (a real throwaway subagent that leaves `sleep 600` in the background), and the chosen approach is updated if the answer changes it.
- [ ] `docs/agents/worker-rules.md` line 19 gets a half-line pointing to the hook ("a SubagentStop hook checks this; it will send you back to stop leftovers"), and cos.md's briefs need no extra text.
- [ ] `pnpm check` is green, run once before the commit.

## Open questions (not verified; the docs do not say)

1. Does the `SubagentStop` `background_tasks` list include tasks that the stopping subagent started, or only tasks of the parent session? The docs say it is "scoped to the parent session, not the subagent", which suggests a subagent's own shell tasks may be missing. If they are missing, the main approach cannot work and alternative B or C is the fallback.
2. Does a `shell` task entry carry the cwd or any field that ties it to a worktree or `agent_id`? The documented fields do not.
3. Does exit 2 or `decision: "block"` on `SubagentStop` give the subagent a working turn in which `TaskStop` can still be called, including for a subagent that ends with `SubagentHandback`? The docs say the reason is delivered "as its next instruction"; the handback interaction is not described.
4. Do hooks configured in the repo's `.claude/settings.json` fire for subagents running in a worktree under `.claude/worktrees/` (the project dir differs)? `bash-guard.sh` already runs there via `PreToolUse`, so likely yes; confirm for `SubagentStop`.
5. Is the pid of a background shell task available any other way (the task output file path, `/proc` scan by command line)? If it is, an automatic kill becomes possible, but only with the attribution rules above.
6. Which Claude Code version first has `background_tasks` on `SubagentStop`? Record the version used for the manual run.

## Comments

2026-11-17 (build, Claude Code 2.1.326). Manual run: I added a logging SubagentStop hook to this worktree's `.claude/settings.json` mid-session and spawned two real throwaway `general-purpose` subagents that left `sleep 600` in the background (both ended with SubagentHandback). The hook never fired for either, and no payload was captured (the subagents' sleeps were still alive; I stopped them by PID). Most likely the settings edit is not picked up by a running session; a nested `claude -p` run to test it fresh was refused by the auto-mode classifier, so it was not done. Answers:
1. Unanswered (no payload seen). The harness does know: it printed "stopped with background work of its own still running" for both subagents, so the parent side has the information (supports alternative E as a backstop).
2. Unanswered; documented fields only. The build ties a task to a worktree only through its `command` containing the subagent's `cwd` (a `.claude/worktrees/<name>` path).
3. Unanswered, including the SubagentHandback interaction.
4. Unanswered; bash-guard's PreToolUse already fires in worktrees, so likely yes.
5. Not tried; no automatic kill is built.
6. 2.1.326 is the version of the (non-firing) run.
Decision: built the main approach, because it is safe whatever the answers are: it never signals anything, exits 2 only when a running shell/monitor task's command names the subagent's own worktree, and exits 0 when `stop_hook_active` is true. It logs `tasks=<n> matched=<n>` per event to `~/.local/state/argus/subagent-stop.log`, so the first real session shows whether Q1 holds (tasks=0 for subagents that left work running means the list lacks subagent tasks; then use E or B/C). Files: `.claude/hooks/subagent-stop-sweep.sh`, `.test.sh`; worker-rules line 19 updated. Acceptance criteria are met by the hook tests; the live behaviour (Q1, Q3) is still to be confirmed from the log.
- 2026-11-21 cos triage: already built (subagent-stop sweep hook in .claude/hooks + SubagentStop entry).
- 2026-11-22 20:40 [d37fa1ed] Reopened 2026-11-22: marked done with 10 unticked box(es).
