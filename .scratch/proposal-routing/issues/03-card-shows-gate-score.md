# 03: War Room: a Proposal card shows the Score it was created from, and "now: X" when the Narrative has a newer one
**Model:** sonnet / medium. One new read in the War Room API plus a small render change in two known pages, no data model change (the `scoreId` is already stored); the check is `pnpm page:check`.

**What to build:** a Proposal card and its detail page show the Score that was current when the propose pass created it, not only the Narrative's latest. When the latest Score differs, add a "now: X" line so the reader sees both. Today a Proposal can look like it broke the buildability gate: Proposal 155 was created from Score 930 (buildability 5, gate 5.0) at 11:07:21, then the Narrative was judged again, Score 931 (buildability 4) at 12:07, and the card shows 931, so buildability 4 sits next to a Proposal that "should not exist". It was not a bug (the pass re-checks the gate at creation, `packages/core/src/propose.ts:519-522`); the card hid the Score that decided it. Decided by the user (GRILL R1 USER, Q3 (a), 2026-11-15, `.scratch/cos.md`). Buildability is noisy: 1, 5, 4 across three judgements in 90 minutes.

Status: done
Status note: done (see Comments)

**Blocked by:** none.

## What is there today (read 2026-11-15)

- The pass stores the gate-time Score as `scoreId` (`propose.ts:521`, `scoreId: latest.id`, where `latest = store.latestScore(narrative.id)` at `:519`); `Proposal.scoreId` is typed at `packages/core/src/datastore.ts:106` with the comment "the card shows the Narrative's latest".
- The API never uses it: `withScore` (`apps/warroom/server/utils/score.ts:7`) returns `{ ...p, score: store.latestScore(p.narrativeId) }`, and GLOSSARY says a Proposal carries its Narrative's latest Score. Both `server/api/proposals/index.get.ts:3` and `[id].get.ts:5` call it.
- `Datastore.latestScore` (`datastore.ts:1562`) is the only Score read by Narrative; there is no read by Score id.
- Render: the list card shows `p.score` as a pill and `ScoreBars` (`app/pages/index.vue:279-281`); the detail page shows the total pill (`app/pages/proposals/[id].vue:170`) and builds the Why panel from `p.score` (`:28`, `whyView`). `ScoreBars.vue:4` takes `scores: Record<string, number>`.
- Existing tests that create Proposals with a `scoreId`: `server/test/proposals-list.test.ts:46`, `server/test/routes.test.ts:159`, `why-panel.test.ts`, `narratives.test.ts`.
- Evidence: Proposal 155 (Narrative 4879), Score 930 buildability 5 at 11:07:08, Proposal at 11:07:21, Score 931 buildability 4 at 12:07, Score 929 buildability 1 at 10:37 (`.scratch/cos.md`, GRILL FACTS).

## Approach (a default; say if you want it changed)

1. **Store read.** A `WarRoomStore` read of a Score by id (the pass already writes `scoreId`, so the row exists), returning `undefined` when the id is null or gone.
2. **API shape.** `withScore` returns `score` as the gate-time Score (the one `scoreId` points to) and `latestScore` as the Narrative's latest, only when that latest has a different id. Meaning: `score` is what the Proposal was created from; `latestScore` is present only when the Narrative has been judged again since. A hand-entered Proposal or a null `scoreId` falls back to today's behaviour (latest as `score`, no `latestScore`). Keep the field name `score` for the main one so list sorting by Score, the Why panel and other readers keep working; check what the Score sort uses (`ProposalSort` "score", `datastore.ts:115`) and keep it as it is unless it reads the same Score the card now shows differently.
3. **Render.** List card and detail page show the gate-time `score` as today (pill and bars) and, when `latestScore` is present and its total or any dimension differs, one small muted line "now: 6.1/10, buildability 4" (the total and the dimensions that changed, not all of them), in the existing Soft Cards style, no new colours. The label on the main Score says it is the creation Score, e.g. a `title` or a faint "at proposal" caption. Phone width 390 px must not overflow.
4. **GLOSSARY.** The Proposal line no longer says the card carries the latest Score only; one clause: the card shows the Score it was created from and, when newer, the latest.

