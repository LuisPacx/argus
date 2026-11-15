# 03: "Hot now" alert in the War Room, and matching news in the Meta summary
**Model:** sonnet / medium. Plain code on top of the stored Meta ranking, one prompt block and one War Room panel; no new Brain task.

**What to build:** on 2026-11-12 the Meta `jensen` ranked 2nd (256 tokens, 141 creators in 24 h) and nothing told the Operator, and its summary ("a viral concert-jumbotron clip") missed the CEO story because the summary prompt sees only token names and counts. Two changes. (1) A **Hot now** alert: when a Meta enters the top 5 of the Meta ranking, or its distinct creators double within 1 hour, the War Room shows it on the home page with the summary, the matching news (context), the top tokens and the migrations. (2) The Meta summary prompt gets the **matching news** as untrusted context, so a summary can say why the Meta is moving.

**Status:** open

**Blocked by:** warroom-redesign/10 slice c (the War Room edit queue; it is first in the agreed order). Agreed order: warroom-redesign/10 slice c, then **03**, 04, 05, 06, 07. Needs the stored Meta ranking and summaries on `main` (viral-sources/03, done).

Origin: `.scratch/missed-ideas/issues/01-nvidia-ceo-miss-gap-and-fixes.md`, answers Q1, Q2, Q6, Q8 (2026-11-14).

## Decisions already made (do not reopen)

- **Trigger:** a Meta enters the top 5, or its distinct creators go up x2 within 1 h. The trigger is the same one that later starts meme idea generation (ticket 06), so it is a stored event, not only a UI computation.
- **News is context, not a trigger.** RSS and Trends Signals matching the Meta are shown and fed to the summary; they never raise an alert by themselves (Q2). X stays Phase 3 ticket 06 (Q8).
- **War Room only.** No Telegram, Slack or push (Q6).
- The alert shows: the Meta label and summary, the matching news (title, Source, time), the top tokens, and the migrations (unfiltered and after 60 s, as the Meta rows hold them).

## What to build

- A pure function from two stored Meta runs (now and about 1 h ago) to a list of Hot now events, with a reason string each ("entered top 5", "creators 70 to 148 in 1 h"). Thresholds in the Meta config object (`packages/core/src/meta/config.ts`), not literals.
- A stored event per Meta per trigger, with a cool-down (a Meta already hot is not re-raised within 6 h), so ticket 06 can read "which Metas are hot and when" without recomputing.
- Matching news: Signals of the context class (ADR 0011) whose title matches the Meta's subject key (`meta/key.ts`) within the last 24 h, newest first, at most 5. Matching is linear and never builds a RegExp from a token name (worker rules).
- The Meta summary prompt (`packages/core/src/meta/summary.ts`, the `meta-summary` skill) gets the matching news inside a fresh random boundary named as untrusted data, as `meta/prompt-block.ts` does for creator-written text. News headlines are third-party text: they must not end the boundary.
- War Room: a **Hot now** panel on the home page; a Meta row on `/meta` is marked hot while its event is live. All text rendered as text, links only through `safeHttpUrl`.

## Acceptance

Offline in `pnpm check` (fixtures, fake Brain).

- [ ] **Trigger on fixtures.** A Meta moving from rank 9 to rank 4 raises an event; one moving rank 2 to rank 3 does not; creators 40 to 90 inside 1 h raises one, 40 to 70 does not; the same Meta is not raised twice inside the cool-down (tested, reason strings checked).
- [ ] **The 2026-11-12 shape.** A fixture with the `jensen` Meta (rank 7 at 00:00Z, rank 3 at 04:07Z, rank 2 at 14:46Z, creators 28 to 58) raises an event at the rank-3 run at the latest.
- [ ] **News match.** Headlines naming the Meta's subject match; an unrelated headline and a common-word-only match do not; a 10,000-character headline and RegExp metacharacters are handled in linear time with no dynamic RegExp (tested).
- [ ] **Summary prompt.** The prompt contains the matching news in an untrusted boundary; a headline containing `</boundary>` or "ignore previous instructions" cannot end it (tested with a fake Brain that records the prompt). With no matching news the prompt is today's.
- [ ] **War Room shows it.** The home page and `/meta` show the Hot now panel with summary, news, top tokens and migrations; `javascript:` URLs and markup in a token name or headline are not rendered as links or markup (render tests beside `apps/warroom/server/test`). **Browser check** in the Argus Chrome profile (`~/.local/share/argus/chrome`, never the user's own profile), at 1240 px and phone width, from a dev server on a seeded DB copy: a screenshot path in Comments.
- [ ] **No other behaviour changes.** A Meta is still context only: no Narrative, Proposal or Score is created by this ticket (ADR 0012, tested).
- [ ] **Docs.** `docs/architecture.md` Meta section and `/pipeline` graph (`packages/core/src/pipeline-graph.ts`, `pnpm docs:graph`) show the new edge; ADR 0012 gets a dated note that the summary now sees news.
- [ ] Full `pnpm check` passes once before the commit.

## Interplay

- **Ticket 06** (meme idea generation) is triggered by this ticket's stored event and is blocked by it.
- **Ticket 04** (Rubric v3) and **05** (`meme` kind) follow in the agreed order; this ticket needs neither.
- **viral-sources/01** (launchpad clustering) runs in a parallel worktree and is independent.
- **warroom-redesign/10** keeps `/pipeline` in sync with the code (a stale diagram fails its test); slice c lands first.
- Never open the live DB; work from a seeded copy or a `.backup` copy deleted afterwards.

## Commits

One commit after a full `pnpm check`. Subject `Missed ideas ticket 03: <what changed>`, body ending with `Ticket: .scratch/missed-ideas/issues/03-hot-now-alert-and-news-in-meta-summary.md` before the trailers. Tick the boxes in the commit only if the full check does not stamp the tree afterwards, otherwise in a follow-up docs commit. No `Closes #N`: this repo has no GitHub issues.

## Comments
