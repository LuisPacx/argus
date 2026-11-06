# Narratives are clustered with a local hashing embedder, behind an Embedder seam

Signals are grouped into Narratives by cosine similarity of an embedding of each Signal's text (the approach of helios `embedding.ts` and `clustering.ts`). The embedder is `HashingEmbedder` in `packages/core/src/narratives.ts`: lowercased words of three or more letters, stopwords and a plural or past-tense ending dropped, each word hashed (FNV-1a) into a 256-wide vector, title words counted double, L2-normalized. It is deterministic, has no dependency, makes no network call and costs nothing, so ingestion stays free of Brain and LLM calls and tests need no fixtures beyond the Signals themselves.

A new Signal (oldest first, by published time then id) joins the most similar Narrative that gained a Signal within the last 72 hours when the cosine to that Narrative's centroid is at least 0.4, else it starts a new Narrative. The centroid is the running mean of its members. The threshold, window and batch size are `ClusterConfig` in the same file. **The 0.4 threshold is uncalibrated.** It comes from six hand-written fixture headlines, where it sits between the same-story pairs (0.63 to 0.81) and unrelated pairs (0.00 to 0.14); no real feed was measured. Helios used 0.80 on the same kind of lexical embedder and still fragmented Events, so 0.4 is not evidence of a good setting. The crypto feeds (Cointelegraph, Decrypt, The Block) share vocabulary heavily ("bitcoin", "token", "market", "price"), so 0.4 may over-merge them into a few large Narratives. Tuning the threshold on real feeds (or moving to a semantic embedder) is follow-up work and must happen before Narratives feed the judge. Helios dropped near-duplicate handling here because Signals are already deduplicated by id on ingest.

A Narrative "changes materially" (`changed_materially_at`, the input for the judge delta in ticket 07) when it is created, when a Signal joins from a Source the Narrative had not heard from, or when its Signal count has doubled since the last material change. Other joins update `last_signal_at` only.

`created_at`, `last_signal_at` and `changed_materially_at` are the time of the clustering pass, not the Signals' publish times. The War Room's Narrative age is therefore the time since the Narrative was clustered, and the 72 hour window counts from the last pass that added a Signal. Signals found late (a feed with old items, or a long worker outage) look new until they age out.

Both the embedder and the model behind it are replaceable: `Embedder.embed` is async, so a model-backed embedder fits without touching clustering.

## Considered Options

- **Local semantic model (Ollama `nomic-embed-text`), as helios ADR 0013 chose.** Differently-worded headlines about one story land close together, which the hashing embedder cannot do (it sees shared words, not meaning). Free, but the Operator must install Ollama and pull a model, and a local model sits on the ingest path. Not chosen for now: it needs setup outside this repo and cannot run in `pnpm check`. It is the upgrade if real feeds fragment (the helios symptom was 1,093 Signals becoming 972 Events).
- **Hosted embeddings (OpenAI, Voyage).** Better quality, but a new paid API and account and a network call per Signal. Rejected; it would need the Operator's decision.
- **Ask the Brain to cluster.** Rejected: ingestion makes no Brain calls, and it spends subscription usage on every tick.
- **Hashing embedder (chosen).** Simplest option that meets the acceptance criteria.

## Consequences

- Clustering is deterministic: the same Signals give the same Narratives in any ingest order.
- Quality is lexical. Two outlets covering one story in different words may form two Narratives, and unrelated stories that share common words may merge. Tune `joinThreshold`, or swap in a semantic embedder.
- Stored centroids are only comparable within one embedder. Swapping the embedder means re-clustering: clear `narratives` and `signals.narrative_id`.
- A Signal belongs to at most one Narrative (`signals.narrative_id` is a single column); Narratives are never merged or split in v1.
