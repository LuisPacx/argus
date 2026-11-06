# Narratives are clustered with a local hashing embedder, behind an Embedder seam

Signals are grouped into Narratives by cosine similarity of an embedding of each Signal's text (the approach of helios `embedding.ts` and `clustering.ts`). The embedder is `HashingEmbedder` in `packages/core/src/narratives.ts`: lowercased words of three or more letters, stopwords and a plural or past-tense ending dropped, each word hashed (FNV-1a) into a 256-wide vector, title words counted double, L2-normalized. It is deterministic, has no dependency, makes no network call and costs nothing, so ingestion stays free of Brain and LLM calls and tests need no fixtures beyond the Signals themselves.

A new Signal (oldest first, by published time then id) joins the most similar Narrative that gained a Signal within the last 72 hours when the cosine to that Narrative's centroid is at least `JOIN_THRESHOLD` (0.6, see Calibration), else it starts a new Narrative. The centroid is the running mean of its members. The threshold, window and batch size are `ClusterConfig` in the same file. Helios dropped near-duplicate handling here because Signals are already deduplicated by id on ingest.

A Narrative "changes materially" (`changed_materially_at`, the input for the judge delta in ticket 07) when it is created, when a Signal joins from a Source the Narrative had not heard from, or when its Signal count has doubled since the last material change. Other joins update `last_signal_at` only.

`created_at`, `last_signal_at` and `changed_materially_at` are the time of the clustering pass, not the Signals' publish times. The War Room's Narrative age is therefore the time since the Narrative was clustered, and the 72 hour window counts from the last pass that added a Signal. Signals found late (a feed with old items, or a long worker outage) look new until they age out.

Both the embedder and the model behind it are replaceable: `Embedder.embed` is async, so a model-backed embedder fits without touching clustering.

## Calibration (ticket 05b)

The first threshold, 0.4, was taken from six hand-written fixture headlines. It was then measured on one real poll of the 13 configured feeds: 320 Signals (the Verge returned none, see below), 51,040 pairs, recorded as `packages/core/src/fixtures/narrative-sample.json` (titles, Source ids and links). Every item was hand-assigned to one of 38 same-story groups or left alone, with wider shared subjects marked "related" and scored as neither right nor wrong (`narrative-sample-labels.json`). That labels all pairs: 112 same-story, the rest different or related. A stratified 50 of them (25 same, 18 different, 7 related, spread from 0.1 to 0.8 similarity and concentrated at 0.3 to 0.6) were checked by hand pair by pair against the group labels. `scripts/measure-narrative-threshold.mjs` reruns the table; `scripts/collect-narrative-sample.mjs` records a sample.

Production embeds title and summary; only the titles are committed, so the table below was run on the live poll with summaries (not committed) and the second table is the committed, reproducible title-only run. Over-merged is a Narrative holding two different-story Signals. "Same pairs joined" is out of 112. "Templated" counts wrong joins that need no shared meaning: two Hacker News items (their summaries are all "Article URL, Comments URL, Points, # Comments"), two Wired coupon pages, or identical titles (BBC "Tech Life" and "Tech Now" episodes).

Title and summary, as production runs it:

| Threshold | Narratives | Largest | Over-merged (Signals) | Same pairs joined | Different pairs joined (templated + other) | Story groups split (of 38) |
|---|---|---|---|---|---|---|
| 0.30 | 117 | 21 | 35 (202) | 80 | 840 (231 + 609) | 13 |
| 0.35 | 177 | 18 | 25 (131) | 73 | 434 (231 + 203) | 13 |
| 0.40 | 210 | 19 | 15 (81) | 63 | 312 (249 + 63) | 18 |
| 0.45 | 236 | 16 | 7 (51) | 55 | 225 (198 + 27) | 21 |
| 0.50 | 265 | 14 | 5 (32) | 35 | 130 (121 + 9) | 29 |
| 0.55 | 284 | 7 | 5 (21) | 24 | 43 (43 + 0) | 32 |
| **0.60** | 298 | 4 | 4 (11) | 16 | 11 (11 + 0) | 34 |
| 0.65 | 312 | 2 | 1 (2) | 6 | 1 (1 + 0) | 35 |
| 0.70 | 316 | 2 | 1 (2) | 2 | 1 (1 + 0) | 38 |
| 0.75 | 319 | 2 | 0 (0) | 1 | 0 | 38 |
| 0.80 | 319 | 2 | 0 (0) | 1 | 0 | 38 |

