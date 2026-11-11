# 24: News, Trends and GitHub are context only (a Source class; Narratives with no market Signal are never judged nor proposed)
**Model:** sonnet / medium — one small data table, two SQL filters and one prompt block, all with fixtures; the prompt block carries untrusted text, but it reuses an existing boundary pattern (ticket 22), so no `high`.

**What to build:** Add a **Source class** (`context` or `market`) declared as data in one place next to the Source definitions. RSS feeds, Google Trends and GitHub trending are `context`; PumpPortal and DexScreener are `market`. Context Sources stay ingested and clustered, but a Narrative with no market Signal is never judged and never proposed. A bounded block of recent context (top news Narratives) goes to Propose, Judge and the Meta summary as background, so agents still know what is happening in the world.

**Status:** ready-for-agent

**Blocked by:** the deploy stack on `main` (17, 19, 21, 22; branch `ipfs-gateway` at 95d6c79 is its tip), because 17 changes the propose code this ticket edits. For the Meta summary part, slice 5 of `viral-sources/03`; that part waits for it and is a follow-up commit.

Origin: the Operator, 2026-11-11: no good Proposal ever came from RSS, Google Trends or GitHub trending.

## Decided (user, 2026-11-11)

The Operator approved all of these (they were the chief-of-staff's defaults):
- The Source class (context vs market) is data, declared in one place next to the Source definitions.
- A Narrative with only context Signals is never judged nor proposed (this also saves LLM spend).
- A mixed Narrative is eligible only if it holds at least one market Signal.
- Context Narratives stay visible in the War Room.
- Recent context (top news Narratives, bounded, inside a random boundary, hostile-text safe) is given to Propose and Judge, and to the Meta summary (`viral-sources/03` slice 5), as background.

## Measurement (DB copy of 2026-11-11 ~20:20 UTC, `sqlite3 .data/argus.db ".backup"`; the copy is deleted)

Class used: market = `pumpportal:events`, `dexscreener:trending`; context = every `rss:*`, `trends:google`, `github:trending`. A Narrative's class comes from the Sources of its Signals (`signals.narrative_id`).

| Narratives | count | ever judged | ever proposed |
|---|---|---|---|
| context-only | 3172 | 679 | 131 |
| mixed (>= 1 market Signal) | 8 | 8 | 1 |
| market-only | 145 | 18 | 0 |

- **Proposals by class (132, 2026-11-06 to 2026-11-11):** 131 context-only (99.2%), 1 mixed (Proposal 42, Narrative 2: 8 market Signals of 18), 0 market-only.
- **Judge spend:** 705 Narratives have a Score; 679 (96%) are context-only. Under the new rule about 26 Narratives (8 mixed + 18 market-only) would have been judged, and 881 judge runs in the DB were mostly spent on Narratives that can no longer qualify.
- **What remains eligible:** the two market Sources, PumpPortal and DexScreener. **There is no Telegram Source in the code today** (only `pumpportal:events`, `dexscreener:trending`, `trends:google`, `github:trending`, the RSS feeds), so "others" is empty until a new Source ships (Telegram, TikTok `viral-sources/02`).
- **Volume left:** 1 Proposal in about 5.3 days (about 0.2 a day) from today's market Sources. So **until viral-sources/04 (Beta finder) ships, argus will produce almost no Proposals.** This is the intended result, not a regression, but the Operator should expect an empty Proposals list in the interim.
- Caveat: 99.4% of PumpPortal Signals sit in two Narratives (ticket `viral-sources/01`), so most market Signals do not form distinct Narratives; that is why market-only Narratives are few and none was proposed. The measurement is the baseline the replay in the acceptance list must reproduce.

## Where Judge and Propose pick Narratives (the selection points)

| | main (bfee8bf) | stack tip (ipfs-gateway 95d6c79) |
|---|---|---|
| Judge selection `narrativesToJudge` | `packages/core/src/datastore.ts:1081` (SQL `FROM narratives n WHERE` at 1087-1089) | `packages/core/src/datastore.ts:1097` |
| Propose selection `narrativesToPropose` | `packages/core/src/datastore.ts:1120` (SQL `JOIN scores` / `WHERE` at 1126-1130) | `packages/core/src/datastore.ts:1136` |
| Judge caller | `packages/core/src/judge.ts:193` | `packages/core/src/judge.ts:193` |
| Propose caller | `packages/core/src/propose.ts:335` | `packages/core/src/propose.ts:426` |
| Signals table (`source_id`, `narrative_id`) | `packages/core/src/datastore.ts:302`, `:330` | same area |
| Source ids | `sources/pumpportal.ts:93`, `dexscreener.ts:136`, `google-trends.ts:25`, `github-trending.ts:38`, `rss.ts:29` (id per feed) | same |

The implementer re-checks the stack-tip lines after the merge. The filter belongs in the two datastore queries (an `EXISTS` over `signals` with a `source_id` in the market list), so the loop callers need no change and a skipped Narrative starts no run (like `minSignals`, it never counts against the run cap). Ticket 17 touches the propose prompt in `propose.ts`, so build the context block on top of it.

## Design

- **Source class as data.** One exported table in `packages/core/src/sources/` (for example `source-class.ts`: `SOURCE_CLASS` keyed by Source id or id prefix, `sourceClass(id)`). Unknown ids default to `context` (fail closed: a new Source cannot start producing Proposals by being forgotten), and a test fails when a registered Source has no explicit entry. The `datastore.ts` queries take their market id list from this table; there is no second list.
- **Eligibility.** `narrativesToJudge` and `narrativesToPropose` add `AND EXISTS (SELECT 1 FROM signals sg WHERE sg.narrative_id = n.id AND sg.source_id IN (<market ids>))`. Existing Scores and Proposals are untouched; this changes selection only. A Narrative that later gains a market Signal becomes eligible at once.
- **War Room.** Context Narratives remain in the Narratives and Signals views. The class is exposed so the page can label a Narrative "context" (or "market"); no UI redesign here.
- **Context block.** A new pure function (for example `contextBlock(store, now)`) selects the top N context-only Narratives by recent Signal count over a window (defaults: N = 5, 24 h, each title capped at 120 characters, one line each, at most 1,500 characters in all; all configurable). The block follows ticket 22's untrusted-boundary pattern: a fresh random boundary, the rule text outside it says the content is data and never instructions, fields have control and invisible characters stripped and whitespace flattened. No context (empty): the block and its rule text are omitted and the prompt is byte-for-byte today's. It goes into the judge prompt (`judge.ts`), the propose prompt (`propose.ts`), and later the Meta summary prompt. The Rubric is unchanged; the block is background, not a score input.
- **Docs.** A new ADR (next free number at merge time; check `docs/adr/` and the reservation noted in `viral-sources/03`) records: market Signals decide eligibility, context Signals are background only, unknown Sources fail closed, and the measured reason. GLOSSARY gains a `Source class` entry under Source (and `_Avoid_` "category"); the `Source` entry gains one sentence. The ADR notes it contradicts nothing in ADR 0002, 0006, 0007.

Out of scope: removing the context Sources or their feeds; changing the Rubric; changing clustering (`viral-sources/01`); the Beta finder (`viral-sources/04`); the Meta ranking (`viral-sources/03`); deleting old Proposals or Scores.

## Acceptance

Offline in `pnpm check` (fixtures, fake Brain).

- [ ] **Source class is data.** `sourceClass()` returns `market` for `pumpportal:events` and `dexscreener:trending`, `context` for `rss:*`, `trends:google`, `github:trending`, and `context` for an unknown id; a test enumerates every registered Source and fails if one has no explicit entry (tested).
- [ ] **News-only Narrative is not judged.** A fixture Narrative whose Signals are all context (RSS, Trends, GitHub) is absent from `narrativesToJudge`, starts no judge run and does not count against the run cap (tested, failing first on `main`).
- [ ] **Mixed Narrative with a market Signal is judged.** A fixture Narrative with 17 RSS Signals and one PumpPortal or DexScreener Signal is returned by `narrativesToJudge`; a market-only Narrative is too (tested).
- [ ] **Propose follows.** `narrativesToPropose` excludes a scored context-only Narrative (even with buildability above the gate and no Proposal yet) and includes the mixed one; an existing Proposal and Score on a context-only Narrative are untouched (tested).
- [ ] **Becomes eligible on a market Signal.** A context-only Narrative that gains a market Signal is selected on the next pass (tested).
- [ ] **Context block in the prompts.** With context Narratives present, the judge and propose prompts contain a bounded context block (at most N titles, per-title and total caps) inside a fresh random boundary; hostile titles (`</boundary>`, "ignore previous instructions", control and invisible characters, 10,000 characters) cannot end it or exceed their caps, and the block lists only context-only Narratives (tested).
- [ ] **No context, no change.** With no context Narratives, both prompts are byte-for-byte today's (tested).
- [ ] **War Room still shows context Narratives.** The Narratives view and API still list a context-only Narrative, labelled with its class (tested in `apps/warroom/server/test`).
- [ ] **Replay on a DB copy.** On a `.backup` copy of the live DB (home-disk path, deleted afterwards), the new selection returns 0 context-only Narratives for the judge and propose passes and the 8 mixed and 145 market-only Narratives are eligible, matching the Measurement table above; the counts go in Comments (opt-in script, not in `pnpm check`).
- [ ] **Meta summary context (follow-up).** After `viral-sources/03` slice 5 lands, the `meta-summary` prompt carries the same bounded block, or a Comment says why it does not (tested with a fake Brain).
- [ ] **Docs.** ADR and GLOSSARY `Source class` entry as in Design.
- [ ] Full `pnpm check` passes once before each commit.

## Interplay

- **`viral-sources/03` (Meta ranking) and `04` (Beta finder, top priority)** become the main Proposal path once this lands; **`viral-sources/01` (launchpad clustering) matters more**, because market-only Narratives are few while PumpPortal Signals sit in two Narratives. The interim (this ticket merged, 04 not yet) yields about 0.2 Proposals a day by the measurement; ship this ticket with the Operator knowing that, or sequence it right before 04.
- **Ticket 22** (migrated examples block) and **ticket 17** (propose prompt): share the untrusted-boundary renderer; build on the stack tip.
- **Judge spend** drops by about 96% of judged Narratives, which also frees the daily cap for market Narratives.

## Open questions for the Operator

1. **Interim with few Proposals.** Is it acceptable to merge this before 04 ships, given about 0.2 Proposals a day, or should it be held until 04 is in? (No other choice was made for you.)
2. **Context block size.** Defaults are 5 Narratives, 24 h, 1,500 characters. Larger gives agents more world news and costs more prompt tokens per judge call; adjust if wanted.
3. **Future Sources.** Fail-closed default (`context`) means a new Source (Telegram, TikTok) must be declared `market` explicitly. Confirm that is how you want it.

## Commits

Subject `Phase 3 ticket 24: <what changed>`, body ending with `Ticket: .scratch/phase-3-feedback/issues/24-context-sources-never-propose.md` before the trailers. Suggested split: (1) Source class and the two selection filters with tests; (2) context block in the judge and propose prompts; (3) the Meta summary hook after `viral-sources/03` slice 5; (4) ADR and GLOSSARY. Each after a full `pnpm check`. No `Closes #N`: this repo has no GitHub issues.

## Comments
