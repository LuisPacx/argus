# 06: Meta summaries go stale: a stored line is shown under numbers it no longer matches
**Model:** sonnet / medium. One store column pair, one display rule, one prompt change and a pass condition, all in `packages/core/src/meta/`; no new data source. The replay is a check, not design work.

**What to build:** show a Meta's LLM summary only while its row is still close to the counts the summary was written from; otherwise show the plain numbers line and queue a rewrite within the existing caps. Never present numbers in prose that disagree with the row.

**Status:** open

**Blocked by:** `missed-ideas/03` (adds matching news to the summary prompt, in progress in parallel; this ticket edits the same prompt and pass, so it builds on that change).

Origin: cos report 2026-11-15, from a `pnpm page:check` screenshot of the live `/meta` at 02b936d. The user calls the Meta "not accurate". Part of `viral-sources/03` (Meta ranking), ADR 0012 and its 11-14 addendum, GLOSSARY "Meta" ("one-line summary, written by the Brain within a daily cap and shown with a templated numbers line when there is none").

## What happened (read 2026-11-15)

- Meta #10 "The Jensen Menace": the row says 7 tokens / 3 creators, the summary says "Jensen Huang meme theme riding a viral concert-jumbotron clip: 105 launches by 64 creators in 24h, but only 2 migrations...". That is the 2026-11-12 text, reused because the theme key still matches.
- Catzilla, row 12: 12 tokens / 9 creators, summary says "9 launches from 7 creators".

## Root cause (named from the code)

1. **A stored summary is attached to a row by group key alone, with no check that the row still looks like the input it was written for.** `packages/core/src/meta/store.ts:291-297` (`latest()`): for every row read it copies `summary`/`summaryAt` from `meta_summaries` whenever the key has one. `packages/core/src/meta/summary.ts:58-60` (`metaLine`) then shows it whenever it is non-empty. Nothing compares the row's current counts or the summary's age; the only age check anywhere is the 60 minute retry gap in the pass.
2. **Only the top five rows are ever refreshed, but every row in the table is shown with its old summary.** `packages/core/src/meta/summary-pass.ts:115` reads `latestMetas("24h", config.topRows)` with `topRows: 5` (`:34`), so a Meta that drops to #10 or #12 is never revisited, while its old line stays attached by (1). Jensen and Catzilla are both outside the top five today.
3. **Even for the top five, a rewrite fires only when the hash moves.** `summary.ts:92-97` (`metaInputHash`) buckets token, creator and migration counts by powers of two and leaves rank out, and `summary-pass.ts:124` skips a row whose hash is unchanged. A Meta can drift by up to 2x inside a bucket and keep a line that states the old numbers. Rewrites are also bounded by `maxPerPass` 5, `minAgeMinutes` 60 and the cap `maxRunsPerDay` 40 / `maxDailyUsd` 0.25 (`summary-pass.ts:34`, checked at `:128-131`), which are fine and stay.
4. **The prompt invites numbers in prose.** `summary.ts:123-138` (`metaSummaryPromptFor`) gives the model the counts and asks for "one fact about its state (many launches or few...)", so the line restates "105 launches by 64 creators". Any drift then makes the sentence wrong.

## Design (the ticket writer's choice, the user can overrule)

1. **Store the counts the summary was written from.** `meta_summaries` gains `base_tokens`, `base_creators` (24 h window counts at write time; the summary and the 24 h ranking are the same window). `saveSummary` writes them; additive migration like the others in `store.ts`, no backfill: an old row with NULL counts counts as stale (shows the numbers line), which fixes Jensen and Catzilla on the first read.
2. **A pure `summaryFresh(row, record, now)` in `summary.ts`.** Fresh when tokens and creators are each within 0.5x to 2x (current/stored) of the stored counts, so Jensen 7 vs 105 fails and Catzilla 12 vs 9 passes and `summaryAt` is under 24 h old. Ratio and age are named config keys in `config.ts`, not literals. `store.latest()` attaches `summary` only when fresh; `metaLine` is unchanged (no summary means the templated line, `summarySource: "template"`).
3. **Queue a rewrite for a stale one, inside the caps.** The pass treats a stored-but-stale summary like a missing one (same order, same `minAgeMinutes`, `maxPerPass`, `maxRunsPerDay`, `maxDailyUsd`, research budget). Widen the pass from the top five to the rows the page shows only if the day's cap still holds; otherwise the numbers line stands, which is correct, just plainer. Rows past the cap are never shown a stale line.
4. **Prompt: do not restate counts.** Ask for the theme and the state in words ("many", "few", "mostly migrating") and no figures, since the row beside it shows them. `parseMetaSummary` (`summary.ts:73-81`) refuses an answer that contains a digit run that is not part of a token name or year in the given input (check with a plain linear scan, no dynamic RegExp), logged as refused like the other refusals. This keeps a line true even if the row moves, at the cost of a plainer sentence. The matching-news text from `missed-ideas/03` stays; its numbers (if any) follow the same rule.

