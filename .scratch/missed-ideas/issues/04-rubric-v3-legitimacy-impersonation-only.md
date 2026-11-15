# 04: Rubric v3: legitimacy penalises impersonation and fraud only; satire is allowed
**Model:** sonnet / medium. A prompt and Rubric version change plus the version plumbing; the judgment is already decided, the work is the wording and the proof that old scores stay as history.

**What to build:** the Rubric's legitimacy dimension scored both Nvidia-related Narratives down because the idea rests on "unverified allegations about a named real person" (Scores 401, 466, 476, 528, 593, 895 in `internal-trace.md`), and Narrative 662 got legitimacy 1 for a "meme token impersonating a real person". The Operator's rule (Q4, Q7): memes and satire about public figures are normal comedy and are surfaced; only **impersonation** (a token or account that pretends to be the person, uses their name as an endorsement, or claims to be official) and **fraud** (a false claim meant to take money) lower legitimacy. Ship that as Rubric v3, used by the judge and by meme ideas (ticket 06).

**Status:** open

**Blocked by:** none technically. Agreed order: warroom-redesign/10 slice c, then 03, **04**, 05, 06, 07; start it after 03 so the two do not edit the judge prompt at once.

Origin: `.scratch/missed-ideas/issues/01-nvidia-ceo-miss-gap-and-fixes.md`, answers Q4 and Q7 (2026-11-14).

## Decisions already made (do not reopen)

- **New scores only.** Existing Scores keep the Rubric version they were written under and are not re-judged or rewritten. Scores belong to a Narrative id and a Rubric version, so a Narrative judged under v2 is judged fresh under v3 only when it next qualifies for a re-judge.
- Legitimacy penalises: impersonation of a real person, brand or project; fraud, scams, rug-pull framing; a Tech that pretends to be official. It does **not** penalise: satire, parody or comedy about a public figure or event; a token named after a person as a joke that does not claim to be them; news-based memes.
- Risk is still shown, not hidden: a Proposal about a real person carries the label "real person" (the meme idea field in ticket 06; for a Narrative Proposal the existing reason text).
- The Rubric's gate (`gate_min_score` 5.0 on buildability) is not changed here. Buildability for a "buildable web app" stays as it is; the meme lane (tickets 05 and 06) is how a named-person story gets an idea.

## What to build

- Rubric v3: the legitimacy dimension's wording and anchors (what scores low, what does not, with the Nvidia and Jensen cases as worked examples that are not copied into the prompt as names), registered next to v1 and v2 where `rubric_versions` is written (`packages/core/src/`, find by `rubric_versions`). The version is stored with every new Score.
- The judge skill and prompt (`judge` SKILL.md and `packages/core/src/judge.ts`) use the v3 text; v2 text stays addressable so a replay under v2 is reproducible.
- The meme idea task (ticket 06) reads the same legitimacy text from the Rubric, not a copy.

## Acceptance

Offline in `pnpm check` (fake Brain).

- [ ] **v3 registered.** `rubric_versions` gains v3; new Scores carry v3; the idempotent migration or seed is rehearsed on a `.backup` copy (deleted afterwards), and v1 and v2 rows are unchanged (tested).
- [ ] **Old scores are history.** A DB with Scores under v2 keeps them byte for byte after the change; no Narrative is re-judged because of the version alone (tested).
- [ ] **Prompt text.** The v3 judge prompt contains the impersonation-and-fraud rule and the satire allowance and no longer lists "unverified allegations about a named real person" as a legitimacy penalty (tested by reading the built prompt).
- [ ] **Fixtures.** With a fake Brain that echoes the rule it was given, three fixture Narratives (a satire token about a CEO, a token claiming to be that CEO's official coin, a fake giveaway) are sent with the v3 prompt; the prompt for the second and third names the penalty and the prompt for the first does not (tested on the prompt, not on a model's score).
- [ ] **Opt-in measurement.** An opt-in script (not part of `pnpm check`) re-judges the stored 662 and 485 Narratives and 20 other Narratives from a `.backup` copy under v3 with the real Brain, writing to a throwaway datastore, and reports old against new legitimacy and total in Comments. The live DB is never written; the copy is deleted.
- [ ] **Docs.** The Rubric entry in `GLOSSARY.md` and `docs/architecture.md` name v3 and the rule; the 11-11 note that "legitimacy kills named-person stories" is marked superseded, with a one-line pointer to this ticket.
- [ ] Full `pnpm check` passes once before the commit.

## Interplay

- **Ticket 06** (meme idea generation) reads this Rubric text; this ticket must land before 06 (6 is blocked by 03 and 05, and follows 04 in the agreed order).
- **Ticket 05** writes the `meme` kind ADR; this ticket must not decide anything about kinds.
- **Phase 3 tickets 07 to 09** (cases and playbook) will later put lessons into the prompts; they edit the same prompts, so keep the v3 text in its own constant or file.
- Never open the live DB; replays use a `.backup` copy.

## Commits

One commit after a full `pnpm check`. Subject `Missed ideas ticket 04: <what changed>`, body ending with `Ticket: .scratch/missed-ideas/issues/04-rubric-v3-legitimacy-impersonation-only.md` before the trailers. Tick the boxes in the commit only if the full check does not stamp the tree afterwards, otherwise in a follow-up docs commit. No `Closes #N`: this repo has no GitHub issues.

## Comments
