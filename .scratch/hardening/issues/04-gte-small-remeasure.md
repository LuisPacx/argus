# 04: Re-measure gte-small on a fresh holdout sample
**Model:** sonnet / medium — a measurement and a constant; no new feature.

**What to build:** The Narrative join threshold `JOIN_THRESHOLD` 0.90 for gte-small (ticket 05c) was tuned on the same 320-headline sample it was measured on, with a margin of 0.886, and with no holdout. Collect a fresh, separate sample of real headlines (`scripts/collect-narrative-sample.mjs`), label it, include the Signal summaries in the embedded text as the worker does, and run `scripts/measure-narrative-threshold.mjs` on it as a holdout. Report precision and recall at 0.90 and the best threshold on the holdout. Change `JOIN_THRESHOLD` only if the holdout clearly says 0.90 is wrong (state the numbers); otherwise keep it and record the holdout result.

**Files:** `scripts/collect-narrative-sample.mjs`, `scripts/measure-narrative-threshold.mjs`, `packages/core/src/fixtures/narrative-sample*.json` (add `narrative-holdout*.json` beside them, do not overwrite), `packages/core/src/narratives.ts` (the constant only, if it changes), `packages/core/src/narrative-calibration.test.ts`, `docs/adr/0007-narratives-use-an-in-process-semantic-embedder.md` (record the holdout numbers).

**Blocked by:** none. No file overlap with tickets 01 to 03 unless `JOIN_THRESHOLD` changes (`narratives.ts`; ticket 01 edits `clusterNewSignals` in the same file).

**Status:** open

- [ ] A fresh holdout sample is collected and labelled, separate from the 320-headline tuning sample
- [ ] Precision, recall and the best threshold on the holdout are recorded in ADR 0007
- [ ] `JOIN_THRESHOLD` is kept or changed on that evidence, with the calibration test matching
- [ ] `pnpm check` passes
