# 05: The `meme` Proposal kind: ADR and GLOSSARY (docs), replacing the planned `beta` kind
**Model:** sonnet / medium. Documentation only: one ADR, GLOSSARY edits and the supersede marks. No code.

**What to build:** write the decision that a Proposal has a **kind**, and that the second kind is `meme`: an idea for a token that rides a live Meta, generated from the Meta (ticket 06), not from a Narrative. It **replaces** the `beta` kind that viral-sources/04 slices 3 and 4 planned. The ADR and the GLOSSARY come first, so tickets 06 and 07 build against a written contract.

Status: done

**Blocked by:** none technically. Agreed order: warroom-redesign/10 slice c, then 03, 04, **05**, 06, 07. 05 is needed by 06.

Origin: `.scratch/missed-ideas/issues/01-nvidia-ceo-miss-gap-and-fixes.md`, answers Q5, Q9, Q11 and Q14 (2026-11-14).

## Decisions already made (do not reopen)

- **A Proposal has a `kind`:** `narrative` (today's) or `meme`. Old Proposals read `narrative`. `beta` is never built; viral-sources/04 slices 3 and 4 are superseded. The Beta term in GLOSSARY stays (it is still the name of the launch idea), but the **Beta Proposal** entry that 04 planned is not added.
- **A `meme` Proposal pairs a Meta with an idea**, not a Narrative and not a Tech. Fields (Q14): name, ticker, angle (the joke and why now), how it differs from the leader (name copies are rejected), a short description, an X first-post hook, an image idea as text, risk labels (for example "real person"), evidence links (the Meta's top tokens and the matching news). No image or logo generation.
- **Lifecycle (Q9):** Shortlist, Dismiss with a reason, and Why. **No Spec, no Build, no Rubric score of its own.** It expires after 6 h in `new` unless shortlisted. It appears as a list filter on Proposals and under each Meta on `/meta`.
- **It overrides the 11-11 decision** that a `meme` kind is Phase 4 and waits for a replicated lesson (Q5): the idea generation is measured from the start (ticket 07) instead.
- ADR 0002 stands: argus never launches, signs or spends. ADR 0012 stands: a Meta stays context; the `meme` kind is a Proposal that cites a Meta, it does not make a Meta into a Narrative or a Score.
- The room-left ranking from viral-sources/04 slices 1 and 2 (`packages/core/src/beta/`) is an input to idea generation and the distinct-name rule is its name-copy check; neither is deleted.

## What to build

- **ADR** (next free number at write time; check `docs/adr/`: 0010 is reserved by hardening ticket 06, 0011 and 0012 exist; the next is 0013 unless something lands first): "A Proposal has a kind: `narrative` or `meme`". It records the `proposals.kind` column, the pairing with a Meta (a Meta label and an immutable Meta snapshot as stored at generation), the fields, the 6 h life and the skipped Spec, Build and Rubric, what it replaces (`beta`, with the 11-11 decision and the backtest result of viral-sources/04 that showed no lift), what it contradicts (the GLOSSARY Proposal definition) and what it leaves alone (ADR 0002, ADR 0012).
- **GLOSSARY.md:** amend **Proposal** ("a Narrative, or for a `meme` a Meta, paired with ..."); add **Meme Proposal** (a Proposal of kind `meme`); add **Hot now** (a Meta that entered the top 5 or doubled its distinct creators within 1 h; ticket 03); in **Beta**, a one-line pointer that the Proposal kind for it is `meme`. Keep to the existing entry style including the `_Avoid_` lines (avoid "idea" as a bare noun for the Proposal).
- **viral-sources/04-beta-finder.md:** the dated note is written in the same commit as this work's parent (see `.scratch/missed-ideas/issues/01-nvidia-ceo-miss-gap-and-fixes.md`); here only check that its Status and last Comment point to this ticket.
- `docs/architecture.md`: one paragraph and the Proposal kind in the data model, with the `meme` lifecycle.

## Acceptance

- [x] ADR written with the number it was given, status accepted with the date, and it states what it replaces, contradicts and leaves alone (reads as above).
- [x] GLOSSARY: Proposal amended, Meme Proposal and Hot now added, Beta pointer added; no entry contradicts another (read through once).
- [x] viral-sources/04: Status line and last Comment say slices 3 and 4 are superseded by 05 and 06 and the 2026-11-18 re-run still runs (checked, edited only if missing).
- [x] `docs/architecture.md` describes the kind and the `meme` lifecycle; ADR and architecture agree on the 6 h life and "no Spec, no Build, no Rubric".
- [x] A reviewer (`reviewer` agent) read ADR, GLOSSARY and architecture side by side and found no contradiction with ADR 0002, 0011 or 0012; recorded in Comments.
- [x] `pnpm check` passes if any non-doc file changed; for a docs-only commit say so in Comments and run `pnpm check:fast`.

## Interplay

- **Ticket 06** (meme idea generation) is blocked by this ticket and by 03 and builds the column, migration, task and UI the ADR describes. **Ticket 07** (outcome tracking) follows 06.
- **Ticket 04** (Rubric v3) sets the legitimacy rule the ADR cites for risk labels.
- **viral-sources/04** slices 3 and 4 stay unbuilt; its slices 1, 2 and 5 are done and stay.
- Do not write code, a migration or a switch in this ticket.

## Commits

One commit. Subject `Missed ideas ticket 05: <what changed>`, body ending with `Ticket: .scratch/missed-ideas/issues/05-meme-proposal-kind-adr-and-glossary.md` before the trailers. No `Closes #N`: this repo has no GitHub issues.

## Comments

### 2026-11-15, worker (docs only)

- ADR 0013 "A Proposal has a kind: `narrative` or `meme`" (0010 is reserved, so 0013). GLOSSARY: Proposal amended, Meme Proposal added, Beta pointer, Proposal status exceptions (6 h, never spec-drafted). Hot now was already added by ticket 03 and reads consistently with the new entries.
- viral-sources/04: Status and last Comment already said slices 3 and 4 are superseded and the 2026-11-18 re-run still runs. Only a dead link filename was corrected.
- Reviewer (`reviewer` agent) read ADR, GLOSSARY and architecture side by side: no contradiction with ADR 0002, 0011, 0012. It raised six small points, all fixed except one: the "Beta finder" nodes sit in the generated overview block (from `packages/core/src/pipeline-graph.ts`, code); architecture.md says so in words and ticket 06 should relabel them.
- Docs only, so no `pnpm check`; ran `packages/core/src/pipeline-docs.test.ts` (7 passed) instead.
- 2026-11-21 cos triage: fixes landed (ADR 0013, Rubric v3, meme kind, Meta meme ideas behind ARGUS_MEME_IDEAS)