Title only (the committed fixture, `node scripts/measure-narrative-threshold.mjs`): Narratives 164, 203, 242, 269, 277, 291, 298, 300, 303, 307, 310 and same pairs joined 60, 55, 41, 24, 21, 13, 7, 6, 6, 3, 1 at 0.30 to 0.80. The identical-title episodes cannot be told apart on titles alone, so over-merges never reach zero there (4 clusters at 0.60, all templated); at 0.55 it also joins a Hacker News headline ("The Hackintosh Reborn") to a Paraguay Narrative through a hash collision, which 0.60 does not.

Findings:

- **No threshold is good for this embedder.** Same-story pairs from different outlets have a median cosine of 0.43 (0.35 on titles), with a tenth below 0.24; different-story pairs have a 99th percentile of 0.31 but a tail up to 0.74. At 0.40, where over half of same-story pairs join, 15 Narratives hold unrelated stories and the largest has 19 Signals. At 0.60 no two different news stories merge (only templated pages do) but only 16 of 112 same-story pairs join and 34 of the 38 groups are split. Between them there is no value that keeps both.
- Most wrong joins at the lower thresholds are templated, not shared vocabulary: of 312 wrong pairs at 0.40, 171 are two Hacker News items, 66 two coupon pages and 12 identical titles; only 63 are two different news stories. The crypto feeds' shared vocabulary was less of a problem than the HN summary boilerplate and the 256-wide hash (a short headline shares a bucket with an unrelated one).
- Fragmentation is the failure that remains: the same story from BBC, NPR, the Guardian and Cointelegraph reaches 0.50 to 0.65, so any threshold that keeps unrelated headlines apart splits most of them. This is the helios result (0.80 on the same kind of embedder still fragmented).

**Decision.** `JOIN_THRESHOLD` is 0.60: the lowest value at which no two different news stories merge, favouring precision because an over-merged Narrative misleads the judge more than a split one. It is provisional. At 0.60 a Narrative is mostly one Signal, so the judge would score near-duplicates separately and the new-Source test for a material change rarely fires. The caveat that the lexical embedder is inadequate stands, and ticket 05b is `needs-decision`: moving to a local semantic model (Ollama `nomic-embed-text`, the first Considered Option) is recommended before ticket 07. The embedder was not changed here. Cheap input fixes that would help either embedder: drop the Hacker News summary boilerplate from the embedded text and skip the Wired coupon pages. Not done here.

Also found while sampling: the Verge feed (`rss:verge`) returned 0 items. `RssSource` reads RSS `<item>` elements only, and the Verge feed is, as far as we know, Atom (`<entry>`); the response was not inspected, to keep to one poll per feed. Worth its own ticket.

## Considered Options

- **Local semantic model (Ollama `nomic-embed-text`), as helios ADR 0013 chose.** Differently-worded headlines about one story land close together, which the hashing embedder cannot do (it sees shared words, not meaning). Free, but the Operator must install Ollama and pull a model, and a local model sits on the ingest path. Not chosen for now: it needs setup outside this repo and cannot run in `pnpm check`. It is the upgrade if real feeds fragment (the helios symptom was 1,093 Signals becoming 972 Events).
- **Hosted embeddings (OpenAI, Voyage).** Better quality, but a new paid API and account and a network call per Signal. Rejected; it would need the Operator's decision.
- **Ask the Brain to cluster.** Rejected: ingestion makes no Brain calls, and it spends subscription usage on every tick.
- **Hashing embedder (chosen).** Simplest option that meets the acceptance criteria.

## Consequences

- Clustering is deterministic: the same Signals give the same Narratives in any ingest order.
- Quality is lexical, and measured (see Calibration): two outlets covering one story in different words usually form two Narratives, because the threshold that keeps unrelated headlines apart is above most same-story similarities. Swap in a semantic embedder rather than tuning `joinThreshold` further.
- Stored centroids are only comparable within one embedder. Swapping the embedder means re-clustering: clear `narratives` and `signals.narrative_id`.
- A Signal belongs to at most one Narrative (`signals.narrative_id` is a single column); Narratives are never merged or split in v1.
