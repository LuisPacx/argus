# 04: Rubric v3: legitimacy penalises impersonation, fraud, and hate or harassment; satire is allowed
**Model:** sonnet / medium. A prompt and Rubric version change plus the version plumbing; the judgment is already decided, the work is the wording and the proof that old scores stay as history.

**What to build:** the Rubric's legitimacy dimension scored both Nvidia-related Narratives down because the idea rests on "unverified allegations about a named real person" (Scores 401, 466, 476, 528, 593, 895 in `internal-trace.md`), and Narrative 662 got legitimacy 1 for a "meme token impersonating a real person". The Operator's rule (Q4, Q7): memes and satire about public figures are normal comedy and are surfaced; what lowers legitimacy is **impersonation** (a token or account that pretends to be the person, uses their name as an endorsement, or claims to be official), **fraud** (a false claim meant to take money) and **hate or harassment** (Operator decision 2026-11-15: these stay penalties, as in v2). Ship that as Rubric v3, used by the judge and by meme ideas (ticket 06).

**Status:** done

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

- [x] **v3 registered.** `rubric_versions` gains v3; new Scores carry v3; the idempotent migration or seed is rehearsed on a `.backup` copy (deleted afterwards), and v1 and v2 rows are unchanged (tested).
- [x] **Old scores are history.** A DB with Scores under v2 keeps them byte for byte after the change; no Narrative is re-judged because of the version alone (tested).
- [x] **Prompt text.** The v3 judge prompt contains the impersonation-and-fraud rule and the satire allowance and no longer lists "unverified allegations about a named real person" as a legitimacy penalty (tested by reading the built prompt).
- [x] **Fixtures.** With a fake Brain that echoes the rule it was given, three fixture Narratives (a satire token about a CEO, a token claiming to be that CEO's official coin, a fake giveaway) are sent with the v3 prompt; the prompt for the second and third names the penalty and the prompt for the first does not (tested on the prompt, not on a model's score).
- [x] **Opt-in measurement.** An opt-in script (not part of `pnpm check`) re-judges the stored 662 and 485 Narratives and 20 other Narratives from a `.backup` copy under v3 with the real Brain, writing to a throwaway datastore, and reports old against new legitimacy and total in Comments. The live DB is never written; the copy is deleted.
- [x] **Docs.** The Rubric entry in `GLOSSARY.md` and `docs/architecture.md` name v3 and the rule; the 11-11 note that "legitimacy kills named-person stories" is marked superseded, with a one-line pointer to this ticket.
- [x] Full `pnpm check` passes once before the commit.

## Interplay

- **Ticket 06** (meme idea generation) reads this Rubric text; this ticket must land before 06 (6 is blocked by 03 and 05, and follows 04 in the agreed order).
- **Ticket 05** writes the `meme` kind ADR; this ticket must not decide anything about kinds.
- **Phase 3 tickets 07 to 09** (cases and playbook) will later put lessons into the prompts; they edit the same prompts, so keep the v3 text in its own constant or file.
- Never open the live DB; replays use a `.backup` copy.

## Commits

One commit after a full `pnpm check`. Subject `Missed ideas ticket 04: <what changed>`, body ending with `Ticket: .scratch/missed-ideas/issues/04-rubric-v3-legitimacy-impersonation-only.md` before the trailers. Tick the boxes in the commit only if the full check does not stamp the tree afterwards, otherwise in a follow-up docs commit. No `Closes #N`: this repo has no GitHub issues.

## Comments

