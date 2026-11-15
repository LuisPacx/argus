import type { Datastore, StoredSignal } from "./datastore.ts";
import { crossSourceTarget, placeLaunchpadSignal } from "./launchpad-cluster.ts";
import { LAUNCHPAD_SOURCE_ID } from "./launchpad-subject.ts";
import { STOPWORDS } from "./stopwords.ts";

/** A fixed-length numeric vector for a Signal's text. Related Signals point the same way (ported from helios). */
export type Embedding = number[];

/**
 * Turns a Signal's text into an Embedding. Async so a model-backed embedder can replace the default without touching
 * clustering (docs/adr/0006-narratives-use-a-local-hashing-embedder.md). Never calls the Brain.
 */
export interface Embedder {
  /** Names the embedder and model that built a vector. Narratives remember it; vectors of different ids are never compared. */
  readonly id: string;
  /** Length of the vectors it returns. */
  readonly dimension: number;
  embed(signal: Pick<StoredSignal, "title" | "summary">): Promise<Embedding>;
  /**
   * Whether a lower-case word is an ordinary word (the model's vocabulary holds it as one piece) rather than a coined or proper one. The
   * launchpad cross-Source rule (ticket 01) links a headline to a token only through a word that is not ordinary: `moon` and `zero` name
   * hundreds of tokens and no story, `misu` and `eisenkot` name one. Absent (the lexical embedder), no single word links a headline.
   */
  isCommonWord?(word: string): boolean;
}

/** Hacker News feed items carry only this template as their summary: "Article URL: .. Comments URL: .. Points: N # Comments: N". */
const HN_TEMPLATE = /\b(?:Article URL|Comments URL):\s*\S+|\bPoints:\s*\d+|#\s*Comments:\s*\d+/g;

/** A Signal summary without the Hacker News template, which says nothing about the story and makes every HN item look alike. */
export function cleanSummary(summary: string): string {
  return summary.replace(HN_TEMPLATE, " ").replace(/\s+/g, " ").trim();
}

/**
 * Promo and coupon pages (Wired publishes dozens a month) share a template, not a story. They get a Narrative of their own
 * and never join or are joined, rather than being skipped, so they cannot block the unclustered queue.
 */
export function standsAlone(signal: Pick<StoredSignal, "title">): boolean {
  return /(promo|coupon|discount) code/i.test(signal.title);
}

const DIMS = 256;

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
  readonly id = "hashing-v1";
  readonly dimension = DIMS;
  async embed(signal: Pick<StoredSignal, "title" | "summary">): Promise<Embedding> {
    const vec = new Array<number>(DIMS).fill(0);
    for (const w of tokens(signal.title)) vec[hash(w) % DIMS]! += 2;
    for (const w of tokens(cleanSummary(signal.summary))) vec[hash(w) % DIMS]! += 1;
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
  /** No Narrative holds more than this many Signals (ticket 01): a full one is not joinable, and the next Signal that would have joined it starts a successor. Default `MAX_NARRATIVE_SIGNALS`. */
  maxNarrativeSignals: number;
  /** A launchpad Narrative needs this many Signals before a headline or a DexScreener token may join it: one lone token is junk, not a subject. */
  crossMinSignals: number;
  /** A headline phrase that appears in more than this many recent non-launchpad Signals (itself included) is too common to link to a token. */
  crossMaxDocFreq: number;
}

/**
 * Cosine similarity to a Narrative's centroid at which a Signal joins it, for the semantic embedder (Xenova/gte-small, 8-bit;
 * see worker `semantic-embedder.ts`). Measured on 320 real headlines from the 13 configured feeds (docs/adr/0007,
 * scripts/measure-narrative-threshold.mjs). At 0.90 no two different news stories merge (the closest different-story pair
 * scores 0.878; 0.89 already merged one pair through a drifting centroid) and 53 of 112 same-story pairs join, against 7 for the
 * lexical embedder at its best. Higher values fragment (0.93 joins 11); lower ones over-merge (0.87 merges 2 stories). The scale is
 * model-specific: another model needs its own measurement. Precision-first, and thin-margined: re-measure when feeds change.
 */