## Acceptance

- [ ] With fakes: a summary written for 105 tokens / 64 creators is not shown on a row of 7 / 3 (the numbers line shows, `summarySource` "template"); one written for 9 / 7 is shown on 12 / 9; one older than the age limit is not shown; a record with NULL base counts is not shown. Fast tests next to `summary.test.ts` and `store.test.ts`.
- [ ] The pass with a fake Brain: a stale summary is queued for a rewrite and the run counts against `maxRunsPerDay` and `maxDailyUsd` (the existing cap tests still pass, and a cap-reached pass leaves the numbers line, never the old text).
- [ ] The prompt asks for no figures, and `parseMetaSummary` refuses an answer that restates a count not in the input (fake answers: "105 launches by 64 creators" refused, a plain theme line accepted).
- [ ] Replay on a `.backup` copy of the live DB (never the live file; `sqlite3 <db> ".backup <copy>"` onto the home disk, deleted after): list every row of the latest 24 h run with its counts, its stored summary and what `latest()` now returns. The Jensen and Catzilla mismatches are gone; no row shows prose whose numbers disagree with its counts. Paste the table into Comments.
- [ ] Pipeline graph: any new config keys (ratio, age limit) are keyed rules on the Meta summary node or in `LEFT_OUT` with a reason; the sync test in `packages/core/src/pipeline-graph.ts` passes (see `viral-sources/05` item 3 for how it checks keys); the `How it works` page and generated diagrams are regenerated if the graph changed.
- [ ] Browser: `pnpm page:check /meta` (1240 and 390 px) screenshots cited with exit code 0 against the worker's own instance (a replay copy, not the live Argus): rows whose summary is stale show the numbers line, fresh ones show the summary.
- [ ] GLOSSARY "Meta ranking" sentence updated to say a summary shows only while the row is close to the numbers it was written from; one line added to the ADR 0012 addendum.
- [ ] Full `pnpm check` passes once on the committed clean tree.

## Commits

One commit after the full `pnpm check`. Subject `Viral sources ticket 06: <what changed>`; the body ends with `Ticket: .scratch/viral-sources/issues/06-stale-meta-summaries.md` before the trailers. No `Closes #N`: this repo has no GitHub issues.

## Open questions (answered 2026-11-15, see Comments)

1. **What counts as "close"?** Default: tokens and creators each within 0.5x to 2x of the stored counts, and the summary under 24 h old. Tighten (say 0.7x to 1.4x) if you want fewer plain rows to stay out of the way, loosen if the numbers line shows too often.
   **Answered:** keep 0.5x to 2x for tokens and for creators, each against the counts the summary was written from, plus under 24 h old. A summary is current only while all three hold; otherwise show the plain numbers line and queue a rewrite within the existing caps.
2. **Number-free prompt or a refresh only?** Default: both (the prompt asks for no figures and a stale line is hidden). Overrule to keep figures in prose and rely on the freshness check alone; the line then reads richer but is wrong whenever the row drifts inside the ratio.
   **Answered:** both. The summary prompt becomes number-free (no counts in prose), and stale summaries are hidden.

## Comments

**2026-11-15:** Answers to the open questions from the user.
1. "Close" is tokens and creators each within 0.5x to 2x of the counts the summary was written from, and the summary under 24 h old. A summary is current only while all three hold. Otherwise show the plain numbers line and queue a rewrite within the existing caps.
2. Both: the summary prompt becomes number-free (no counts in prose), and stale summaries are hidden.