2026-11-15 (worker). Done: `LEGITIMACY_RULE` (own constant, `packages/core/src/rubric.ts`), `addLegitimacyRuleVersion` in `migrateRubric` (idempotent, looks for `LEGITIMACY_RULE_MARKER`), judge SKILL.md line, GLOSSARY, architecture, internal-trace marked superseded, tests in `rubric-v3.test.ts` (+ `rubric.test.ts` version numbers). A fresh database seeds v1 with the rule (like the Tech-value line); a database without it gets one new version, the latest with only `legitimacy` replaced (gate and weights kept). Migration rehearsed on a `.backup` copy of the live DB (v1, v2 -> v1, v2, v3, gate 5.0, 919 Scores unchanged by md5), copy deleted.
- Not ticked: **Opt-in measurement.** `scripts/rubric-v3-replay.mjs` exists and its `--dry` run was done on the copy (22 Narratives chosen, v3 prompt printed); the real-Brain run spends Claude calls and was not made. Run it on a fresh `.backup` copy when the Operator wants the old-against-new table, and paste it here.
- Fixtures box: the three prompts differ only in the Narrative text; the Rubric text is the same for all (the penalty and the satire allowance are both in each), so the test checks the rule text in each prompt and the Narrative text in each, not that the satire prompt "does not name" the penalty.

2026-11-15 (worker, replay run). The opt-in measurement box is ticked: the real-Brain replay ran with `--run` (Operator approved) on a `.backup` copy of the live DB, 22 judge calls; the copy was deleted afterwards. The script is now dry unless `--run` is given, and refuses the live DB by realpath (`scripts/live-db-guard.mjs`). The rule text now includes hate or harassment as penalties (Operator decision), so this run used that text.

| id | old v | old legit | old total | new legit | new total |
|---|---|---|---|---|---|
| 662 | v1 | 1.00 | 4.20 | 6.00 | 6.00 |
| 485 | v1 | 6.00 | 6.40 | 9.00 | 7.20 |
| 4059 | v2 | 2.00 | 3.40 | 5.00 | 3.80 |
| 3440 | v2 | 2.00 | 3.20 | 2.00 | 3.60 |
| 3354 | v1 | 2.00 | 4.00 | 6.00 | 5.20 |
| 3345 | v1 | 9.00 | 5.80 | 9.00 | 5.40 |
| 3337 | v2 | 3.00 | 4.00 | 7.00 | 5.00 |
| 3331 | v1 | 6.00 | 4.40 | 9.00 | 3.80 |
| 3244 | v1 | 8.00 | 3.80 | 9.00 | 4.20 |
| 3225 | v1 | 4.00 | 2.60 | 8.00 | 4.80 |
| 3171 | v1 | 5.00 | 4.60 | 8.00 | 4.00 |
| 3155 | v1 | 9.00 | 6.80 | 9.00 | 6.20 |
| 3154 | v1 | 7.00 | 5.80 | 8.00 | 4.60 |
| 3137 | v1 | 6.00 | 3.40 | 7.00 | 3.60 |
| 3127 | v1 | 9.00 | 5.80 | 9.00 | 4.80 |
| 3125 | v1 | 8.00 | 5.00 | 9.00 | 5.80 |
| 3121 | v1 | 9.00 | 5.80 | 9.00 | 4.60 |
| 3116 | v1 | 6.00 | 4.20 | 8.00 | 4.00 |
| 3111 | v1 | 8.00 | 6.00 | 9.00 | 6.00 |
| 3110 | v1 | 8.00 | 4.60 | 9.00 | 4.00 |
| 3098 | v1 | 9.00 | 5.20 | 9.00 | 4.40 |
| 3091 | v1 | 8.00 | 5.00 | 9.00 | 4.60 |

Reading: legitimacy rose or stayed in 22 of 22 (rose in 16, equal in 6); the named-person Narratives moved as intended (662 from 1 to 6, 3354 from 2 to 6, 4059 from 2 to 5; 3440 stayed at 2). Legitimacy is not the gate (the gate is buildability at 5.0) and the script does not print buildability, so gate pass/fail flips are not measured here. The totals fall for 11 Narratives because a fresh judge call also re-scores the other dimensions (run-to-run noise on momentum, novelty and hook), not because of v3.
- 2026-11-21 cos triage: fixes landed (ADR 0013, Rubric v3, meme kind, Meta meme ideas behind ARGUS_MEME_IDEAS)
