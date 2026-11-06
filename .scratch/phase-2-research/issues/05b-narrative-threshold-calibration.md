# 05b: Narrative threshold calibration
**Model:** sonnet / high — measuring and judging clustering quality on real headlines is judgement work.

**What to build:** The Narrative join threshold (0.4) was taken from six hand-written headlines, never measured on a real feed. Record a real sample from the configured RSS feeds, measure the local hashing embedder on it against hand-labelled story pairs, and set the threshold from the evidence (favouring precision: an over-merged Narrative misleads the judge more than a split one). If no threshold gives acceptable precision and recall, say so and recommend an embedder rather than switching it.

**Blocked by:** 05

**Status:** done

**Decision:** the Operator chose a semantic embedder run in the worker process (not Ollama, not staying lexical); built and measured in ticket 05c (ADR 0007).

**Outcome:** No threshold is good for the hashing embedder (ADR 0006, Calibration). On 320 real headlines, 0.40 over-merges 15 Narratives (81 Signals, the largest 19) while joining 63 of 112 same-story pairs; 0.60 merges no two different news stories but joins only 16 of 112, so Narratives mostly fragment. `JOIN_THRESHOLD` is set to 0.60 as a provisional, precision-first value. The decision for the Operator: move to a local semantic embedder (Ollama `nomic-embed-text`, the first Considered Option in ADR 0006) before ticket 07, which means installing Ollama on the worker host. Cheaper fixes that help either embedder, not done here: drop the Hacker News summary boilerplate from the embedded text; skip the Wired coupon pages. Also found: `rss:verge` returned 0 items (likely an Atom feed that `RssSource` does not parse).

- [x] One poll per configured RSS feed through `RssSource` (no new fetcher); titles, Source ids and links recorded in `packages/core/src/fixtures/narrative-sample.json`
- [x] At least 40 hand-labelled pairs (same story or different story), spread across the similarity range and concentrated near the candidate thresholds (50 pairs, plus a story-group label for every item that labels all 51,040 pairs)
- [x] The sample clustered at thresholds 0.30 to 0.80 in 0.05 steps; cluster count, largest cluster, over-merges and fragmentation reported (ADR 0006)
- [x] The chosen threshold is a named constant in `narratives.ts`, with a regression test on the recorded sample (labelled same-story groups join; labelled must-not-merge pairs stay apart)
- [x] ADR 0006 carries the evidence (table, label count, chosen value, reason); the "uncalibrated" caveat is removed only if the evidence supports it (the caveat is replaced by the measured finding that the embedder is inadequate)
- [x] If no threshold is acceptable: status `needs-decision`, with the numbers and an embedder recommendation (for example local Ollama `nomic-embed-text`); the embedder is not switched here
- [x] `pnpm check` and `pnpm verify:boot` pass
