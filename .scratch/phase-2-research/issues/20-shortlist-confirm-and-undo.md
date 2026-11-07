# 20: Confirm before Shortlist, and Undo shortlist
**Model:** sonnet / high — a lifecycle transition with a race, a cancelled brain run, an expiry rule and a modal in the War Room.

**What to build:** The Operator shortlisted a Proposal by accident, which starts a paid Spec brain run (one Sonnet run). Add (1) a confirmation modal before Shortlist and (2) an "Undo shortlist" action that takes the Proposal back to `new`.

**Status:** done

Based on ticket 19's branch (same page, the Proposals list).

## Scope

Operator-approved defaults:

1. **Modal.** Clicking Shortlist (list row and detail page) opens an in-app modal in the War Room's Soft Rows style (ticket 18), never `window.confirm`/`alert`/`prompt`. Text along the lines of "Shortlist <name>? This starts drafting a Spec with the brain (one Sonnet run)." Confirm and Cancel. Esc and a backdrop click cancel. Focus moves into the modal and returns to the opener on close. Motion is Vue built-ins only (`<Transition>`), off under `prefers-reduced-motion`. SSR-safe: nothing touches `document`/`window` outside `onMounted`.
2. **Undo shortlist.** An Operator action on the row and the detail page, available while the Proposal is `shortlisted` or `spec-drafted` (until the Spec is approved). It returns the Proposal to `new`. A Spec run still in flight is cancelled and recorded honestly (`cancelled`, with whatever spend is known). The Spec draft is discarded. It is NOT a Dismissal and records no research feedback. The status history records the Operator's undo.
3. **Expiry.** The 48 h clock of `new` keeps counting from creation, so an undo does not restart it. Today expiry counts from the latest transition into the current status (`status_history.at`), which would restart it on undo; `new` is therefore counted from the Proposal's creation. Consequence to report: a Proposal undone after more than 48 h since creation is closed by the next worker tick.
4. **Race safety.** An undo that lands while the Spec run completes never ends with an un-shortlisted Proposal flipped to `spec-drafted`: the status checks happen inside one write transaction.

No migration, no new dependency, no `nuxt.config` change. The worker process must be restarted (it applies the command and owns the Spec run).

## Acceptance criteria

- [x] Shortlist (row and detail page) opens a modal naming the Proposal and the cost ("one Sonnet run"), with Confirm and Cancel; nothing is queued until Confirm. Esc and the backdrop cancel; focus moves in and returns; no `window.confirm`/`alert`/`prompt`.
- [x] Modal motion uses Vue built-ins only and is disabled under `prefers-reduced-motion`; all DOM access is in `onMounted` or event handlers.
- [x] New command `undo-shortlist` (`POST /api/proposals/:id/commands`), no reason needed. New transitions `shortlisted -> new` and `spec-drafted -> new`, actor `operator`, default reason "Operator undid the shortlist".
- [x] Undo from `shortlisted` or `spec-drafted` returns the Proposal to `new`, clears the Spec fields (path, hash, error, retry time, attempts, queued revision) and removes `spec.md`. It is refused (rejected command, with the reason) from any other status except `new`, where it is a no-op (double-click).
- [x] Undo is not a Dismissal: status is `new`, not `dismissed`, and no research feedback is recorded.
- [x] The history shows `shortlisted -> new` (or `spec-drafted -> new`) by `operator`.
- [x] Undo while a Spec draft (or Spec revise) is in flight aborts the run through the worker's per-Proposal abort; the brain run row ends `cancelled` with the cost and session the killed run reported (0 when none); the Proposal is not given a `spec_error`, no `spec.md` is written, and it is not re-drafted.
- [x] The worker applies commands while a Spec run is in flight (a command loop beside the tick), so the cancel is not queued behind the run it cancels.
- [x] Race tests: the run completing right after an undo leaves the Proposal `new` with no `spec.md`; a Spec draft whose transition loses the race removes the file it wrote.
- [x] Expiry: after an undo the `new` Proposal expires 48 h after creation, not after the undo (`expiresAt` and `expireStaleProposals`).
- [x] The Undo button shows on the list row and the detail page while `shortlisted` or `spec-drafted`, with no modal.
- [x] `GLOSSARY.md` (Proposal status: who sets what) and `docs/architecture.md` section 3 (state diagram and transition table) show the undo.
- [x] `pnpm check` passes.

## Comments

- The detail page (`/proposals/:id`) had no Shortlist button before; it now has a Shortlist section for a `new` Proposal (with the modal) and an Undo section while shortlisted or spec-drafted.
- Spec runs execute in the worker process, not the War Room. Undo aborts the run through `RunCancels` (one abort per Proposal); the worker therefore needs a restart to pick this up. No migration (the command type is free text), no dependency, no `nuxt.config` change.
- No component-test infrastructure exists for the War Room (server tests only); the modal was checked by `vue-tsc`, SSR renders of `/` and `/proposals/:id` (200, modal absent when closed) and the endpoint tests. The click behaviour (Esc, backdrop, focus return) has not been exercised in a browser.
- Expiry consequence of "counts from creation": a Proposal undone more than 48 h after it was created is closed (`stale`) by the next worker tick.
