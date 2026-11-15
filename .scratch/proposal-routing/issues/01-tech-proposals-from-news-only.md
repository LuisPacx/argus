# 01: Tech Proposals come only from news Narratives; launchpad Narratives are not judged
**Model:** sonnet / medium. A routing rule in two datastore selectors and one re-check, a config removal, a filter on one list page, and docs; each piece is small and in known files. No new model call and no schema change.

**What to build:** only a Narrative of kind `news` can get a Score and a Tech Proposal. Launchpad Narratives (one token's creates, from the pump.fun stream) stop being judged and stop being proposed from; they stay clustered, listed, and used as context. Memecoin ideas come from Metas (ADR 0013), never from a Narrative. Decided by the user on 2026-11-15 (`.scratch/cos.md`: GRILL R1 USER Q1 (a), GRILL R2 USER Q4 and Q5, the FACT CORRECTION and Q9 entries). Four launchpad Narratives (4570, 4879, 5506, 5605) became Proposals 154 to 157, all with the same "spot-the-original copycat game" Tech; a Tech is a web app, and a single token's creates give it nothing to ride.

**Status:** open

**Blocked by:** none. Tickets 02 and 03 in this directory build on this routing; 02 lists this as its blocker.

## What is there today (read 2026-11-15)

- `Datastore.narrativesToJudge` (`packages/core/src/datastore.ts:1508`) takes both a news minimum and a launchpad minimum (`minSignalsLaunchpad`, `:1514`), picks the minimum per kind in the SQL (`:1530`), and orders news first then launchpad (`:1537`). It already requires a market Signal (`HAS_MARKET_SIGNAL`, ADR 0011). Its doc comment (`:1499-1506`) describes the launchpad lane.
- `Datastore.narrativesToPropose` (`datastore.ts:1574`) has no kind test: any scored Narrative with a market Signal and buildability at the gate qualifies, which is how launchpad Narratives reached propose.
- The creation re-check is in `proposePendingNarratives` (`propose.ts:519-525`): after the model returns, the gate is re-judged on the latest Score "at the moment of creation" and the answer is dropped (`out.withdrawn++`) if it no longer passes. `createResearchProposal` (`datastore.ts:906`) enforces only one Proposal per Narrative and the daily cap. Nothing there knows the Narrative's kind.
- The launchpad judge minimum: `JudgeConfig.minSignalsLaunchpad` (`judge.ts:113`), `DEFAULT_JUDGE_MIN_SIGNALS_LAUNCHPAD = 15` (`:129`), `DEFAULT_JUDGE_CONFIG` (`:140`), the env read `ARGUS_JUDGE_MIN_SIGNALS_LAUNCHPAD` (`:160`, doc comment `:143`), the call that passes it (`:210`), the `[config]` log line `judge_min_signals_launchpad=` (`startup-config.ts:53`), `.env.example:27`, the pipeline-graph rule row "Signals a launchpad Narrative needs" (`pipeline-graph.ts:188`), and `docs/architecture.md:302`. Tests that name it: `judge-pass.test.ts:6,101-128`, `context-only.test.ts:34,97`, `api-fallback.test.ts:55`, and any `[config]` test in `startup-config.test.ts`.
- Launchpad Narratives still have readers that stay: the Narratives list and detail (`apps/warroom/server/api/narratives/index.get.ts`, `apps/warroom/app/pages/narratives/index.vue:79-82`), `contextNarratives` (`datastore.ts:1547`, used by `context-block.ts:75`), and the Activity feed's `newestNarratives` (`datastore.ts:1252`), which shows a launchpad Narrative only once it has a Score (`WHERE n.kind <> 'launchpad' OR EXISTS (scores)`; War Room `server/api/activity/narratives.get.ts:2`).
- Metas, Hot now and meme Proposals read launchpad Signals directly (`meta/store.ts:322`), not through Narratives, so this change does not touch them. Since viral-sources ticket 01, pump.fun Signals never join news Narratives (`narratives.ts:195-199`, `placeLaunchpadSignal`; `datastore.ts:1351`), so a news Narrative's market evidence is DexScreener and similar, not pump.fun.

## Approach (a default; say if you want it changed)

1. **`narrativesToJudge`** selects only `n.kind = 'news'`. Drop the `minSignalsLaunchpad` parameter, the `CASE n.kind` and the launchpad ordering term; keep the market-Signal and all other filters. Update the doc comment. (A launchpad Narrative that already has a Score keeps it; nothing re-judges it, so its Score stays as history.)
2. **`narrativesToPropose`** adds `AND n.kind = 'news'` beside `HAS_MARKET_SIGNAL`. A news Narrative still needs a market Signal (ADR 0011) and the buildability gate.
3. **Creation re-check** (`propose.ts:519`, next to the gate re-check): before `createResearchProposal`, re-read the Narrative's kind; if it is not `news`, log `narrative N is not a news Narrative; answer dropped`, count it as `withdrawn` and continue. This covers a launchpad Narrative that was selected before the change and answered after it, and any other caller path. Add a small `Datastore` read for the kind if none exists.
4. **Remove the launchpad judge minimum** completely: the config field, the default, the env var (a set value is now simply ignored, as an unknown env var is), the `[config]` token, the `.env.example` line, the pipeline-graph rule row, the sentence in `docs/architecture.md:302` (regenerate with `pnpm docs:graph`, do not hand-edit generated parts), and the tests listed above.
5. **Narratives page.** The list API takes `kind` (`news` or `launchpad`); with no `kind` it returns news only (the default). `NarrativeQuery` gets `kind?: "news" | "launchpad"`, applied in `queryNarratives` (`datastore.ts:1437`) as a `n.kind = ?` term, and the API validates it like the other filters (`400 Invalid kind`). The page gets a Kind control (News | Launchpad) in the same filter bar as Sort, Scored, Proposal and Active (`index.vue:79-82`), kept in the URL like those, default News (absent from the URL when News). Rows of a launchpad list carry no Score, so the Scored filter and the Score sort stay usable but will show none; do not hide them.
6. **Activity feed.** `newestNarratives` shows `kind = 'news'` only (drop the `OR EXISTS (scores)` branch). State the effect in the comment and on the page's empty/help text if it has one: launchpad Narratives no longer appear in Activity because they are never scored; old scored ones (if any) drop out too. Update the `activity.test.ts` expectations that listed a scored launchpad Narrative.
7. **ADR.** Add a short section **Amendment 2026-11-15** to ADR 0013, not 0007. Why 0013: it owns the rule "what a Proposal is made from" (`narrative` from a Narrative, `meme` from a Meta); this amendment narrows the first half and sharpens the second. ADR 0007's viral-sources amendment only says how launchpad Signals cluster, and stays true; add one line there pointing to 0013's amendment ("launchpad Narratives are routing and context only"). The 0013 text states: memecoins never get a Tech; a Tech Proposal comes only from a `news` Narrative (still with a market Signal, ADR 0011); a launchpad Narrative is routing and context (it groups one token's creates, feeds `contextNarratives`, and is listed) and is never judged or proposed; memecoin ideas come only from Metas; Proposals 154 to 157 predate the rule and expire as usual.
8. **GLOSSARY.** Narrative: add the two kinds (`news`: built from news and market Signals, judged and proposed; `launchpad`: one token's creates, context and routing only, never judged or proposed). Proposal: say a `narrative` Proposal comes only from a `news` Narrative. Keep the file's one-paragraph style.
9. **Docs.** Run `pnpm docs:graph` and commit the regenerated `docs/architecture.md`; check the judge and propose rule rows and the section-302 text read correctly afterwards.
10. **No migration.** Proposals 154 to 157 are left to expire or be dismissed. No data is rewritten.

## Acceptance criteria

- [ ] `narrativesToJudge` returns a news Narrative that qualifies and never a launchpad one, even a launchpad Narrative with thousands of Signals and a market Signal; test (replace the launchpad-lane tests in `judge-pass.test.ts` and `context-only.test.ts`).
- [ ] `narrativesToPropose` returns a scored, gate-passing news Narrative with a market Signal, and never a launchpad Narrative that has a Score at or above the gate; a news Narrative with no market Signal is still excluded; tests in `propose-store.test.ts`.
- [ ] The creation re-check drops the answer and counts it `withdrawn` when the Narrative is not `news` at creation time, and creates nothing; test through the pass with the fake brain (select as news, flip the kind, answer).
- [ ] `ARGUS_JUDGE_MIN_SIGNALS_LAUNCHPAD` and `minSignalsLaunchpad` are gone from code, the `[config]` log line, `.env.example`, pipeline graph rows and tests; a repo grep finds none outside ADRs, `.scratch/` and git history. `judgeConfigFromEnv` still validates the remaining vars.
- [ ] The Narratives list API returns news only by default, `kind=launchpad` returns launchpad only, `kind=news` returns news, anything else is `400`; War Room test in `apps/warroom/server/test/narratives.test.ts`.
- [ ] The Narratives page has the Kind filter, its value is in the URL, News is the default (no param), and it combines with the other filters; covered in the existing page-render or route test style.
- [ ] Activity lists no launchpad Narrative, scored or not; the Activity API test says so.
- [ ] Launchpad Narratives are still clustered, still listed under Kind = Launchpad, and still feed `contextNarratives` (existing tests stay green; add one asserting `contextNarratives` is unchanged).
- [ ] ADR 0013 has the amendment, ADR 0007 has the one-line pointer, GLOSSARY has the Narrative kinds and the Proposal sentence, and `docs/architecture.md` is regenerated by `pnpm docs:graph`.
- [ ] `pnpm page:check` passes on `/narratives` (default and `?kind=launchpad`) at 390 px and 1240 px, with no horizontal scroll at 390.
- [ ] Type-check and the full `pnpm check` pass, run once before the commit.

## Constraints

- Tests assert on the selectors' returned ids, the re-check outcome and the API/page output, not on model answers. Temp datastores are removed by the tests.
- Follow `docs/agents/worker-rules.md` and `CODING_STANDARDS.md`. Commit subject `Proposal routing: ticket 01 (Tech Proposals from news only)`, body ends with `Ticket: .scratch/proposal-routing/issues/01-tech-proposals-from-news-only.md` before the trailers. No `Closes #N`: this repo has no GitHub issues.
- Do not change Metas, Hot now, meme Proposals, `placeLaunchpadSignal` or clustering.

## Open questions

1. **Old scored launchpad Narratives in Activity.** Default: they drop out with the rest (the feed becomes news only). Say so if you want scored ones kept visible.
2. **A news Narrative with only DexScreener market evidence.** Default: still eligible (ADR 0011 needs any market Signal). Since pump.fun Signals no longer join news Narratives, most news Narratives have none; Q8 (should launch activity back news stories?) is held separately and not decided here.

## Comments

- **Decision (user, 2026-11-15, GRILL R1 USER Q1 (a), GRILL R2 USER Q4 and Q5):** memes from Metas only; stop judging launchpad Narratives and drop `ARGUS_JUDGE_MIN_SIGNALS_LAUNCHPAD`; Tech Proposals only from `kind = 'news'` (still with a market Signal); Proposals 154 to 157 left to expire (Q6).
- **Fact correction (2026-11-15):** launchpad Narratives are not market evidence for news Narratives (pump.fun Signals never join news ones), so they stay as routing and context, not as an input to a Tech Proposal. Their readers are the Narratives pages, Activity (scored only), judge and propose, and `contextNarratives`; this ticket removes the judge and propose readers for launchpad.
- **Q9 (user's belief that launchpad Narratives were the meme generator):** they are not; Metas are. This ticket makes that true in code and docs. Widening the meme generator is a separate, held decision.
