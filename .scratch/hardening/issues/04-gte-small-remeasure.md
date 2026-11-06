# 04: Re-measure gte-small on a fresh holdout sample
**Model:** sonnet / medium — a measurement and a constant; no new feature.

**What to build:** The Narrative join threshold `JOIN_THRESHOLD` 0.90 for gte-small (ticket 05c) was tuned on the same 320-headline sample it was measured on, with a margin of 0.886, and with no holdout. Collect a fresh, separate sample of real headlines (`scripts/collect-narrative-sample.mjs`), label it, include the Signal summaries in the embedded text as the worker does, and run `scripts/measure-narrative-threshold.mjs` on it as a holdout. Report precision and recall at 0.90 and the best threshold on the holdout. Change `JOIN_THRESHOLD` only if the holdout clearly says 0.90 is wrong (state the numbers); otherwise keep it and record the holdout result.

**Files:** `scripts/collect-narrative-sample.mjs`, `scripts/measure-narrative-threshold.mjs`, `packages/core/src/fixtures/narrative-sample*.json` (add `narrative-holdout*.json` beside them, do not overwrite), `packages/core/src/narratives.ts` (the constant only, if it changes), `packages/core/src/narrative-calibration.test.ts`, `docs/adr/0007-narratives-use-an-in-process-semantic-embedder.md` (record the holdout numbers).

**Blocked by:** none. No file overlap with tickets 01 to 03 unless `JOIN_THRESHOLD` changes (`narratives.ts`; ticket 01 edits `clusterNewSignals` in the same file).

**Status:** done

- [x] A fresh holdout sample is collected and labelled, separate from the 320-headline tuning sample
- [x] Precision, recall and the best threshold on the holdout are recorded in ADR 0007
- [x] `JOIN_THRESHOLD` is kept or changed on that evidence, with the calibration test matching
- [x] `pnpm check` passes

**Outcome:** 0.90 holds, unchanged. Holdout of 146 fresh headlines (339 collected on 2026-11-06, minus 193 already in the tuning sample): at 0.90, 25 of 62 same-story pairs joined (40%), 0 over-merges (precision 100%; the NPR arch/jobs bulletin joins the Guardian arch item at 0.938 but is scored as related, and counted as different it would be the only over-merge), closest wrong pair 0.859 (margin 0.041, against 0.022 on the tuning sample). Best threshold with zero over-merges on the holdout is 0.86 to 0.87 (58 of 62), with a margin of 0.001 to 0.011, so it is not clearly better. Numbers and reasoning are in ADR 0007, "Holdout check".

**Notes:**
- The worker embeds titles only (`semantic-embedder.ts`, ADR 0007), not summaries, so the holdout measures titles; the ticket's "include the summaries as the worker does" does not apply to the semantic embedder.
- Added `--sample holdout` to `scripts/measure-narrative-threshold.mjs`, a printout of the eight closest different-story pairs, and a holdout run in `pnpm verify:semantic`.

**Labelling rule** (also in `narrative-holdout-labels.json`, labelled from the headlines before any similarity was computed): two headlines are the same story when they report the same specific event or development (same actors, same occurrence, same news cycle), from any outlet or angle, so that a reader would say "that is the same news item". An update to the same event (a live blog, a follow-up with a new figure of the same event) counts when it is clearly about that one occurrence. Not same: a different development of a shared subject (a market rebound versus the earlier rout, another day's ETF figure), a reaction piece about a wider theme, or two events of one kind (two exchange hacks); those pairs are listed under `topics` as "related" and scored as neither. Every other pair is a different story. Identical titles from two feeds are the same story. Judgement calls to audit: the Binance hack group excludes the later "stolen crypto not yet laundered" piece, as the bomb-threat group excludes "Russian group denies" (later developments are related); the Trump arch / jobs report bulletin is in topics only; the "AI stocks climb" pair is its own story, not the rout.
