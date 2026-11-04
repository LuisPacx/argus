# 07: Build Runner happy path
**Model:** sonnet / high — orchestrates git, gh, claude and wrangler with live logs.

**What to build:** After approval, the worker dequeues the Proposal (FIFO by approval time, one Build at a time), clones the template to `~/code/<slug>`, creates a private GitHub repo, writes the Spec, and runs `/implement-spec` headlessly per the §4 mechanics. The log streams live into the War Room. The worker then deploys to `<slug>.workers.dev`, verifies the preview responds and the disclosure footer is present, and marks the Proposal `built` with the preview link and cost on the card.

**Blocked by:** 05, 06

**Status:** ready-for-agent

- [ ] One Build at a time, FIFO by approval time; a second approval waits (tested with the fake `claude`)
- [ ] Command shape per §4: `acceptEdits`, scoped `--allowedTools` and `--max-budget-usd` from core config, `stream-json --verbose`, cwd is the Build repo, scrubbed environment
- [ ] stream-json lines are appended to the Proposal's `build.log`, and the details view tails it live
- [ ] The final result line's session_id and total_cost_usd are stored; card cost includes the Build
- [ ] `wrangler deploy` runs; `built` is set only after the preview URL responds and the footer check passes
- [ ] Dry-run covers clone, repo creation, the claude spawn and deploy (commands logged, nothing spawned); tested
- [ ] Transitions approved -> building -> built go through the lifecycle module
- [ ] The Build Runner verifies the disclosure footer itself, never trusting the Build's own check: argus holds the canonical disclosure sentence, the runner crawls the deployed preview (same-origin links from `/`, plus a 404 path) and refuses `built` if any HTML page lacks that exact sentence; tested with a fake preview missing it
- [ ] A Build counts as successful only when the last line of the final stream-json `result` text carries no marker (template README contract), HEAD has advanced past the Spec commit, and the working tree is clean; anything else is a failure handled by ticket 08
- [ ] The runner never runs scripts from the Build repo to verify it: it uses argus's own footer check, and fails the Build if `scripts/`, `.claude/`, `.github/` or the `scripts` field of `package.json` differ from the template commit
- [ ] `pnpm check` passes
