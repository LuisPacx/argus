# 08: Record the NVIDIA CEO case as a training case for Phase 3 tickets 07, 08 and 09
**Model:** haiku / low. Docs only: copy facts that already exist in two reports into the places the Phase 3 tickets read.

**What to build:** missed-ideas/01 asks that this case be recorded as a training case. In this project training means a real case plus lessons written into the prompts later (no fine-tuning). Add the NVIDIA CEO case to Phase 3 tickets 07 (cases and cohorts), 08 (lesson aggregation) and 09 (playbook into the prompts) as a named, sourced case with its lesson candidates, so those tickets pick it up when they run.

Status: wontfix

**Blocked by:** none. Can run any time in the agreed order (warroom-redesign/10 slice c, then 03, 04, 05, 06, 07; viral-sources/01 in parallel; this ticket is independent and cheap).

Origin: `.scratch/missed-ideas/issues/01-nvidia-ceo-miss-gap-and-fixes.md`, step 6 and the last acceptance box, which stays pending until this ticket is done.

## What to build

- In `.scratch/phase-3-feedback/issues/07-cases-cohorts-and-study-brain-task.md`, `08-lesson-aggregation-playbook-review.md` and `09-playbook-into-the-prompts.md`: one dated `## Comments` entry each (do not change their Status, acceptance boxes or Model lines) that names the case: **NVIDIA CEO, 2026-11-12, mint `dS222UNvAHpALEuFtK26bfM6Sganp1TZfFVQEiEpump` (NVIDIHIA)**, links `.scratch/missed-ideas/2026-11-12-nvidia-ceo/external.md` and `internal-trace.md` and the gap analysis in missed-ideas/01, and says what that ticket should take from it:
  - **07 (cases):** a **missed** case (argus saw the signals and produced no idea); the outcome bucket is not final until its 7d label; the Study row is `captured`, `in_population=1`; cohort is the launch week of 2026-11-09. It is **not** a Case until the 7d label exists (07's own rule).
  - **08 (lessons):** candidate lessons, to be confirmed by more cases and not written as facts: a named-person story with a token wave is a meme lane, not a buildable web app; the launchpad wave (hours to days) led the news (minutes late) and the mint was a late clone of 21 `nvidih*` tokens; a Meta ranked 2nd was the market's answer.
  - **09 (playbook):** no prompt text yet. Only a pointer: the satire-versus-impersonation rule is already Rubric v3 (missed-ideas/04); do not duplicate it.
- Allegations about the real person are reported only as they are in `external.md`, with its sources; this ticket adds no new claim.

## Acceptance

- [ ] Tickets 07, 08 and 09 of phase-3-feedback each have one dated Comment naming the case with the two report links and the gap-analysis link; nothing else in those files changed (`git diff` read once).
- [ ] The Comments state that the case is not a Case under ticket 07 until its 7d label exists, and that the lessons are candidates.
- [ ] No claim about a real person appears that is not in `external.md`.
- [ ] `.scratch/missed-ideas/issues/01-nvidia-ceo-miss-gap-and-fixes.md`: a one-line Comment says the training record is done, with the commit SHA; its Status may then be set to `resolved` if tickets 03 to 07 are written (they need not be built).
- [ ] No code; `pnpm check` not needed.

## Interplay

- **Ticket 07** (outcome tracking) measures ideas argus makes; this ticket records a case argus missed. They do not share data.
- **Ticket 02** (repeatable intake) will later produce this record automatically for new cases in the same layout.
- Phase 3 tickets 07 to 09 are not changed in scope or order by this ticket.

## Commits

One commit. Subject `Missed ideas ticket 08: <what changed>`, body ending with `Ticket: .scratch/missed-ideas/issues/08-record-nvidia-training-case.md` before the trailers. No `Closes #N`: this repo has no GitHub issues.

## Comments
- 2026-11-21 cos triage: its consumers (phase-3-feedback 07-09) are superseded
