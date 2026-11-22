# Triage of the tickets reopened on 2026-11-22 (read-only; no box ticked, no status changed)

Classes: DONE (evidence now), SMALL (short work left), HUMAN (needs Luis), OBSOLETE (superseded).
Method: each box read against the code on main, the ticket Comments, git, and (for "pnpm check passes" boxes) the check stamps in `.git/argus-check/` (a stamp exists only when the full suite passed on that exact tree; old stamps are pruned, so a missing stamp is not proof of failure). Targeted test files re-run today, all green: `.claude/hooks/subagent-stop-sweep.test.sh`, `scripts/wt-setup.test.ts` (11), `packages/core/src/{propose,rubric,propose-pass}.test.ts` (134), `apps/warroom/server/test/why-panel.test.ts` (6), `packages/core/src/narrative-verdict.test.ts` + `apps/warroom/server/test/narrative-verdict{,-render}.test.ts` (54).

Totals: 52 boxes. DONE 33, SMALL 7, HUMAN 7, OBSOLETE 5.
Could close outright: hardening/12, phase-3-feedback/21, phase-3-feedback/24. Close after one waiver by Luis: viral-sources/04 (5 OBSOLETE + the "check before each commit" box), phase-3-feedback/17 (the "no hand write" box), viral-sources/03 (same kind of box).
One `pnpm check` on current main (committed, clean tree) would settle every SMALL "check passes" box at once (hardening/07 box 10, phase-1/19 box 3).

---

## .scratch/hardening/issues/07-subagent-stop-background-sweep.md (10 boxes: 8 DONE, 2 SMALL)

