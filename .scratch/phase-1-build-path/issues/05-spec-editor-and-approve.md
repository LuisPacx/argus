# 05: Spec editor and approve
**Model:** sonnet / medium — UI plus one resume call over existing seams.

**What to build:** The Operator opens a `spec-drafted` Proposal, edits the Spec in a textarea and saves it. They can "ask the agent to revise" with an instruction, which resumes the Spec session (`--resume <session_id>`) and updates `spec.md`. Then Approve calls `approve()` and the Proposal becomes `approved`, queued for its Build.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] Textarea loads and saves `spec.md`; the stored hash updates on save; saving over a version changed underneath is refused with a message
- [ ] Revise is sent as a command; the worker resumes the Spec session through the Brain; the new `spec.md` and the run's cost are recorded; revise uses the same caps and dry-run as ticket 04
- [ ] Approve is enabled only in `spec-drafted`, goes through `approve()`, and records the approval time (the FIFO key for ticket 07)
- [ ] Tests cover save, hash conflict and approve; `pnpm check` passes
