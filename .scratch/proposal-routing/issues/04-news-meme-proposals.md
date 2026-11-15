# 04: A news Narrative that fails the buildability gate can become a `meme` Proposal (the news story as the subject)
**Model:** to be set after the grilling (expected sonnet / high: a new Proposal source for the `meme` kind, its subject, cap and legitimacy rules, and an ADR amendment). Do not start before the open questions below are answered.

**What to build:** today a news Narrative with no buildable Tech goes nowhere: the buildability gate drops it (`narrativesToPropose`, `datastore.ts:1593`), and the Nvidia CEO story of 2026-11-12 was lost that way (ADR 0013, first paragraph). The user approved Q9 (b) on 2026-11-15: a news Narrative that **fails the buildability gate** can become a **`meme` Proposal**, written by the meme prompt (`meme-ideas`, `meme/ideas.ts`) with **the news story as the subject** instead of a Meta. The Operator then Shortlists or Dismisses it like any meme idea (no Spec, no Build, no Score of its own). This **amends ADR 0013**, which says a meme comes only from a Meta, and the proposal-routing ticket 01 amendment, which says memecoin ideas come only from Metas.

**Status:** open, **needs a grilling session first** (the questions below are not decided; nothing in this file is a decision except the one line above)

**Blocked by:** meta-redesign/03 (it changes the meme pass's trigger, cap and prompt wording, which this ticket reuses; building both at once would collide in `meme/pass.ts` and `meme/ideas.ts`). Also follows proposal-routing/01 (done): only `kind = 'news'` Narratives are judged or proposed.

Origin: `.scratch/cos.md`, "Q9 asked ... news failing buildability -> meme Proposal" and "USER: ... Q9 (c) staged" (2026-11-15), then the user's approval of Q9 (b); `.scratch/proposal-routing/issues/01-tech-proposals-from-news-only.md` (Comments, Q9).

## What is there today (read 2026-11-15)

- **The gate and the selectors.** `narrativesToJudge` takes news Narratives with a market Signal (ADR 0011); `narrativesToPropose` (`datastore.ts:1593`) takes the scored ones whose latest buildability is at least the Rubric's `gateMinScore`, and the propose pass re-checks kind and gate at creation (`propose.ts:519-529`). A news Narrative below the gate has a Score and no Proposal, forever.
- **The `meme` kind is built around a Meta.** `createMemeProposals` (`datastore.ts:976`) needs a Meta key and a Meta snapshot (`meta_key`, `meta_snapshot`, immutable by trigger, `datastore.ts:479-493`); one live trio per key per 6 h window (`proposals_meme_live`, `:488`); `generateMemeIdeas` (`meme/pass.ts:204`) reads current Metas; its prompt is about "a Meta that is Hot now" until meta-redesign/03 rewrites it; names must not copy a token of the Meta's group or one DexScreener lists (distinct-name rule: `parseMemeOutput` in `meme/ideas.ts` and `dexCopies`, `meme/pass.ts:408`).
- **Caps.** The meme pass has its own cap (5 runs a day after meta-redesign/03; hard ceiling 40) taken from the research budget (`researchUsage`, `meme/pass.ts:237`), shared with judge, propose and summaries.
- **Legitimacy.** The Rubric's legitimacy dimension (v3, missed-ideas/04: impersonation, fraud, and hate or harassment are not generated; satire about a public figure is fine and labelled) is read from the stored Rubric into the meme prompt (`meme/pass.ts:303`).

## Approach (a sketch to grill, not a decision)

1. **Selector.** A new `Datastore` read, `narrativesToMeme`: news Narratives with a Score whose buildability is **below** the gate, that have no Proposal of any kind yet, pass the floors decided in the grilling (legitimacy, momentum, how recent), and are not already a Meta's subject.
2. **Subject.** The meme prompt gets the Narrative (title, summary, newest Signals as untrusted text in a fresh boundary, the Score's reasons) where it gets a Meta today; the same output (3 ideas, same fields, same validator `parseMemeOutput`), the same distinct-name rule against DexScreener results (no Meta group to compare to).
3. **Storage.** The meme Proposal's subject key and snapshot generalise: a key such as `narrative:<id>` in `meta_key` (so `proposals_meme_live` and the 6 h trio guard work unchanged) and a snapshot variant `{ kind: "narrative", narrative, score, news }` beside the Meta one (`MetaSnapshot`, `meme/types.ts`). The Proposal keeps `narrative_id` NULL or points at the Narrative, to be decided (the "30 a day research cap" counts Proposals with a `narrative_id`, `datastore.ts:972`).
4. **Pass.** One more source of work in `generateMemeIdeas` after the Metas, under the same cap and the same `meme-ideas` task, so no new Brain task and no new host.
5. **War Room.** The meme card says where the idea came from ("from news: <title>" instead of the Meta numbers), links the Narrative, and shows the Score that failed the gate; `utils/meme.ts` reads the new snapshot variant next to the two it reads after meta-redesign/03.
6. **Docs.** ADR 0013 amendment (a meme comes from a Meta or from a news Narrative that fails the gate), the proposal-routing/01 amendment text, GLOSSARY (**Meme Proposal**, **Narrative**), `docs/architecture.md` and the pipeline graph (`pnpm docs:graph`).

## Open questions (for the grilling; the user decides)

1. **Which news qualify?** Any scored news Narrative below the buildability gate, or only those that also pass a floor on momentum and hook? Must it still have a market Signal (ADR 0011), and may it be a story with no token activity at all (the Nvidia case had only news at first)? How recent (a Signal in the last N hours)?
2. **The legitimacy floor.** The judge scored the Nvidia story down on legitimacy. A meme about a real person is allowed as labelled satire (Rubric v3), but a very low legitimacy Score (hoax, fraud, tragedy, a private person) should not become a joke token. What floor, if any, blocks a Narrative from this path (a number on the legitimacy dimension, a risk label that blocks, or the prompt's refusal alone)?
3. **Cap sharing.** Same 5 runs a day as the Meta ideas (news competes with Metas), a separate small cap (for example 2), or a share of the research budget only? Which goes first when the cap is short?
4. **Duplicates with Metas.** If the story is already a Meta's subject (the Jensen news and the Jensen Meta), does the Meta's trio win and the news path skip, or may both exist? Matching rule: the same `subjectKey` and `meta/news.ts` headline match, or none?
5. **Lifecycle.** Same 6 h in `new` as other memes (ADR 0013), a longer life for a news story, and one trio per Narrative ever, or again after a new material change?
6. **Storage shape.** `meta_key = narrative:<id>` and a snapshot variant (this sketch), or a separate `meme_source` column? Does the Proposal point at the Narrative (`narrative_id`) and count in the 30-a-day research cap?
7. **Trigger timing.** When the Narrative is first scored below the gate, or only after a delay (to let a market Signal arrive), or again when its Score changes?
8. **Naming.** "meme from news" cards: do they get the same `meme` pill, or a second label so the Operator sees where it came from?

## Acceptance criteria (a draft; final after the grilling)

- [ ] `narrativesToMeme` returns a news Narrative below the gate that passes the floors, never a launchpad Narrative, a Narrative with a Proposal, one that is a current Meta's subject (if question 4 says so) or one under the legitimacy floor; tests in `propose-store.test.ts`.
- [ ] The pass creates one trio of `meme` Proposals for it through the fake Brain, with the news as the subject in the prompt (inside a fresh untrusted boundary), the Score and news in the snapshot, a name-copy retry once then fail closed, and the cap enforced; nothing is stored when the Narrative stops being eligible at creation time (re-check as in `propose.ts:519-529`).
- [ ] The card and page show the source (news title, linked Narrative, the failing Score); hostile text in a headline or summary is rendered as text and cannot end the prompt boundary.
- [ ] ADR 0013 amended, ADR text of proposal-routing/01 pointed to it, GLOSSARY and `docs/architecture.md` agree; `/pipeline` shows the new edge from the judge or Narrative node to the meme node.
- [ ] `pnpm page:check` on a meme card of each source at 390 and 1240 px (no horizontal scroll at 390); full `pnpm check` once before the commit.

## Constraints

- Same safety as meme ideas: no Spec, no Build, no Rubric score of its own, argus launches nothing (ADR 0002); untrusted text in boundaries; no RegExp built from a headline.
- Do not change the Tech Proposal path: a Narrative that passes the gate is still proposed as before (proposal-routing/01).
- Commit subject `Proposal routing ticket 04: news meme Proposals`, body ends with `Ticket: .scratch/proposal-routing/issues/04-news-meme-proposals.md` before the trailers. No `Closes #N`.

## Comments

- **Written 2026-11-15** from the user's approval of Q9 (b). The decisions the user gave: the path exists, it starts from a news Narrative that fails the buildability gate, the meme prompt writes it with the news story as the subject, and it amends ADR 0013. Everything under "Approach" and "Open questions" is a proposal for the grilling.
- **Why it waits for meta-redesign/03:** that ticket changes the meme trigger, the 5-a-day cap and the prompt wording, and this ticket adds a second subject to the same pass. Doing 04 first would mean rewriting it.
