# 05c: Semantic embedder for Narratives
**Model:** sonnet / high — choosing a model by measurement and wiring a runtime download safely is judgement work.

**What to build:** Replace the lexical `HashingEmbedder` for Narratives with a small sentence-embedding model run in the worker process (no Ollama, no hosted API), if it measurably beats the lexical embedder on the 320-headline sample of 05b. The operator chose this over Ollama and over keeping lexical.

**Blocked by:** 05b

**Status:** done

**Outcome:** It wins. `Xenova/gte-small` (8-bit ONNX, 384 dims) at `JOIN_THRESHOLD` 0.90 merges no two labelled different stories and joins 53 of 112 same-story pairs, against 7 of 112 for the lexical embedder at its best (0.60). ADR 0007 has the table, the models compared, and the trade-offs. The worker loads the model on the first clustering pass; a missing model that cannot be fetched logs and skips clustering for that tick, never falling back to lexical. `pnpm models:fetch` pre-fetches and checksums it.

- [x] Model chosen by measurement on the same sample and labels, with the HN summary template stripped and Wired promo pages left out for both embedders; result reported either way (ADR 0007)
- [x] Package version and model revision pinned; sha-256 of every model file verified on download and on load; cache under `~/.cache/argus/models` (`ARGUS_MODEL_DIR`), never `/tmp`, the repo or a scratchpad
- [x] Worker loads lazily; offline and missing model logs and skips the tick; `verify:boot` and the dry run download nothing (tested)
- [x] `pnpm models:fetch` pre-fetches and checksums the model
- [x] Narratives record which embedder and dimension built their centroid; lexical Narratives are never joined against semantic vectors; additive, idempotent migration (tested on a pre-change database)
- [x] `JOIN_THRESHOLD` set from the measurement; the 320 sample embeddings are committed (`narrative-sample-embeddings.json`, 16-bit, 328 kB) so `pnpm check` pins the together/apart pairs offline; the Hackintosh pair and the `toBe(0.6)` test are gone
- [x] Unit tests use a fake embedder through the seam; the real-model check is the opt-in `pnpm verify:semantic`, not part of `pnpm check`
- [x] ADR 0007 written; ADR 0006 marked superseded in part
- [x] `pnpm check` and `pnpm verify:boot` pass
