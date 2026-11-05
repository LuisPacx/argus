# 11: Retry Spec draft from the War Room
**Model:** sonnet / medium — one command and a card action over existing seams.

**What to build:** Spec drafting (ticket 04) does not auto-retry failed, invalid-output, or capped rate-limited drafts; the Proposal stays `shortlisted` with `spec_error` shown on the card. The Operator clicks "Retry Spec" on that card. It goes through the ticket 03 command channel; the worker clears `spec_error` and `spec_attempts` and drafts again on the next tick. Each retry is a new `brain_runs` row with its own cost, and the card's agent cost includes all of them.

**Blocked by:** 04

**Status:** open

Note: closely related to ticket 05 (Spec editor and approve); may be merged into it if done together.

- [ ] War Room card with `spec_error` shows a "Retry Spec" action
- [ ] Retry is a command through the ticket 03 command channel; the worker clears `spec_error` and `spec_attempts` and drafts again on the next tick
- [ ] Retry is refused while a brain run is in flight for that Proposal
- [ ] Every retry is a new `brain_runs` row with its own cost; the card's agent cost includes all of them
- [ ] Tests cover retry after failed, after invalid-output, and refusal while in flight
