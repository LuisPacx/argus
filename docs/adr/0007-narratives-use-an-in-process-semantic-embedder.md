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

0.90 was chosen and measured on the same 320 headlines. To test it on data it was not tuned on, `scripts/collect-narrative-sample.mjs` polled the 13 feeds once more a day later (339 items); the 193 already in the tuning sample (same Source and title, or same link) were dropped, leaving **146 fresh headlines** (`narrative-holdout.json`, vectors in `narrative-holdout-embeddings.json`, labels in `narrative-holdout-labels.json`). I labelled them from the headlines alone, before any similarity was computed, by the rule written in the labels file: same story means the same specific event from any outlet or angle; a different development of a shared subject (a market rebound versus the earlier rout, another day's ETF figure) is only "related" and scored as neither. That gave 13 multi-headline stories and one singleton (the Trump arch ruling, found once in the labelled set), with 62 same-story pairs. Later developments of an event ("Russian group denies sending the hoax bomb threats", "stolen Binance crypto not yet laundered") are labelled related, like the ETF figures; both score under 0.90, so the result does not depend on that call. The embedder reads titles only (`semantic-embedder.ts`), so the holdout is titles only too. Reproduce with `node scripts/measure-narrative-threshold.mjs --sample holdout --embedder fixture`.

At the shipped `JOIN_THRESHOLD` 0.90 (the "0 over-merges" below is with one labelled exception: the NPR bulletin "Judge halts construction of Trump's arch. And, Labor Department to release jobs report" and the Guardian's "Federal judge temporarily halts building work on Trump's triumphal arch" score 0.938, so they do join. The bulletin covers two stories, so it is excluded from scoring as related; its lead item is the same story as the Guardian's, and counted as a different story it would be the holdout's only over-merge):

| | Holdout (146 headlines) | Tuning sample (320) |
|---|---|---|
| Same-story pairs joined (recall) | 25 of 62 (40%) | 53 of 112 (47%) |
| Different-story pairs joined / cross-story over-merges (precision) | 0 / 0 (100%) | 0 / 0 |
| Groups split | 7 of 13 | 24 of 38 |
| Closest different-story pair | 0.859 (margin 0.041) | 0.878 (margin 0.022) |
| Median cosine of same-story pairs | 0.91 | 0.90 |

Across thresholds on the holdout, over-merges appear at 0.85 and below (6 Narratives at 0.85, and the whole sample collapses into a few large Narratives below 0.83 as the running-mean centroid drifts) and are zero from 0.86 up. Recall at zero over-merges peaks at 0.86 and 0.87 (58 of 62), then falls to 32 at 0.88 and 25 at 0.90. The best threshold on this sample is therefore 0.86 to 0.87, but 0.86 sits 0.001 above the closest wrong pair, so it is on the edge; 0.87 has a margin of 0.011.

**Decision: 0.90 holds, unchanged.** On data it was not tuned on it makes no wrong join, and its margin to the closest wrong pair (0.041) is wider than it was on the tuning sample (0.022). The holdout does not show 0.90 to be wrong; it shows it to be conservative: recall is lower (40%, against 47%) and a threshold near 0.87 would have joined about 2.3 times as many pairs here. That is not a reason to move it. The two samples put the first over-merge at different places (0.89 on the tuning sample, 0.85 on the holdout), so the safe zone differs by sample, and a lower value would be tuned to 146 headlines whose recall is dominated by one nine-headline story (Cybertruck, 36 of the 62 pairs). Precision, the property a wrong join costs most, is what 0.90 buys, and it is the property the holdout confirms.

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

## Amendment 2026-11-14: launchpad Signals are grouped by token name and are not embedded; every Narrative has a size bound (viral sources ticket 01)

The decision above stands for news. It failed for the pump.fun stream (Source `pumpportal:events`: creates and bonds), and the Operator asked for it to be fixed (viral sources ticket 01, with the Jensen/Nvidia miss of 2026-11-12 folded in: `.scratch/missed-ideas/2026-11-12-nvidia-ceo/internal-trace.md`).

**What failed, measured on `.backup` copies of 2026-11-11 and 2026-11-14.** Every create is the title `New token on pump.fun: <name> ($<ticker>)` and the model embeds the title. The constant template outweighs a one- or two-word name (0.956 to 0.972 against the catch-all's centroid whatever the name), and a running-mean centroid over tens of thousands of near-identical vectors converges on the template, so nearest-centroid sends every create to it. By 2026-11-14 Narrative 351 held 65,189 of 70,098 launchpad Signals, 353 held 4,305 (every bond) and 851 held 589. A Narrative had no size bound and every join refreshed `last_signal_at`, so the window never closed on it. All 911 Nvidia, Jensen and Huang creates of 2026-11-05 to 11-12 sat in 351, which is judged once per doubling of its size (next at 65,536) and shown to the judge as 15 arbitrary launches.

**Decision.**

1. **Launchpad Signals are not embedded at all.** `clusterNewSignals` hands a create or a bond to `placeLaunchpadSignal` (`launchpad-cluster.ts`) before it would call the embedder. A create reads its token back out of the stored title (`launchpad-subject.ts`, the template constants now exported by `sources/pumpportal.ts` so writer and reader cannot drift), builds the name key and the ticker key with ticket 03's normaliser (`meta/key.ts`, `isGenericKey` from `meta/group.ts`), and joins the Narrative that holds one of them, same kind first (name to name, ticker to ticker, then across), if that Narrative is recent (the 72 h window) and under the size bound. Otherwise it starts a Narrative and claims its own two keys. The claims are a table, `narrative_keys (role, key, narrative_id)`, written in the same transaction as the Narrative; the latest claimant of a key wins, which is how a successor takes over from a full or quiet Narrative. A Narrative holds only the keys of its first Signal, so a copycat with an unrelated ticker cannot pull later tokens with that ticker into the wrong Narrative.
2. **Why not an embedding of the name, and why not ticket 03's groups.** Nearest-neighbour test on the creates that started a Narrative by keys (21,031; 2,537 sampled, each against every earlier such name, real model, `Name ($TICKER)` as the text): 169 had a neighbour at 0.97 or more, nearly all of them exact repeats of names the stoplist excludes on purpose (`Memecoin`, `Test`, `Meme`); 124 at 0.95 to 0.97 (`Pengi`/`Pengu`, but also the nameless `4muC...Loat` against `4mhu...Loat`, which are abbreviated mints); 300 at 0.93 to 0.95 (`Lovecoin`/`Love Coin`, but `DUMB`/`IDIOT`); 937 between 0.90 and 0.93 (`Fat Dog`/`Fat Cat`, `Spaceship`/`Starship`, `Coral`/`Reef`). No threshold separates them, which is what ADR 0012 found for Meta themes, and a centroid per name would drift again. Ticket 03's `groupTokens` was measured as well: its union-find chains name and ticker pairs, so on the 2026-11-14 copy one group holds 2,036 creates labelled `Jensen Hung` (key `trump`: `Jensen Huang ($TRUMP)` bridges the Jensen tokens and the Trump tokens) and another 3,374. That is right for counting a Meta and wrong for a Narrative, which the judge reads as one subject; so the normaliser and the stoplist are shared and the chaining is not.
3. **A bond follows its create.** A bond carries only the mint (`Bonded on pump.fun: 9oD9...pump`). It joins its create's Narrative when that is a launchpad Narrative under the bound; otherwise it takes its create's subject (the stored create Signal, else the Study's `study_tokens` row for the mint) and goes through 1. A bond whose create nobody knows (1,011 of 4,305 in the copy) stands alone, as does a token with no name, a name made only of generic words or a title that is only a mint: a Narrative of one that nothing joins, so no catch-all can form.
4. **A size bound on every Narrative**, `ClusterConfig.maxNarrativeSignals`, default `MAX_NARRATIVE_SIGNALS` 2,000 (`narratives.ts`, beside `JOIN_THRESHOLD`). A full Narrative is not joinable (news and launchpad alike) and the next matching Signal starts a successor. The largest Narrative of the replay below holds 1,582 and the next 369, so the bound only ever binds on a spam wave; `last_signal_at` alone can no longer keep a flooded Narrative open.
5. **A cross-Source rule, narrow on purpose** (`crossSourceTarget`). A Signal that did not join a news Narrative (so news clustering is untouched) may join a launchpad Narrative: a DexScreener token by its name key (a shared ticker such as `STM` or `BOOM` joins unrelated tokens, a shared name does not); a headline or Trends query by a phrase that is one of the Narrative's keys. A phrase is two or three words, at least two of them neither stopwords nor generic keys, or a single word of 4 or more letters written with a capital inside a sentence-case headline, that the model's vocabulary does not hold as one piece (`Embedder.isCommonWord`: `moon`, `zero`, `poland` are one piece, `misu`, `melania`, `mexc` are split). The Narrative needs at least 3 Signals (`crossMinSignals`), the phrase may appear in at most 5 recent non-launchpad Signals (`crossMaxDocFreq`, itself counted), and a headline that matches two different Narratives joins neither. Measured by replay, then read by hand: 79 non-launchpad Signals joined a launchpad Narrative, 26 DexScreener tokens (the same name as a token Narrative: `LUCIA`, `Gigahug`, `FOMO`) and 53 headlines. Of the 53, 52 name a real subject of the Narrative they joined (`MEXC`, `SpaceX`, `Pete Hegseth` x5, `David Walliams` x6, `OpenAI` x4, `Blue Wave` x4, `Colette Kress`, `Tim Cook`, `Anthropic`, `DeepSeek`, `ChatGPT`) and one does not (`Don't buy AR glasses`, joined to a token named `DONT BUY`). The first version of the rule, with no capitalisation, Title Case or lower-case guards and DexScreener matched by ticker too, made 90 headline and 44 DexScreener joins on the same data, among them `parity`, `afloat`, `kraken`, `coon`, `beep`, `whit` and `STM`/`BOOM`/`BIG` tickers shared by unrelated tokens; the guards removed those. No dictionary stands behind it, only the model's vocabulary (`parity` and `afloat` are split by it, so a Title Case guard has to catch them), so expect the occasional wrong join on a headline that is neither Title Case nor lower case.
6. **The recorded embedder id does not change.** The ticket suggested it as a side effect of embedding the subject; there is no embedding now, and the judge and propose selections filter on `narratives.embedder`, so launchpad Narratives record the current embedder id and dimension and stay judgeable. They are told apart by the new `narratives.kind` column (`launchpad`; every earlier row defaults to `news`). A launchpad Narrative has an empty centroid, so a day's 4,000 new Narratives cost no centroid storage, and `recentNarratives` loads news Narratives only.

**Replay** (`pnpm replay:launchpad`, opt-in; the real model; the 75,854 Signals of the 2026-11-14 copy in published order, 400 per pass, into a throwaway datastore; ~6 min):

| | Before (the live database of 2026-11-14, the same Signals, the code of `main`) | After (the replay) |
|---|---|---|
| Narratives | 4,170 | 28,279 (24,228 launchpad, 4,051 news) |
| Largest Narrative | 65,189 (351) | 1,582 (one spam name written in 116 ways) |
| Share of the 70,098 launchpad Signals in the top 3 Narratives | 99.98% (351, 353 and 851 hold 70,081) | 3.3% (the next two hold 369 and 367) |
| Misu (9 creates and the bond) | 9 creates in 351, the bond in 353 | one Narrative of 10 Signals with nothing else in it |
| Jensen/Nvidia launches (1,133 creates matching `nvidia\|nvda\|jensen\|huang\|kress\|nvidi`, 412 of them on 2026-11-12) | 1,117 in 351, 16 in 851 | none in the largest Narrative; 286 Narratives hold them, 131 of one Signal and 155 of two or more, 18 holding 10 or more of them: `GPU Daddy ($JENSEN)` 97 of 102, `jensen hung ($HUNG)` 69 of 100, `No Value Dog Asset ($NVDA)` 70 of 72, `NVIDIOT` 62 of 64, `Alice Huang ($ALICE)` 47 of 78, `Jensen Huang ($JH)` 46 of 49, `Daddy Huang ($Huang)` 42, `Jensen Huang Memes ($JHM)` 35 of 36, `Colette Kress ($Kress)` 29 of 30; the mint `dS222UNv...` (NVIDIHIA, 14:51Z) sits in `NVIDIHIA ($NVIDIHIA)` with 6 other tokens |

Launchpad Narratives that reached 2, 5 and 10 Signals each day (2026-11-07 to 11-12): 857 to 1,487 reached 2, 295 to 530 reached 5, 132 to 247 reached 10. Of the 60 largest launchpad Narratives, 29 are one name written many ways, 29 are one ticker carried by many names (a spam wave such as `DacityCoin`, `FOMO`, `ANSEM`, `ELON` is one subject; `Stock Inu ($SI)`, `GPU ($GPU)`, `Gangsters take all ($GTA)` and `The Nvidia Spy ($SPY)` mix unrelated names that share a short ticker) and 2 are mixed. News: the 320-headline and 146-headline measurements give exactly the numbers above (277 clusters, 53 of 112 same-story pairs, no cross-story over-merge at 0.90; 127 clusters and 25 of 62 on the holdout), and over the whole replay the news Narratives come out as the live database has them for 685 of 723 groups of two or more Signals (94.7%; the rest differ by the order Signals arrived in, which the ticket's Comments measure against the same replay under the code of `main`).

**Deploy.** New Signals only. The columns and the table are additive and idempotent. 351, 353, 851 and the other old Narratives keep their Signals, are `news` kind and are never joined by a launchpad Signal; they stop growing at once, leave the 72 h window and are not judged again unless they change. No backfill: the replay script is the clustering on a copy and is not meant for the live file (it refuses it). Judge selection is unchanged, so what changes is how much it is asked: see the ticket's Comments for the estimate against the caps.

**Trade-offs.** Roughly 4,000 Narratives a day are created, three quarters of them of one Signal (the judge ignores them; the `newest` sort of the War Room list is flooded by them, and `score` and `signals` are not). Names that share neither a key nor a ticker never meet: `Jensen Huang Coin` and `Daddy Huang` are two Narratives, as the Meta ranking joins them by theme (ADR 0012) and a Narrative does not. A shared short ticker mixes subjects (`Stock Inu ($SI)` holds `Slow Inu`, `Spy Inu`, `Space Inu`); that is the price of treating a ticker as a subject, and a spam wave under one ticker is one Narrative. The cross-Source rule has no dictionary behind it, only the model's vocabulary, so it errs both ways (see its measured list in the ticket).
