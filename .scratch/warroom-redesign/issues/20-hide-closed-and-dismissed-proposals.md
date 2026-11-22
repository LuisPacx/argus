# 20: Hide closed and dismissed Proposals by default
**Model:** sonnet / effort: medium. A pure filter util, one toggle link component, small edits on the home list and the Narrative page's Proposal block, seed rows.

**Status:** open

**Blocked by:** none.

## Problem

The War Room lists of Proposals show every status. `closed` (expired or finished) and `dismissed` Proposals are no longer actionable and crowd out the live ones. The Operator wants them hidden by default, with a visible toggle to show them.

## Decisions

1. **Where.** Every list of Proposals: the home page `/` (the Proposals list; there is no `/proposals` list page, `/proposals/<id>` is a single Proposal) and the "Proposals from this Narrative" block on `/narratives/<id>`.
2. **Default view** leaves out `closed` and `dismissed`. A link-button "Show closed and dismissed (N)" (N = how many the current filters hide) turns them on; when on it reads "Hide closed and dismissed (N)". The choice is the URL query `closed=1` (default left out), so it survives reload and is shareable. The toggle is a link, so it works with the keyboard (Enter) and without JavaScript.
3. **Explicit status filter wins.** With `status=closed` or `status=dismissed` picked in the Status select, those rows show and no toggle is offered (nothing to hide).
4. **Counts match the list.** The "N Proposals, N new, N meme" line counts the rows shown. The toggle carries the hidden count.
5. **Direct links** to `/proposals/<id>` of a closed or dismissed Proposal are unchanged.
6. **API unchanged.** `/api/proposals` still returns every status (the worker and other callers share it); the page splits the list.
7. **Seed.** `pnpm page:check --seed` data gets one closed and one dismissed Proposal.

## Acceptance

- [ ] Unit tests of the split (`apps/warroom/server/test/proposal-visibility.test.ts`): default hides closed and dismissed and counts them; `showHidden` shows all; an explicit closed/dismissed status filter shows them and reports 0 hidden; the toggle label and URL for each state; they fail without the change.
- [ ] Render test of the toggle component: link with the count, `aria` state, the "Hide" text when on, absent when nothing is hidden; the home page and Narrative block use it.
- [ ] Seed data has a closed and a dismissed Proposal (seed test counts updated).
- [ ] Browser (`pnpm page:check --seed` on `/`, `/?closed=1`, and a `--keys "focus=[data-test=show-closed],Enter"` run): exit 0, the default screenshot omits the two, the toggled one shows them.
- [ ] Type-check, lint and one full `pnpm check` pass before the commit.

## Constraints

- Keep edits in `pages/index.vue` and `pages/proposals/[id].vue` minimal (War Room ticket 02 edits both). `proposals/[id].vue` needs none.
- Follow `docs/agents/worker-rules.md`. Commit subject `War Room ticket 20: hide closed and dismissed Proposals by default`.