1. Hook registered under `SubagentStop` in repo `.claude/settings.json`, worker agent types only, `${CLAUDE_PROJECT_DIR}` path. DONE: `.claude/settings.json` lines 14-22 (matcher `general-purpose|claude|verifier|reviewer`, command `${CLAUDE_PROJECT_DIR}/.claude/hooks/subagent-stop-sweep.sh`); commit ea69b17. (That `~/.claude/settings.json` is unchanged cannot be checked from the repo.)
2. Test: left-behind task flagged, exit 2 with task id. DONE: `.claude/hooks/subagent-stop-sweep.test.sh` cases "flags own running shell task", "flags own monitor task" (stderr contains `b1`); run today, all passed. Note: it feeds a synthetic payload with a stand-in `sleep`, not a real subagent.
3. Test: `stop_hook_active: true` exits 0. DONE: case "stop_hook_active exits 0".
4. Test: unrelated processes untouched (other tag, listener standing in for :3100, other worktree's task). DONE: cases "other worktree's task untouched", "worktree is a prefix of another task's worktree", and the three `pid ... still alive` checks (sleep 600/601, python listener). The hook contains no kill, no bare `node`/`vitest`/`pnpm` pattern and no 3100.
5. Test: empty `background_tasks`, non-running status, empty `agent_type` exit 0 silently. DONE: cases "finished task", "non-shell type", "empty agent_type, no worktree cwd", "empty background_tasks", "no background_tasks field", "garbage input".
6. Hook never signals an unverified pid. DONE: `subagent-stop-sweep.sh` sends no signal at all (reads JSON, exits 0 or 2).
7. Test cleans its processes and leaves nothing in /tmp. DONE: test `cleanup` trap kills every started pid and `rm -r "$tmp"`; temp dir is `mktemp -d "${TMPDIR:-/var/tmp}/sweep-test.XXXXXX"`.
8. Open questions answered in `## Comments` by a manual run. SMALL: the 2026-11-17 comment says Q1-Q6 were unanswered because the hook did not fire in that run, but the hook has since fired in real sessions: `~/.local/state/argus/subagent-stop.log` (61 KB since 2026-11-17) has 57 lines with `matched>=1` and `tasks` 1-6 for subagents in `.claude/worktrees/agent-*` (e.g. agent-aa4ba0243821e0eb4 on 2026-11-19: `tasks=3 matched=1`, then `active=true` on the retry turn). That answers Q1 (subagent tasks are in the list), Q3 (exit 2 gives the subagent another turn; `active=true` follows), Q4 (fires in worktrees). Work left: write those answers into Comments (Q2: only the command-path tie works; Q5/Q6: version not recorded). No new run needed.
9. `docs/agents/worker-rules.md` gets a half-line pointing to the hook. DONE: line 19 now reads "A SubagentStop hook checks this; it will send you back to stop leftovers."
10. `pnpm check` green once before the commit. SMALL: the first commit ea69b17 is stamped, the review-fix commit f73f9f2 is not. One `pnpm check` on main settles it.

## .scratch/hardening/issues/12-worktree-dependencies-installed-on-create.md (6 boxes: 6 DONE)

1. `shouldInstall` false for main checkout, outside `.claude/worktrees/`, with `node_modules`; true for worktree dir/subdir with package.json and no node_modules. DONE: the function is now `worktreeToInstall` in `scripts/wt-setup.mjs` (renamed after review); `scripts/wt-setup.test.ts` cases "returns the worktree root for the root and for a subdirectory", "is null for the main checkout and for paths outside .claude/worktrees", "is null when node_modules exists", plus symlink/`..`/foreign-repo cases; 11 tests pass today.
2. Failing install: one `wt-setup: ... failed` warning, exit 0. DONE: test "warns once and does not throw when the install fails" (injected runner); `scripts/wt-setup.mjs` line 47.
3. Uses `--offline --frozen-lockfile`, never writes /tmp. DONE: `scripts/wt-setup.mjs` line 39; no tmp path in the file.
4. `SubagentStart` and `SessionStart` hooks run the script, `PreToolUse` unchanged, `package.json` has `wt:setup`. DONE: `.claude/settings.json` lines 26-48 (both run `node ${CLAUDE_PROJECT_DIR}/scripts/wt-setup.mjs --hook`), PreToolUse still `bash-guard.sh`; `package.json` line 28.
5. worker-rules line. DONE: `docs/agents/worker-rules.md` "A worktree under `.claude/worktrees/` with no `node_modules`: run `pnpm wt:setup` first ...".
6. `pnpm check` passes. DONE: final ticket commit 8bc2b0c has a stamped tree.
(The open question about `SubagentStart` reporting the worktree as `cwd` is not an acceptance box; the hook log above shows subagent cwd is the worktree path, which suggests yes.)

## .scratch/hardening/issues/13-war-room-restarts-after-exit.md (1 box: 1 HUMAN)

1. "The cause of the 03:00 exit fixed: not found." HUMAN: a decision, not work. The box is worded as a fix that cannot be shown; the Comments record a read-only investigation with nothing found, and the mitigation is built (ticks above). Evidence since: `.data/run/warroom-exits.log` and `worker-exits.log` hold only `action=stopped (dev:stop)` exits (last 2026-11-22 19:37Z), no unexplained exit in 3 days. Luis: reword the box to "restart plus exit log is the mitigation; investigation recorded" and tick, or leave the ticket open until an unexplained exit shows up.

## .scratch/meta-redesign/issues/11-operator-angle-for-meme-ideas.md (1 box: 1 HUMAN)

1. Live read, once: the Operator files the GTA 6 iguana angle from `/meta`; paste request row, 3 Proposal ids, cost, page text. HUMAN: needs the Operator's POST from the real page with the worker running on this code and `ARGUS_MEME_IDEAS=1`, and a day with a current Meta (the live DB was not opened). All test boxes of the ticket are ticked.

## .scratch/phase-1-build-path/issues/19-temp-dir-hygiene.md (3 boxes: 2 DONE, 1 SMALL)

1. Full check leaves no new `/tmp/argus-*` entries; guard enforces, proven by a deliberate leak. DONE: vitest globalSetup `packages/core/src/testing/no-leaked-fakes.ts` points TMPDIR at a private `argus-test-run-*` dir and fails the run when anything is left (`sweepTempRoot`); test "the run fails when it leaves a temp entry behind, and the entry is removed" in `no-leaked-fakes.test.ts` is the deliberate leak; commit b130d57 (and test-hygiene ticket 01, 269e5d3). Today `ls /tmp | grep argus` is empty.
2. Guard counts only its own run's entries. DONE: each run has its own `mkdtemp` root; tests "reaps the dead guard's temp root ... and leaves a live guard's registry alone" and "a fake claude ... registers with this run".
3. `pnpm check` and `pnpm verify:boot` pass. SMALL: b130d57 and 269e5d3 trees are not stamped (stamps pruned) and `verify:boot` has no record. Run `pnpm check` and `pnpm verify:boot` once on main.

## .scratch/phase-3-feedback/issues/17-proposal-tech-value-and-reason.md (7 boxes: 6 DONE, 1 HUMAN)

1. SKILL.md and prompt state Tech-value rule and `reason`. DONE: `.claude/skills/propose/SKILL.md` lines 21-23, 38; tests `propose.test.ts` "states the Tech-value rule and the `reason` key outside the untrusted block (ticket 17)" and the "the propose skill" describe (all keys incl. `reason`, `interaction`).
2. `parseProposeOutput` requires `reason` (<=300, one line). DONE: `propose.test.ts` "requires a one-line `reason` of at most 300 characters (ticket 17)".
3. Display-only Tech refused, accepted with an interaction. DONE: `propose.test.ts` "refuses a display-only Tech and accepts the same Tech with an interaction (ticket 17)".
4. Revised: required `interaction` (<=200), stored in `proposals.interaction`, verb check. DONE: `datastore.ts` line 410 (`ensureColumn ... interaction`); tests "accepts the widened action verbs as an interaction for any display-ish Tech" and "refuses a missing, empty or action-less `interaction` even when the Tech names no display word".
5. Display-only refusal gets one repair retry; still display-only is refused, nothing stored. DONE: `propose-pass.test.ts` "repairs a display-only Tech (ticket 17)..." and "a Tech that is still display-only after the repair is refused and nothing is stored"; cap tests "the repair counts against the daily run cap / research budget".
6. New Rubric version with Tech-value line via `migrateRubric`, once, fresh DB seeds it in v1. DONE: `rubric.ts` `TECH_VALUE_LINE`; `rubric.test.ts` describe "the Tech-value line (ticket 17)": "a fresh database seeds the line in version 1", "an existing database gets the line as a new version ...", "runs once ...", "builds on the Operator's latest version".
7. No write to `.data/argus.db` by hand; tests use their own DB. HUMAN: tests do use their own DB (true), but the Comments record that the 2026-11-11 deploy deleted Proposals from the live DB by hand (user-approved reset), so the first half cannot honestly be ticked. Luis: waive or reword to "tests use their own DB" and tick.

## .scratch/phase-3-feedback/issues/21-why-this-proposal-panel.md (4 boxes: 4 DONE)

1. API returns `signals` (<=5, newest first), `[]` without Narrative. DONE: `apps/warroom/server/test/why-panel.test.ts` "GET /api/proposals/:id returns reason, interaction, at most 5 newest Signals, and the Score ..." and "... gives a hand-entered Proposal no Signals ...".
2. Panel content and "not recorded" note. DONE: same file, "the panel shows reason, interaction, Signals with links, scores, rationale, Rubric version and evidence" and "old Proposals (reason and interaction empty) show them as absent, not blank".
3. Escaping, no `v-html`. DONE: "untrusted text renders escaped, and a non-http(s) Signal link is not an anchor"; `grep -c v-html apps/warroom/app/components/WhyPanel.vue` = 0.
4. Only http(s) links are anchors. DONE: "safeHttpUrl keeps http(s) and refuses everything else" and the render test above. All 6 tests pass today.

## .scratch/phase-3-feedback/issues/24-context-sources-never-propose.md (1 box: 1 DONE)

1. Meta summary context (follow-up): `meta-summary` prompt carries the context block, or a Comment says why not. DONE: commit 5051647 added matching news (context-class Signals whose title names the Meta's subject, newest first, max 5) in its own untrusted boundary to the `meta-summary` prompt (`packages/core/src/meta/summary.ts` ~line 285); ADR 0012 line 29 records it and why it is subject-matched rather than the generic block; tests `meta/summary-pass.test.ts` "sends the matching news of that Meta inside its own untrusted boundary, and the prompt of a Meta with none is the one without", `meta/summary.test.ts` (boundary, hostile headline, no-news prompt unchanged), with a fake Brain. Suggest a one-line Comment pointing at ADR 0012 when ticking.

## .scratch/viral-sources/issues/03-meta-ranking-from-launchpad-data.md (1 box: 1 HUMAN)

1. "Full `pnpm check` passes once before each commit." HUMAN: process claim that cannot be re-run; the ticket's own Comment says one check ran once for three commits (115 files, 1833 tests, stamped tree c054d098c1), so the box was left open on purpose. Luis: waive (the final tree passed) and tick.

## .scratch/viral-sources/issues/04-beta-finder.md (6 boxes: 5 OBSOLETE, 1 HUMAN)

Status note says closed: slices 3 and 4 dropped 2026-11-18 (commit 169d954; the re-run backtest showed no lift: room-left 2.1% vs base 1.2%, CI -0.9 to +1.7 pts; the Operator dropped slices 3 and 4, switch stays off). The Beta role is carried by the `meme` Proposal kind (ADR 0013; GLOSSARY: "Argus proposes one as a Meme Proposal"; "Beta Proposal" is listed as a term to avoid).
1. Output validation (slice 3, `parseBetaOutput`). OBSOLETE: slice 3 dropped (169d954, ticket line 171); no `parseBetaOutput` exists in the code.
2. Kind, migration and lifecycle (a `beta` kind). OBSOLETE: superseded by ADR 0013 (a Proposal has a kind: narrative or meme); slice 3/4 dropped.
3. Caps and switch. OBSOLETE: slice 4 dropped; the meme path has its own caps (ADR 0013 amendments).
4. War Room shows it (Beta pill, Meta numbers, browser check). OBSOLETE: slice 4 dropped; the meme Proposal UI is covered by meta-redesign tickets.
5. Docs: ADR for a Beta Proposal kind, GLOSSARY entry. OBSOLETE: ADR 0013 and the GLOSSARY `Beta` entry (line 84) exist; the separate `beta` ADR and "Beta Proposal" entry are the dropped slice.
6. Full `pnpm check` once before each commit. HUMAN: same as viral-sources/03; the last commit (254d1e8) is stamped. Luis: waive and tick, then the ticket can close.

## .scratch/warroom-redesign/issues/04-meta-strip-and-page.md (2 boxes: 2 SMALL)

1. `verify:boot` still healthy (page list generated from `app/pages`). SMALL: the generation part is DONE (`scripts/verify-boot.mjs` step 4 uses `pageRoutes` from `scripts/warroom-pages.mjs` over `apps/warroom/app/pages`, so `/meta` is included); work left is one `pnpm verify:boot` run (uses port 3150, not 3100).
2. Browser check by cos: desktop and phone width, strip scroll, anchor jump from a card. SMALL: run `pnpm page:check --seed /` and `/meta` (headless, 1240 and 390 px; meta-redesign/11 records `--seed --all` exit 0 covering `/` and `/meta`, but not the strip scroll or anchor jump); read the screenshots and cite the output folder. Add `--keys` for the anchor jump if wanted.

## .scratch/warroom-redesign/issues/06-compact-research-usage.md (1 box: 1 SMALL)

1. Browser check by cos: desktop and phone width, details disclosure, bar height against the old card. SMALL: `pnpm page:check /` (live data, or `--seed /`) at 1240 and 390 px, a `--keys "focus=<summary selector>,Enter,Escape"` run for the `<details>`, read the screenshots. The old card is gone, so "height against the old card" can only be judged by eye or dropped.

## .scratch/warroom-redesign/issues/07-clean-up-a-build.md (1 box: 1 HUMAN)

1. Browser check by cos on a throwaway built-then-dismissed Proposal. HUMAN: the user decided 2026-11-12 to defer to the next real dismissed Build (no throwaway Build); it also needs a Cloudflare/GitHub credential check (the gh token lacked `delete_repo`) and a real Build. Not doable by an agent without that Build.

## .scratch/warroom-redesign/issues/09-dismiss-stops-a-running-build.md (1 box: 1 HUMAN)

1. Browser check by cos with the result cited in Comments. HUMAN: same deferral (user, 2026-11-12): needs a real Build dismissed while running; check the stopped note, the three artifact results, and a Clean up build after it.

## .scratch/warroom-redesign/issues/19-operator-verdict-on-narratives.md (7 boxes: 6 DONE, 1 SMALL)

1. Store. DONE: `packages/core/src/narrative-verdict.test.ts` ("stores the verdict with the latest Score's id and Rubric version", "a second verdict keeps both rows and becomes the current one", "a Narrative with no Score stores a null score id and Rubric version", "is on the War Room's allowed view, and nothing edits or deletes a verdict (type test)", "is idempotent on a second open, and an old database without the table opens ...").
2. API. DONE: `apps/warroom/server/test/narrative-verdict.test.ts` (200 and row, 404, 400 cases, 501-character note, "a body that tries to set the Score or the Rubric version is refused", "changes no Proposal, no Narrative and no command").
3. Export. DONE: same file, "is an empty array with no verdicts", "lists every verdict with the Score at the time, the latest Score and scoreChanged; reading writes nothing", "is a GET-only file, so a POST to it is 405". The route is `apps/warroom/server/api/narrative-verdicts.get.ts` (docs/architecture.md matches).
4. Render. DONE: `narrative-verdict-render.test.ts` (buttons, tags, counter, dimensions only with a score tag, current verdict plus history, escaped `<img>` note, pill, Proposal links or no block, no `v-html` grep).
5. Browser (`pnpm page:check` on `/narratives` and `/narratives/{id}`). SMALL: no page:check run is recorded for this ticket (page-seed rows were added in ff5e20c). Run `pnpm page:check --seed /narratives /narratives/{...}` plus `--keys` for the form toggle if it is a `<details>`, say the run was seeded, read the screenshots.
6. GLOSSARY Verdict term and one architecture line. DONE: `GLOSSARY.md` line 54 (**Verdict**), `docs/architecture.md` line 395 (table and export).
7. Type-check, lint, full `pnpm check` once before the commit. DONE: final ticket commit a7be54e has a stamped tree.
(Note: a7be54e's message carries "Closes #19", which the worker rules forbid; not part of this triage.)
