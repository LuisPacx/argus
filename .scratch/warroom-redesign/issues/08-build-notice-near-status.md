# 08: The Build-not-started notice is visible without scrolling
**Model:** sonnet / medium. It is a small UI change, but its placement and wording need judgment.

**What to build:** on an approved Proposal, put a short "Build blocked" marker at the top of the page, next to the `approved` status badge, so the Operator sees the refusal without scrolling. The full notice stays where it is.

**Status:** open

**Blocked by:** none. Interplay: ticket 07 (Clean up build) edits the same Proposal page on another branch, so start 08 only after 07 is merged.

## Problem (seen 2026-11-12, browser check of ticket 05, Proposal 152)

Ticket 05 shows "Build not started: <reason>, retried every 5 s (last checked N s ago)" on an approved Proposal. But `BuildNotice.vue` renders below the Evidence card at the very bottom of `apps/warroom/app/pages/proposals/[id].vue`, so the Operator has to scroll to find it. The point of 05 was that the reason is seen without hunting for it, and on a long Proposal page it is still hidden.

## What is there today

- `apps/warroom/app/pages/proposals/[id].vue` renders the title card with the `approved` status badge at the top.
- `BuildNotice.vue` is rendered at the bottom of the same page, below the Evidence card.
- The refusal data comes from the Proposal API as `buildRefusal` (`{ code, message, at }` or `null`). It holds only the reason code, a human message that contains paths and names but never a secret, and the time.

## What to build

- When a refusal is stored for an approved Proposal, the title card shows a short marker next to the `approved` badge, for example "Build blocked". The marker links to, or scrolls to, the full `BuildNotice` at the bottom of the page.
- No marker when there is no refusal, and none for any status other than `approved`.
- The marker reads the same `buildRefusal` data as the notice, so it updates live in the same way the notice already does.
- Optional and open: a marker on the Proposals list row. The implementer decides whether to add it and records the decision in the Comments.

## Acceptance

- [x] The marker shows only when a refusal is stored and the Proposal is `approved`; it is absent otherwise.
- [x] The marker updates live, as the existing notice does, when the refusal appears or clears.
- [x] No secret can reach the marker: it uses the same `{ code, message }` data already held in the API payload, which holds paths only. The marker shows a fixed label, not the message text.
- [x] Clicking the marker reaches the full notice at the bottom of the page, and the notice itself is unchanged in place.
- [x] A test covers the render: refusal present shows the marker; refusal absent, or status not `approved`, shows none.
- [x] `pnpm check` passes.
- [ ] Browser check on a `.backup` copy of the DB, as in ticket 05's Comments: the marker appears at the top of Proposal 152's page with no scrolling, the link reaches the notice, and the marker disappears after the refusal clears. Stop the server by PID and delete the DB copy afterwards. Cite it in Comments.
- [x] The Proposals list row marker is either added with a test or recorded as declined in Comments. (Declined, see Comments.)

## Interplay

- **Ticket 07** (Clean up build) edits `proposals/[id].vue` on another branch. Wait for it to merge, then rebase before starting 08.
- **Ticket 05** owns the refusal data and the bottom notice. 08 changes only the title card and does not change what the notice says.
- **Glossary:** say "Build" and "Operator" as the code does. The marker text is "Build blocked", not "sandbox".

## Commits

One commit, after a full `pnpm check`. Subject `War Room ticket 08: the Build-not-started notice is visible without scrolling`, body ending with `Ticket: .scratch/warroom-redesign/issues/08-build-notice-near-status.md` before the trailers. Tick the boxes in the commit only if the full check does not stamp the tree afterwards, otherwise in a follow-up docs commit. No `Closes #N`: this repo has no GitHub issues.

## Comments

- Implemented in 7df3993: new template-only `BuildBlockedMarker.vue` beside `StatusPill` in the title card, fed the same `buildNoticeView` as the notice (so it shows only for approved + refusal, and updates live with the same fetch). Fixed label "Build blocked", an `<a href="#build-notice">`; `BuildNotice.vue` only gained `id="build-notice"`. Tests in `server/test/build-notice.test.ts`. `pnpm check` passed, stamped tree 9f56a96d13.
- Decision: the Proposals list row marker is declined. The list payload carries no refusal data, so a marker would need a new API field and per-row lookup for little gain; the detail page is where the Operator acts.
- Browser check (Proposal 152, `.backup` copy) not done; left for cos.
