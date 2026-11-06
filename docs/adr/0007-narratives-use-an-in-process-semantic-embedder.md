# Narratives are clustered with an in-process semantic embedder (Xenova/gte-small)

Status: accepted. Supersedes the embedder choice of [ADR 0006](0006-narratives-use-a-local-hashing-embedder.md); the `Embedder` seam, the 72-hour window, the running-mean centroid and the material-change rule in 0006 stand.

ADR 0006 measured the lexical `HashingEmbedder` on 320 real headlines and found no usable threshold: either different stories merge or most of the same story splits. The Operator chose a semantic model run inside the worker process over Ollama and over staying lexical (ticket 05c). The embedder is now `Xenova/gte-small` (the ONNX export of `thenlper/gte-small`, MIT), 8-bit quantized, 384 dimensions, run by `@huggingface/transformers` 4.3.2 on `onnxruntime-node`. `HashingEmbedder` stays in the repo as an explicit development and test choice (`ARGUS_EMBEDDER=hashing`), never as a fallback.

## Measurement

Same sample and labels as ADR 0006: 320 headlines, 51,040 pairs, 112 same-story pairs in 38 hand-labelled groups (`narrative-sample.json`, `narrative-sample-labels.json`). `scripts/measure-narrative-threshold.mjs` reruns every number below. Two input changes apply to both embedders, so the lexical figures differ slightly from ADR 0006:

- The Hacker News summary template ("Article URL / Comments URL / Points / # Comments") is stripped from the embedded text (`cleanSummary`).
- Promo and coupon pages (12 Wired pages) are not skipped but "stand alone": each gets its own Narrative and never joins or is joined (`standsAlone`). Skipping would leave them unclustered, and the worker takes unclustered Signals oldest first, so they would block the queue.

The committed sample holds titles only, so this measures titles. The summary is not embedded by the semantic embedder (see Trade-offs).

"Cross-story over-merged" counts Narratives holding two Signals of different labelled stories, not counting pairs that need no shared meaning: two Hacker News items, identical titles, and the BBC programme titles "Tech Life" and "Tech Now", which differ by one word and are told apart only by summaries the sample does not hold. All of those are templated and stay out of the win criterion for both embedders.

Win criterion: a threshold with 0 cross-story over-merges that joins clearly more same-story pairs than the lexical embedder's 7 of 112 at 0.60.

Models compared, 8-bit quantized ONNX, title only, at the lowest threshold with no cross-story over-merge (and none in the next 0.05):

| Embedder | Dims | Model file | Threshold | Same pairs joined (of 112) | Groups split (of 38) | Narratives |
|---|---|---|---|---|---|---|
| lexical `HashingEmbedder` | 256 | none | 0.60 | 7 | 37 | 307 |
| **gte-small** | 384 | 34.0 MB | **0.90** | **53** | **24** | 277 |
| all-MiniLM-L6-v2 | 384 | 23.0 MB | 0.66 | 48 | 27 | 275 |
| gte-base | 768 | 110 MB | 0.90 | 42 | 29 | 282 |
| all-MiniLM-L12-v2 | 384 | 34.0 MB | 0.69 | 34 | 29 | 284 |
| bge-small-en-v1.5 | 384 | 34.0 MB | 0.82 | 28 | 30 | 289 |
| all-mpnet-base-v2 | 768 | 110 MB | 0.71 | 27 | 30 | 291 |
| e5-small-v2 ("query: " prefix) | 384 | 34.0 MB | 0.93 | 24 | 35 | 297 |

Every semantic model beats the lexical one by at least 3 times; gte-small is first. The gap between gte-small (53) and MiniLM-L6 (48) is within what a 320-headline sample can resolve, so MiniLM-L6, 11 MB smaller, is a close second and the fallback choice if size matters more than 5 pairs. gte-small was picked on the measured number.

gte-small across thresholds (production path, committed vectors):

| Threshold | Narratives | Largest | Cross-story over-merged | Same pairs joined | Groups split |
|---|---|---|---|---|---|
| 0.80 | 53 | 250 | 1 | 112 | 0 |
| 0.85 | 206 | 24 | 8 | 93 | 9 |
| 0.86 | 227 | 21 | 4 | 84 | 11 |
| 0.87 | 243 | 13 | 2 | 77 | 14 |
| 0.88 | 258 | 9 | 0 | 69 | 16 |
| 0.89 | 264 | 5 | 1 | 70 | 17 |
| **0.90** | 277 | 5 | **0** | **53** | 24 |
| 0.91 | 284 | 5 | 0 | 40 | 30 |
| 0.92 | 291 | 5 | 0 | 33 | 32 |
| 0.93 | 303 | 4 | 0 | 11 | 37 |
| 0.95 | 309 | 4 | 0 | 5 | 37 |

For comparison the lexical embedder joins 41 of 112 at 0.40 but over-merges 18 Narratives there, and 7 of 112 at 0.60 with none.

