# 17: Proposal Tech value and reason
**Model:** sonnet / medium — prompt, validator, one column, one Rubric version.

**What to build:** Proposals today are mostly feed viewers (about 38 of 60 read by hand). The propose skill and prompt now require the Tech to have an interaction or a reason to come back and forbid "fetch a feed or API and display it" (RSS reader, tracker, timeline, scoreboard, countdown, dashboard). Propose outputs a required one-line `reason` (why this Proposal: which Signals or Narrative, why this Tech), stored on the Proposal. A cheap validator refuses display-only Techs and uses ticket 21's repair retry. The Rubric gains a Tech-value line as a new Rubric version, shipped by migration, never by writing to the live DB by hand.
Source: `.scratch/phase-3-feedback/research/proposal-quality-2026-11-11.md` (findings 1-3, recommendation A). B (a "Why this Proposal" panel) and C (migrated-token examples in the propose prompt) build on this; the `reason` field and the prompt's rule sections stay easy to extend.

**Blocked by:** none

**Status:** deployed 2026-11-11 (main 1270357); boxes without recorded evidence stay open (see Comments)

- [ ] `propose` SKILL.md and the propose prompt state the Tech-value rule and the required `reason` key (tested: the prompt contains both; the SKILL.md example still parses)
- [ ] `parseProposeOutput` requires `reason` (one line, at most 300 characters) and refuses a missing, empty, over-long or control-character `reason` (tested)
- [ ] The validator refuses a `tech` that names a feed/tracker/timeline/scoreboard/countdown/dashboard form with no interaction word, and accepts one with an interaction (tested); literal regexes only
- [ ] Revised after review: the model also outputs a required `interaction` (one line, at most 200 characters: what the visitor does), stored in `proposals.interaction`; the validator refuses an `interaction` with no user-action verb (click, pick, guess, vote, type, drag, play, submit ...), saying display-only when `tech` also names a feed/board/tracker/ticker/heatmap/radar/stream/wall/list form. `tech` words alone never refuse (tested with the reviewer's bypass and false-positive strings)
- [ ] A display-only refusal gets the ticket 21 repair retry once, under the same caps; a still display-only repair is refused and nothing is stored (tested)
- [x] `proposals.reason` column added by the repo's idempotent `ensureColumn` pattern; `reason` round-trips from propose output through `createResearchProposal` to `getProposal`; hand-entered Proposals and old rows read `""` (tested)
- [ ] A new Rubric version adds a Tech-value line to `hook` (weights, gate and other dimensions kept, old versions untouched), applied by `migrateRubric` once per database and never again after any version carries the line; a fresh database seeds the line in version 1 (tested)
- [ ] No write to `.data/argus.db` by hand; tests use their own DB
- [x] `pnpm check` passes

## Comments

Ticked on deploy 2026-11-11 (`.scratch/cos.md`):
- `proposals.reason` column / old rows read `""` / round-trip: "MIGRATION REHEARSAL" (proposals + `reason`, `interaction`, old proposals read "" for both) and "MIGRATION REHEARSAL 2" (idempotent), "RESTARTED 20:45-03" (reason/interaction confirmed), "DEPLOYED" (Chrome: /proposals/148 shows reason + interaction).
- `pnpm check` passes: DEPLOY STACK entry (this level 93/1564, stamp 2010b175c4), "STACK TIP VERIFIED" (95/1597, stamp ddc24d7322), "TIP VERIFIED" (112/1790, stamp c8bb0d433e).

Left open (no evidence recorded in the journal for these):
- Prompt/SKILL.md states rule and `reason` key; `parseProposeOutput` reason validation; display-only validator; `interaction` validator; repair retry. Only the overall green checks cover them, with no per-test record.
- New Rubric version: the rehearsals record Rubric v2 (hook + Tech-value line) added once, no v3 on second open, but no record of the fresh-database seed in version 1.
- "No write to `.data/argus.db` by hand": not ticked. The rehearsals used `.backup` copies, but the deploy deleted proposals from the live DB by hand (user-approved reset).
