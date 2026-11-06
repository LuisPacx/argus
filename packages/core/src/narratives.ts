import type { Datastore, StoredSignal } from "./datastore.ts";

/** A fixed-length numeric vector for a Signal's text. Related Signals point the same way (ported from helios). */
export type Embedding = number[];

/**
 * Turns a Signal's text into an Embedding. Async so a model-backed embedder can replace the default without touching
 * clustering (docs/adr/0006-narratives-use-a-local-hashing-embedder.md). Never calls the Brain.
 */
export interface Embedder {
  embed(signal: Pick<StoredSignal, "title" | "summary">): Promise<Embedding>;
}

const DIMS = 256;
const STOPWORDS = new Set(
  "the and for are but not you all can had her was one our out has have this that with from they will would there their what about which when your said than them been were into more other some could after over also how why who its new says say amid as at by in is it of on or to an a be he she we us".split(" "),
);

/** Lowercased words of 3+ letters, stopwords dropped, a plural or past-tense ending stripped. */
function tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    const suffix = ["ing", "ed", "es", "s"].find((s) => raw.length >= s.length + 4 && raw.endsWith(s));
    out.push(suffix ? raw.slice(0, -suffix.length) : raw);
  }
  return out;
}

/** FNV-1a, 32 bit. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic, dependency-free bag-of-words embedder (helios `HashingEmbedder`): each word is hashed into a fixed-width
 * vector, title words count double, and the vector is L2-normalized. Related headlines share words, so their vectors
 * point the same way. It has no notion of meaning, only shared words.
 */
export class HashingEmbedder implements Embedder {
  async embed(signal: Pick<StoredSignal, "title" | "summary">): Promise<Embedding> {
    const vec = new Array<number>(DIMS).fill(0);
    for (const w of tokens(signal.title)) vec[hash(w) % DIMS]! += 2;
    for (const w of tokens(signal.summary)) vec[hash(w) % DIMS]! += 1;
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return mag === 0 ? vec : vec.map((v) => v / mag);
  }
}

/** Cosine similarity in [-1, 1]; 0 for a zero vector or a length mismatch, so a malformed vector never reads as related. */
export function cosineSimilarity(a: Embedding, b: Embedding): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  return magA === 0 || magB === 0 ? 0 : dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** Folds one more vector into a centroid of `newCount - 1` members (helios `incrementalMean`). */
export function incrementalMean(centroid: Embedding, next: Embedding, newCount: number): Embedding {
  if (newCount <= 1 || centroid.length !== next.length) return next.slice();
  return next.map((v, i) => (centroid[i]! * (newCount - 1) + v) / newCount);
}

export interface ClusterConfig {
  /** At or above this cosine similarity to a Narrative's centroid, a Signal joins it; below, it starts a new Narrative. */
  joinThreshold: number;
  /** Only Narratives that last gained a Signal within this many hours can be joined (a Narrative is recent Signals). */
  windowHours: number;
  /** Most Signals clustered per pass. */
  batchSize: number;
}

/**
 * Cosine similarity to a Narrative's centroid at which a Signal joins it. Measured on 320 real headlines from the 13 configured
 * feeds (docs/adr/0006, scripts/measure-narrative-threshold.mjs). At 0.60 no two different news stories merge (the only wrong
 * joins are templated pages: Hacker News summaries, coupon pages, identical titles) and the largest Narrative is 4 Signals, but
 * only 16 of 112 same-story pairs join, so Narratives mostly fragment. Below it different stories merge (0.40 over-merges 15
 * clusters); above it almost nothing joins (0.65 joins 6 of 112). Provisional and precision-first: no value is good for this
 * embedder (ticket 05b is needs-decision).
 */
export const JOIN_THRESHOLD = 0.6;

export const DEFAULT_CLUSTER_CONFIG: ClusterConfig = { joinThreshold: JOIN_THRESHOLD, windowHours: 72, batchSize: 500 };

/** The Narrative a Signal is nearest to, when it is close enough to join it. */
export function nearestNarrative<T extends { centroid: Embedding }>(
  embedding: Embedding,
  candidates: readonly T[],
  joinThreshold: number,
): T | undefined {
  let best: T | undefined;
  let bestSim = -Infinity;
  for (const c of candidates) {
    const sim = cosineSimilarity(embedding, c.centroid);
    if (sim > bestSim) {
      bestSim = sim;
      best = c;
    }
  }
  return best && bestSim >= joinThreshold ? best : undefined;
}

/**
 * Whether a Signal joining a Narrative changes it materially, which is what the judge delta (ticket 07) watches: a Signal
 * from a Source the Narrative had not heard from, or the Signal count doubling since the last material change.
 */
export function isMaterialJoin(opts: { newSource: boolean; signalCount: number; countAtLastMaterial: number }): boolean {
  return opts.newSource || opts.signalCount >= 2 * opts.countAtLastMaterial;
}

/**
 * One clustering pass: every Signal not yet in a Narrative, oldest first, joins its nearest recent Narrative or starts one.
 * Plain code, no Brain call. The order (published time, then id) and the embedder make it deterministic.
 */
export async function clusterNewSignals(
  store: Pick<Datastore, "unclusteredSignals" | "recentNarratives" | "createNarrative" | "joinNarrative">,
  embedder: Embedder,
  opts: { now?: Date; config?: Partial<ClusterConfig> } = {},
): Promise<{ clustered: number; created: number }> {
  const config = { ...DEFAULT_CLUSTER_CONFIG, ...opts.config };
  const now = opts.now ?? new Date();
  let created = 0;
  const signals = store.unclusteredSignals(config.batchSize);
  // Loaded and parsed once per pass; kept current below as Signals join or start Narratives (all stay inside the window).
  const since = new Date(now.getTime() - config.windowHours * 3_600_000).toISOString();
  const candidates = store.recentNarratives(since);
  for (const signal of signals) {
    const embedding = await embedder.embed(signal);
    const target = nearestNarrative(embedding, candidates, config.joinThreshold);
    if (target) {
      const centroid = incrementalMean(target.centroid, embedding, target.signalCount + 1);
      store.joinNarrative(target.id, signal, centroid, now.toISOString());
      target.centroid = centroid;
      target.signalCount++;
    } else {
      const id = store.createNarrative(signal, embedding, now.toISOString());
      candidates.push({ id, centroid: embedding, signalCount: 1 });
      created++;
    }
  }
  return { clustered: signals.length, created };
}
