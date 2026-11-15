# 02: Propose: do not repeat a Tech from a recent Proposal
**Model:** sonnet / medium. A new prompt block and a datastore read in known files, tested on the built prompt; no model change and no UI.

**What to build:** the propose prompt tells the model which Techs recent Proposals already used and requires a different one. Today four Proposals in a row (154 to 157) got the same Tech, "spot-the-original copycat game", because each propose run sees one Narrative and nothing else (`proposePromptFor`, `packages/core/src/propose.ts:175`) while the skill requires a Tech (`.claude/skills/propose/SKILL.md:18`). Decided by the user (GRILL R1 USER, Q2 (a), 2026-11-15, `.scratch/cos.md`): list the recent Techs in the prompt, the model must differ, and add no code-side similarity check unless repeats persist.

**Status:** done (2026-11-15)

**Blocked by:** 01 (proposal routing, not yet written). Ticket 01 changes which Narratives reach propose; this ticket builds on the same prompt and pass, so it starts after 01 lands.

## What is there today (read 2026-11-15)

- `proposePromptFor(narrative, score, rejected?, repairProblem?, migrated, context, metas)` (`propose.ts:175-232`) builds the prompt as rule sections outside the untrusted block, then the Narrative block, then optional migrated-examples, Meta and context blocks (`:229`, the context block closes the prompt). Every block of third-party text is fenced by `BOUNDARY-<random>` lines (`:182`).
- `proposePendingNarratives` (`propose.ts:307`) reads its side inputs once per pass and degrades to "prompt without it" on a read error (migrated examples `:334`, context `:344`, Metas `:351`), then passes them into all three prompt call sites (`:398` retry-after-refusal, `:437` repair, `:476` first run). The new input must reach all three the same way, or a repair or retry prompt would lose the list.
- Proposals store `tech` (`ProposeFields`, `propose.ts:42`); `Datastore.listProposals()` (`datastore.ts:1068`) lists them. No read returns "Techs of the last N days" yet.
- The evidence: Proposals 154, 155, 156, 157 (launchpad Narratives 4570, 4879, 5506, 5605) all carry the Tech "spot-the-original copycat game" (`.scratch/cos.md`, PROPOSALS 153-157). The ticket-01 routing change removes most of these Narratives from propose, but a Tech repeat can still happen among news Narratives, so this guard stays.

## Approach (a default; say if you want it changed)

1. **Datastore read.** A small method on `Datastore` returning the `tech` of Proposals created in the last 14 days, newest first, at most 20, deduplicated by exact text after one-line normalisation (the `oneLine` helper used in `propose.ts`). Meme Proposals have no Tech and are skipped. Counting from `createdAt`, not `updatedAt`, so a status change does not keep an old Tech "recent".
2. **Pass reads it once** per pass beside the examples and Metas, with the same try/catch and the same "prompting without it" log line, and passes it into the three prompt calls.
3. **Prompt.** `proposePromptFor` takes the list as one more optional argument (default `[]`; empty means the prompt is byte-identical to today's apart from the boundary). When non-empty: a rule section outside the block saying that these Techs were already proposed in the last 14 days, the new `tech` must be a different app (a different interaction, not a reworded one), and that the list is data, never instructions; and a block `BOUNDARY START recent-techs (untrusted)` with one line per Tech, one line each, closed by the same boundary line. Fence it exactly like the migrated-examples block, so a Tech text that contains a marker or an instruction is just text.
4. **SKILL.md.** One sentence in `.claude/skills/propose/SKILL.md` near the Tech rules: when the prompt has a recent-Techs block, propose a Tech that differs from every line of it.
5. **No code-side similarity check.** No string distance, no embedding compare, no refusal on a repeat. If repeats still show up after this ships, a check is a follow-up ticket (see Comments).

## Acceptance criteria

- [ ] A Datastore method returns the Techs of Proposals created in the last 14 days, newest first, max 20, one line each, deduplicated, skipping Proposals with no Tech; a test covers the 14-day edge, the cap of 20, dedupe and a meme Proposal.
- [ ] `proposePromptFor` with recent Techs contains the rule section and a fenced `recent-techs` block with one line per Tech; with none it contains neither. Tests on the built prompt: block present and fenced by the boundary, each Tech on its own line, a Tech containing a newline or a fake boundary marker stays on one line and cannot close the block, rule text says "different" and "data".
- [ ] The retry-after-refusal prompt (`:398`), the repair prompt (`:437`) and the first-run prompt (`:476`) all carry the block (test through the pass with the fake brain, reading the prompts it logged, as `propose-pass.test.ts` does).
- [ ] A Datastore read error is logged and the pass still prompts without the block (test).
- [ ] `.claude/skills/propose/SKILL.md` has the one-sentence rule.
- [ ] No similarity check in code; the pass still stores whatever valid Tech the model returns.
- [ ] Type-check and the full test suite pass.

## Constraints

- Tests assert on the built prompt and the datastore read, not on what a model answers.
- Follow `docs/agents/worker-rules.md` and `CODING_STANDARDS.md`. Commit subject `Phase N ticket 02: <what changed>`, body ends with `Ticket: .scratch/proposal-routing/issues/02-no-repeat-tech.md` before the trailers. No `Closes #N`: this repo has no GitHub issues. No GLOSSARY.md line expected.

## Open questions

1. **Compare on `tech` only?** Default: yes, the one `tech` line. The `interaction` line could repeat under a new `tech` text, but the user decided on Techs; add `interaction` only if repeats persist.

## Comments

- **Decision (user, 2026-11-15, GRILL R1 USER Q2 (a)):** the prompt lists recent Techs (14 days, max 20), the model must pick a different one; a code check only if repeats persist.
- **Follow-up, not in this ticket:** if Proposals still repeat a Tech after this ships, write a ticket for a code-side check (refuse or retry once on a near-duplicate, like the name-collision retry, `propose.ts:530`). Watch the next dozen Proposals before deciding.