**Decision: it wins.** `JOIN_THRESHOLD` is 0.90, the lowest round value that stays at zero over-merges: 0.88 also has none and joins 69, but 0.89 merges one pair (a drifting centroid) and the closest different-story pair scores 0.878, so 0.88 is on the edge. 0.90 joins 53 of 112, 7.6 times the lexical best, with the same precision. Same-story pairs from different outlets have a median cosine of 0.90 and the closest wrong pair scores 0.878: the margin is thin, because gte-small compresses all headline similarities into 0.55 to 1. Fragmentation is reduced, not removed: 24 of 38 stories still split at 0.90, as the half of same-story pairs under 0.88 stay apart.

The threshold is specific to this model and quantization. Changing either means re-measuring (`node scripts/measure-narrative-threshold.mjs --embedder semantic`) and regenerating the committed vectors (`--write-embeddings`).

## Holdout check (ticket hardening/04, 2026-11-06)

0.90 was chosen and measured on the same 320 headlines. To test it on data it was not tuned on, `scripts/collect-narrative-sample.mjs` polled the 13 feeds once more a day later (339 items); the 193 already in the tuning sample (same Source and title, or same link) were dropped, leaving **146 fresh headlines** (`narrative-holdout.json`, vectors in `narrative-holdout-embeddings.json`, labels in `narrative-holdout-labels.json`). I labelled them from the headlines alone, before any similarity was computed, by the rule written in the labels file: same story means the same specific event from any outlet or angle; a different development of a shared subject (a market rebound versus the earlier rout, another day's ETF figure) is only "related" and scored as neither. That gave 14 stories and 68 same-story pairs. The embedder reads titles only (`semantic-embedder.ts`), so the holdout is titles only too. Reproduce with `node scripts/measure-narrative-threshold.mjs --sample holdout --embedder fixture`.

At the shipped `JOIN_THRESHOLD` 0.90:

| | Holdout (146 headlines) | Tuning sample (320) |
|---|---|---|
| Same-story pairs joined (recall) | 25 of 68 (37%) | 53 of 112 (47%) |
| Different-story pairs joined / cross-story over-merges (precision) | 0 / 0 (100%) | 0 / 0 |
| Groups split | 8 of 14 | 24 of 38 |
| Closest different-story pair | 0.859 (margin 0.041) | 0.878 (margin 0.022) |
| Median cosine of same-story pairs | 0.90 | 0.90 |

Across thresholds on the holdout, over-merges appear at 0.85 and below (6 Narratives at 0.85, and the whole sample collapses into a few large Narratives below 0.83 as the running-mean centroid drifts) and are zero from 0.86 up. Recall at zero over-merges peaks at 0.86 and 0.87 (60 of 68), then falls to 34 at 0.88 and 25 at 0.90. The best threshold on this sample is therefore 0.86 to 0.87, but 0.86 sits 0.001 above the closest wrong pair, so it is on the edge; 0.87 has a margin of 0.011.

**Decision: 0.90 holds, unchanged.** On data it was not tuned on it makes no wrong join, and its margin to the closest wrong pair (0.041) is wider than it was on the tuning sample (0.022). The holdout does not show 0.90 to be wrong; it shows it to be conservative: recall is lower (37%, against 47%) and a threshold near 0.87 would have joined about 2.4 times as many pairs here. That is not a reason to move it. The two samples put the first over-merge at different places (0.89 on the tuning sample, 0.85 on the holdout), so the safe zone differs by sample, and a lower value would be tuned to 146 headlines whose recall is dominated by one nine-headline story (Cybertruck, 36 of the 68 pairs). Precision, the property a wrong join costs most, is what 0.90 buys, and it is the property the holdout confirms.

Caveats: the holdout is small, taken one day after the tuning sample from the same 13 feeds, so it shares the news cycle (AI-stock rout, midterms, crypto selloff) and is not independent in time; its labels are my judgement on the stated rule, kept in the fixture for audit. Re-run it, and collect a larger sample from a later week, before changing the feed set or the model.

## How it runs

- **In process.** `apps/worker/src/semantic-embedder.ts` loads the model with `@huggingface/transformers` on the first clustering pass and embeds each Signal's title (pooling: mean, L2-normalized). Load takes about 0.5 s and the process then holds about 215 MB resident. Embedding costs about 9 ms per headline on this machine (2 intra-op threads), so a 5-minute ingest tick with a hundred new Signals spends about one second of CPU; a backlog of the 500-Signal batch takes about five seconds.
- **Offline-safe.** If the model files are missing, the worker downloads them once, then verifies. If that fails (offline, 404, bad checksum) it logs `cluster: skipped, semantic model unavailable: ...`, stores Signals as usual, and tries again on the next ingest tick. It never crashes and never falls back to the lexical embedder. A dry run never reaches clustering, so `verify:boot` and the dry run download nothing (both tested).
- **Pinned and checked.** Package `@huggingface/transformers` 4.3.2 (exact). Model `Xenova/gte-small` at commit `5927d1727bb12db490052a1b33265ad78058de08`; `config.json`, `tokenizer.json`, `tokenizer_config.json` and `onnx/model_quantized.onnx` each pinned by size and sha-256 in `SEMANTIC_MODEL`, and verified after download and again at every load. transformers.js itself is set to local files only, so `fetchModel` is the one thing in the worker that reaches huggingface.co.
- **Cache.** `~/.cache/argus/models/<repo>/` (34 MB), moved by `ARGUS_MODEL_DIR`; never `/tmp`, the repo or a scratchpad. `pnpm models:fetch` pre-fetches and prints the checksums, so a deployment can fetch once, ahead of the first tick. `ARGUS_MODEL_HOST` points the download at a mirror (tests use it).
- **Embedder recorded per Narrative.** `narratives.embedder` (here `Xenova/gte-small@5927d17:q8`) and `narratives.dimension` are stored with the centroid. Clustering joins a Signal only to Narratives of its own embedder and dimension, so no vector of one embedder is ever compared with another's. The migration is additive and idempotent; existing rows get `hashing-v1` and 256, which is what built them. Existing lexical Narratives are left alone, stop being joined, and age out of the 72-hour window; Signals already in them are not re-clustered.

## Trade-offs

- **A runtime download from huggingface.co.** The first clustering pass (or `pnpm models:fetch`) fetches 34 MB from a third-party host. It is pinned to a commit and checked against sha-256 values committed here, so a changed or tampered file is rejected, but the host must be reachable once, and the Operator trusts that the pinned revision is what it was when measured. After that there is no network use for embedding.
- **Install size.** `@huggingface/transformers` brings `onnxruntime-node` (about 288 MB in `node_modules`, because it ships binaries for every platform; the Linux x64 CPU library is 45 MB), `onnxruntime-web` (139 MB, unused on Node but a hard dependency), `sharp` (its libvips is 18 MB) and the library itself (10 MB): roughly 455 MB on disk against 874 MB for the whole repo today. The model adds 34 MB.
- **Build scripts.** pnpm 11 asks for approval of `onnxruntime-node` and `protobufjs` install scripts. Both are set to `false` in `pnpm-workspace.yaml`: the onnxruntime script only fetches optional GPU libraries, and the CPU binaries ship in the package (verified: the model loads and runs with the scripts off).
- **CPU and memory.** About 9 ms per headline and 215 MB resident once loaded, on the worker host that also runs Builds. Cheap per tick, but not free the way hashing was.
- **Titles only.** The semantic embedder reads the title and ignores the summary. The calibration sample holds titles, so the threshold is measured on exactly what is embedded; RSS summaries are mostly markup, boilerplate or a repeat of the title. The cost is that a vague title ("Tech Life") cannot be told from another by its summary. Embedding title and summary needs a fresh sample that keeps summaries, and a new measurement. (The lexical embedder still reads both, with the Hacker News template removed.)
- **Tests stay offline.** `pnpm check` never loads the model or touches the network. Unit tests drive clustering through the `Embedder` seam with fakes. The 320 sample embeddings are committed as `narrative-sample-embeddings.json` (16-bit integers in base64, 328 kB, error about 1.5e-5 per number), and the calibration test pins which labelled pairs join and stay apart at `JOIN_THRESHOLD` from those. `pnpm verify:semantic` is the opt-in check that the real model still produces the committed vectors (worst cosine 1.00000 today).
- **A new embedder means a new threshold and a restart of Narratives.** The stored `embedder` makes the change safe, not free: old Narratives stop being joined, so the War Room briefly shows the lexical Narratives next to semantic ones until the old ones age out.

## Considered Options

- **Ollama `nomic-embed-text` (ADR 0006's first option).** A separate server the Operator must install and keep running, with the worker as its client. The Operator preferred an in-process model: nothing outside this repo to install, and one process to supervise.
- **A hosted embeddings API.** Rejected as in ADR 0006: a new paid account and a network call per Signal.
- **Keep the lexical embedder.** Rejected by the measurement: 7 of 112 same-story pairs at zero over-merges.
- **all-MiniLM-L6-v2 instead of gte-small.** Close (48 versus 53 pairs, 23 MB versus 34 MB) and the natural swap if the model's size matters; within the noise of this sample.
- **Larger models (gte-base, all-mpnet-base-v2).** No better on this sample (42 and 27 pairs), three times the size and about three times the CPU.

## Consequences

- Narratives join the same story across outlets for about half of the labelled pairs, with the precision of the old 0.60 setting; ticket 07's judge sees fewer near-duplicate Narratives, and the new-Source test for a material change can fire.
- The threshold has a thin margin and was set on one sample taken on one day. Re-run the measurement when feeds are added, and consider a fresh sample with summaries before relying on 0.90 for a feed set that differs from today's.
- The War Room and the datastore are unchanged apart from the two new `narratives` columns.
