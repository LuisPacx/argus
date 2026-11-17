# 19: The Operator records a verdict on a Narrative in the War Room
**Model:** sonnet / effort: medium. One additive table, one POST, one GET export, a form and a pill on two pages, a link block; the pattern is the Proposal command route and `meme-angle`. No judge, prompt or Rubric change.

**Status:** done

**Blocked by:** none.

## Problem

The Operator can decide on Proposals (`apps/warroom/server/api/proposals/[id]/commands.post.ts`, `commands` and `status_history`) but not on Narratives: `narratives/[id].vue` and `narratives/index.vue` are read-only. He wants to (a) do a manual quality review of Narratives, and (b) build a dataset to check the judge against his calls over time. Also, a Narrative page does not link to the Proposal(s) made from it.

## Decisions (cos defaults; listed under Open questions so the user can change them)

1. **Verdict.** On `/narratives/<id>`: `good` or `bad`, plus optional reason tags: `wrong-cluster` (the Signals are not one story), `duplicate` (of another Narrative), `score-too-high`, `score-too-low`. For the two score tags the Operator also picks one or more Rubric dimensions (`RUBRIC_KEYS`: momentum, novelty, buildability, hook, legitimacy). Optional free-text note, trimmed, at most 500 characters. Tags are allowed with `good` too (for example "good, but score too low").
2. **History, not overwrite.** A new verdict supersedes the previous one; every verdict is kept (append-only). The current verdict is the newest row. Each row stores the Score id (judge run) and Rubric version that were the Narrative's latest when it was made, so it compares with that exact score later. A Narrative that has no Score yet can still get a verdict (score id and version null).
3. **List.** `/narratives` gets a "Verdict: Any / Good / Bad / None" filter (None = no verdict yet) and a small pill on each row showing the current verdict.
4. **Export.** `GET /api/narratives/verdicts` returns JSON: for every verdict row, the Narrative id and title, verdict, tags, dimensions, note, time, the Score it was made against (id, Rubric version, per-dimension scores, total, rationale) and the Narrative's latest Score now, with a flag `scoreChanged`. Read-only; no query-driven writes. No AI or judge changes in this ticket.
5. **Proposal links.** The Narrative page lists the Proposal(s) made from it (id, name or ticker, kind, status) as links to `/proposals/<id>`.
6. **Where it is written.** New table `narrative_verdicts` (`id`, `narrative_id`, `verdict`, `tags` JSON, `dimensions` JSON, `note`, `score_id` NULL, `rubric_version` NULL, `created_at`), idempotent `CREATE TABLE IF NOT EXISTS`, indexed on `(narrative_id, id)`. The War Room's allowed Datastore view gets insert-only `addNarrativeVerdict` (the way `enqueueCommand` and `requestMemeAngle` are); it writes no Proposal or Narrative state. Validation on the server in `apps/warroom/server/api/narratives/[id]/verdict.post.ts`, in the style of the Proposal command route: 404 unknown Narrative, 400 unknown verdict, unknown tag or dimension, dimensions without a score tag, wrong types, note over 500 characters (message names the limit, as `MAX_REVISE_INSTRUCTION_CHARS` does; add a `MAX_VERDICT_NOTE_CHARS` constant in core). The score id and Rubric version come from the store, never from the body.
7. **UI.** Follow the existing components and the `Proposals` command panel look; text only, no `v-html`, the note clamped in the view.

## Acceptance

- [ ] **Store** (real Datastore on a temp dir): a verdict is stored with the latest Score id and Rubric version; a second verdict keeps both rows and becomes the current one; a Narrative with no Score stores null score id and version; the schema is idempotent on a second open and an old DB without the table opens; the War Room view can insert but not edit or delete (type test).
- [ ] **API** (`apps/warroom/server/test/narrative-verdict.test.ts`): a good body returns 200 and a row; 404 unknown Narrative; 400 for unknown verdict, tag or dimension, dimensions without a score tag, wrong types, extra keys, a 501-character note, non-JSON body; nothing stored on any 400/404; a body that tries to set `scoreId` or `rubricVersion` has no effect; no Proposal or Narrative row changes.
- [ ] **Export**: GET returns every verdict with the Score at the time and the latest Score, `scoreChanged` true when a newer Score exists; empty array with no verdicts; a POST to it is 405; nothing is written.
- [ ] **Render** (`renderToString`): the form shows verdict buttons, tags, dimensions only when a score tag is on, a 500-character counter and the current verdict plus its history; a note with `<img src=x onerror=1>` shows as escaped text; the list shows the filter and the pill and filtering by Good/Bad/None returns the right rows; the page links its Proposals (none: no block); no `v-html` in new code (the repo's grep test).
- [ ] **Browser** (`pnpm page:check` on `/narratives` and `/narratives/{id}`, `--seed` if live cards are empty and say so; add a keyboard run `--keys "focus=<selector>,Enter,Escape"` for the form toggle if it is a `<details>`): exit 0, no console, page or request errors, no overflow at 390 or 1240 px, screenshots read for the form, the pill, the filter and the Proposal links. The script blocks POST, so submit is tested by the API and render boxes.
- [ ] `GLOSSARY.md` gets a **Verdict** term (the Operator's call on a Narrative, kept as history, used to calibrate the judge); `docs/architecture.md` gets one line for the table and the export.
- [ ] Type-check (`tsc --noEmit --checkers 1`), lint and the full `pnpm check` pass once before the commit.

## Constraints

- No judge, prompt, Rubric or scoring change, and no automatic use of verdicts by any agent; the export only reads.
- The War Room writes only the verdict row (CODING_STANDARDS rule 1); argus still never launches, signs or spends (ADR 0002).
- Out of scope: the pre-existing lack of CSRF protection on War Room POSTs (the War Room is localhost-only); this route is no worse than the others and is not fixed here.
- Follow `docs/agents/worker-rules.md`. Commit subject `War Room ticket 19: Operator verdict on Narratives`, body ends with `Ticket: .scratch/warroom-redesign/issues/19-operator-verdict-on-narratives.md` before the trailers.

## Open questions for the user

Defaults above stand unless changed. Decided by user 11-17: all defaults accepted (questions 1 to 7 as written). He also confirmed that a launchpad Narrative (never judged) may get a verdict, with null score id and Rubric version.

1. Verdict is good or bad with the four tags, score-tag dimensions, and an optional 500-character note?
2. A new verdict replaces the old one for display, history kept, stored with the Score id and Rubric version current at the time?
3. List filter "Any / Good / Bad / None" and a small pill?
4. Read-only JSON export of verdicts joined with scores, and no judge changes now?
5. Narrative page links to its Proposal(s), in this ticket?
6. Validation like the Proposal command route; UI like existing components; `pnpm page:check` on the changed pages?
7. CSRF on War Room POSTs stays out of scope?