## Acceptance criteria

- [x] `WarRoomStore` can read a Score by id; test for a stored id, a null id and an id with no row.
- [x] `GET /api/proposals` and `GET /api/proposals/:id` return `score` as the Score the Proposal was created from and `latestScore` only when the Narrative has a later Score; tests in the War Room API: one Proposal with no newer Score (no `latestScore`), one with a newer Score (both present, ids differ), a Proposal with null `scoreId` and a hand-entered one (fall back to today's), and the list `sort=score` order unchanged or consciously updated with a test.
- [x] Render tests: with `latestScore` the card and detail page show the creation Score and a "now:" line naming the newer total and the changed dimension(s); without it, no "now:" line. A reproduction of 155 (buildability 5 then 4) shows 5 as the main Score and "now: ... buildability 4".
- [x] The Why panel and everything else that reads `p.score` still works (existing tests pass; the Why panel uses the creation Score, which is what the Proposal was judged on; say so in a Comment).
- [x] `pnpm page:check /` and `pnpm page:check /proposals/<id>` against a War Room on a copy of the data (a Proposal with a newer Score): exit 0, no overflow at 390 or 1240 px, no console, page or request errors; screenshots of both looked at and noted in Comments.
- [x] GLOSSARY.md Proposal line updated.
- [x] Type-check and the full test suite pass.

## Constraints

- Read-only change for existing data: no migration, no stored-Score rewrite, `scoreId` already exists.
- Soft Cards / Soft Rows style (`.scratch/warroom-redesign/figma/README.md`): no new colours or components beyond one muted line.
- Follow `docs/agents/worker-rules.md` and `CODING_STANDARDS.md`. Commit subject `Phase N ticket 03: <what changed>`, body ends with `Ticket: .scratch/proposal-routing/issues/03-card-shows-gate-score.md` before the trailers. No `Closes #N`: this repo has no GitHub issues.

## Open questions

1. **Which Score should the list sort and the Why panel use?** Default: the creation Score for both (it is what the Proposal was judged on). If you prefer the latest for sorting (fresher), say so; the card would still show both.

## Comments

- **Done (implementation).** `Datastore.getScore(id)` (in `WarRoomStore`); `withScore` returns `score` = creation Score and `latestScore` only when the latest id differs (null or dangling `scoreId` falls back to latest as `score`); `ScoreNow.vue` + `utils/score-now.ts` draw "now: 3.4/10, buildability 4" (changed total and dimensions only) on the list card and detail page; the pill has a title "The Score this Proposal was created from". Tests: `apps/warroom/server/test/score-now.test.ts` (store read by id/null/missing, API with and without a newer Score, null/dangling scoreId and hand-entered, sort, 155 reproduction, render with and without "now:"); `research.test.ts` and `proposals-list.test.ts` updated.
- **Open question 1 answered with the default:** the Why panel and the `sort=score` order use the creation Score (the sort SQL joins `COALESCE(score_id row, latest)`), so a later re-score no longer moves a Proposal in the list; `proposals-list.test.ts` seed changed so Alpha was created from its 9.
- **page:check** against a War Room (port 3217) on a `.backup` copy of `.data/argus.db`: `/proposals/155` exit 0 and `/` exit 0, 0 console/page/request errors. 155 shows main 4.8/10 (Score 930, buildability 5) and "now: 3.4/10, momentum 5, buildability 4, hook 2, legitimacy 4" (Score 931). The detail page had a pre-existing 390 px overflow (486 px: the unbroken mint in the Narrative summary, also on the live :3100 page); fixed with `[overflow-wrap:anywhere]` on that paragraph, then no overflow. Screenshots looked at: list at 390 shows the line under the bars on re-scored cards and no line on others; detail at 390 shows it under the pill.

- **Decision (user, 2026-11-15, GRILL R1 USER Q3 (a)):** the card shows the gate-time Score and "now: X" when the Narrative's latest Score differs.
- **Not a bug:** Proposal 155's buildability 4 is the later Score; at creation it was 5 and the gate re-check (`propose.ts:519-522`) passed (`.scratch/cos.md`, GRILL FACTS).