export const JOIN_THRESHOLD = 0.9;

/** The HashingEmbedder's own scale (docs/adr/0006): the lexical embedder is kept only as an explicit dev and test choice (ARGUS_EMBEDDER=hashing). */
export const HASHING_JOIN_THRESHOLD = 0.6;

/**
 * The most Signals one Narrative may hold (`ClusterConfig.maxNarrativeSignals`). The semantic embedder's news Narratives never come near it
 * (the largest of the 320-headline sample holds 5); it exists for the launchpad stream, where one spam name made 1,582 Signals in eight days (the
 * replay's largest Narrative, under the bound; the next holds 369) and the old embedding catch-all reached 65,189. See the replay in docs/adr/0007
 * (amendment of 2026-11-14) for the measured sizes.
 */
export const MAX_NARRATIVE_SIGNALS = 2000;

export const DEFAULT_CLUSTER_CONFIG: ClusterConfig = {
  joinThreshold: JOIN_THRESHOLD,
  windowHours: 72,
  batchSize: 500,
  maxNarrativeSignals: MAX_NARRATIVE_SIGNALS,
  crossMinSignals: 3,
  crossMaxDocFreq: 5,
};

/** The Narrative a Signal is nearest to, when it is close enough to join it. A candidate with `maxSignals` Signals or more is full and never chosen. */
export function nearestNarrative<T extends { centroid: Embedding; signalCount?: number }>(
  embedding: Embedding,
  candidates: readonly T[],
  joinThreshold: number,
  maxSignals = Infinity,
): T | undefined {
  let best: T | undefined;
  let bestSim = -Infinity;
  for (const c of candidates) {
    if ((c.signalCount ?? 0) >= maxSignals) continue;
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
  store: Pick<Datastore, "unclusteredSignals" | "recentNarratives" | "createNarrative" | "joinNarrative" | "claimsForKey" | "knownToken" | "recentPhraseCount">,
  embedder: Embedder,
  opts: { now?: Date; config?: Partial<ClusterConfig>; signal?: AbortSignal } = {},
): Promise<{ clustered: number; created: number }> {
  const config = { ...DEFAULT_CLUSTER_CONFIG, ...opts.config };
  const now = opts.now ?? new Date();
  let created = 0;
  let clustered = 0;
  const signals = store.unclusteredSignals(config.batchSize);
  // Loaded and parsed once per pass; kept current below as Signals join or start Narratives (all stay inside the window).
  const since = new Date(now.getTime() - config.windowHours * 3_600_000).toISOString();
  const candidates = store.recentNarratives(since, embedder);
  for (const signal of signals) {
    if (opts.signal?.aborted) break; // a shutdown: the Signals already clustered stay, the rest are picked up by the next pass
    if (signal.sourceId === LAUNCHPAD_SOURCE_ID) {
      // Launchpad creates and bonds are grouped by the token's name and ticker, not embedded (docs/adr/0007, amendment of 2026-11-14).
      if (placeLaunchpadSignal(store, signal, now.toISOString(), since, config, embedder).created) created++;
      clustered++;
      continue;
    }
    const embedding = await embedder.embed(signal);
    clustered++;
    if (standsAlone(signal)) {
      store.createNarrative(signal, embedding, now.toISOString(), embedder);
      created++;
      continue;
    }
    const target = nearestNarrative(embedding, candidates, config.joinThreshold, config.maxNarrativeSignals);
    if (target) {
      const centroid = incrementalMean(target.centroid, embedding, target.signalCount + 1);
      store.joinNarrative(target.id, signal, centroid, now.toISOString());
      target.centroid = centroid;
      target.signalCount++;
      continue;
    }
    // Not near any news Narrative: a headline or a DexScreener token that names a launchpad subject joins that Narrative instead of starting one.
    const launchpad = crossSourceTarget(store, signal, since, config, embedder);
    if (launchpad !== undefined) {
      store.joinNarrative(launchpad, signal, [], now.toISOString());
      continue;
    }
    const id = store.createNarrative(signal, embedding, now.toISOString(), embedder);
    candidates.push({ id, centroid: embedding, signalCount: 1 });
    created++;
  }
  return { clustered, created };
}
