// Measures the Narrative join threshold on the recorded sample (docs/adr/0006, docs/adr/0007). Clusters the sample with
// the real clusterNewSignals at thresholds 0.30 to 0.90 and scores each run against the hand labels.
//
//   node scripts/measure-narrative-threshold.mjs [--sample sample|holdout] [--embedder hashing|fixture|semantic] [--embeddings <file>] [--full <full-sample.json>] [--from 0.30 --to 0.90 --step 0.05]
//
//   --embedder hashing   (default) the lexical HashingEmbedder
//   --embedder fixture   the committed vectors of the semantic model (narrative-sample-embeddings.json, or --embeddings <file>);
//                        offline and exactly reproducible, what `pnpm check` pins
//   --embedder semantic  embeds the titles with the real model now (needs `pnpm models:fetch` once); also writes the
//                        fixture file when given --write-embeddings <file>; with --check (`pnpm verify:semantic`) it only
//                        compares the model's vectors with the committed fixture and exits 1 on a mismatch. Opt-in, not in `pnpm check`.
//
// By default the embedder sees titles only (all the committed sample holds). Give the `full` file that
// collect-narrative-sample.mjs can write and it embeds title and summary, in published order, as production does.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HashingEmbedder, clusterNewSignals, cosineSimilarity, standsAlone } from "../packages/core/src/narratives.ts";
import { decodeVectors, encodeVectors } from "../packages/core/src/embedding-codec.ts";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const fixtures = (name) => fileURLToPath(new URL(`../packages/core/src/fixtures/${name}`, import.meta.url));
const sampleName = opt("--sample") ?? "sample"; // "sample" (the tuning sample) or "holdout" (ticket hardening/04)
const sample = JSON.parse(readFileSync(fixtures(`narrative-${sampleName}.json`), "utf8"));
const labels = JSON.parse(readFileSync(fixtures(`narrative-${sampleName}-labels.json`), "utf8"));
const fullPath = opt("--full");
const full = fullPath ? JSON.parse(readFileSync(fullPath, "utf8")) : undefined;
if (full && full.length !== sample.length) throw new Error("the full file does not match the fixture");
const embedderChoice = opt("--embedder") ?? "hashing";

const N = sample.length;
const signals = sample.map((s, i) => ({
  id: `sample:${String(i).padStart(4, "0")}`,
  sourceId: s.sourceId,
  sourceLabel: s.sourceId,
  title: s.title,
  summary: full?.[i]?.summary ?? "",
  url: s.url,
  publishedAt: full?.[i]?.publishedAt ?? new Date(Date.UTC(2026, 10, 5) + i * 60_000).toISOString(),
  ingestedAt: "",
}));

const keyOf = (s) => `${s.sourceId} | ${s.title}`;
const indexOfKey = new Map(signals.map((s, i) => [keyOf(s), i]));
const at = (key) => {
  const i = indexOfKey.get(key);
  if (i === undefined) throw new Error(`label for an unknown item: ${key}`);
  return i;
};
const groupOf = new Array(N).fill(null);
for (const [name, keys] of Object.entries(labels.groups)) for (const k of keys) groupOf[at(k)] = name;
const topicSets = Object.values(labels.topics).map((keys) => new Set(keys.map(at)));
/** "same" (one story), "related" (a shared wider subject, scored as neither), or "different". */
const labelOf = (i, j) => (groupOf[i] && groupOf[i] === groupOf[j] ? "same" : topicSets.some((t) => t.has(i) && t.has(j)) ? "related" : "different");

let vectors;
if (embedderChoice === "hashing") {
  const embedder = new HashingEmbedder();
  vectors = await Promise.all(signals.map((s) => embedder.embed(s)));
} else if (embedderChoice === "fixture") {
  const file = JSON.parse(readFileSync(opt("--embeddings") ?? fixtures(`narrative-${sampleName}-embeddings.json`), "utf8"));
  vectors = decodeVectors(file);
  if (vectors.length !== N) throw new Error("the embeddings file does not match the sample");
  console.log(`embedder: ${file.embedder} (fixture, ${file.dimension} dims)`);
} else if (embedderChoice === "semantic") {
  const { loadSemanticEmbedder, modelCacheDir } = await import("../apps/worker/src/semantic-embedder.ts");
  const embedder = await loadSemanticEmbedder({ dir: modelCacheDir(process.env), allowFetch: false, log: console.log });
  const t0 = performance.now();
  vectors = [];
  for (const s of signals) vectors.push(await embedder.embed(s));
  console.log(`embedder: ${embedder.id} (${embedder.dimension} dims), ${((performance.now() - t0) / N).toFixed(1)} ms per headline`);
  if (args.includes("--check")) {
    // The committed vectors (what `pnpm check` pins) must still be what the real model produces.
    const committed = decodeVectors(JSON.parse(readFileSync(fixtures(`narrative-${sampleName}-embeddings.json`), "utf8")));
    const worst = Math.min(...vectors.map((v, i) => cosineSimilarity(v, committed[i])));
    console.log(`committed embeddings vs the real model: worst cosine ${worst.toFixed(5)}`);
    if (!(worst > 0.999)) {
      console.error("FAIL: narrative-sample-embeddings.json no longer matches the model; regenerate it with --write-embeddings");
      process.exit(1);
    }
    console.log("PASS");
    process.exit(0);
  }
  const out = opt("--write-embeddings");
  if (out) {
    writeFileSync(out, JSON.stringify({ embedder: embedder.id, ...encodeVectors(vectors) }) + "\n");
    console.log(`wrote ${out}`);
  }
} else {
  throw new Error(`unknown --embedder ${embedderChoice}`);
}

// Distribution of pairwise cosine similarity. Promo and coupon pages stand alone in production, so they are left out.
const aloneAt = signals.map((s) => standsAlone(s));
const bins = new Array(20).fill(0);
const bySame = [];
const byDifferent = [];
for (let i = 0; i < N; i++) {
  for (let j = i + 1; j < N; j++) {
    if (aloneAt[i] || aloneAt[j]) continue;
    const sim = cosineSimilarity(vectors[i], vectors[j]);
    bins[Math.min(19, Math.max(0, Math.floor(sim * 20)))]++;
    const l = labelOf(i, j);
    if (l === "same") bySame.push(sim);
    else if (l === "different") byDifferent.push(sim);
  }
}
const quantile = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(2);
console.log(`${N} items (${aloneAt.filter(Boolean).length} stand-alone promo pages), ${(N * (N - 1)) / 2} pairs, embedder input: ${full ? "title + summary" : "title only"}`);
console.log("pairs per 0.05 of similarity:", bins.map((n, k) => `${(k / 20).toFixed(2)}:${n}`).join(" "));
console.log(`same-story pairs (${bySame.length}) p10/p50/p90 ${[0.1, 0.5, 0.9].map((p) => quantile(bySame, p)).join("/")}; different-story pairs (${byDifferent.length}) p50/p99/max ${[0.5, 0.99, 0.99999].map((p) => quantile(byDifferent, p)).join("/")}`);

// The closest different-story pairs (the margin to the threshold), with a mark on the templated ones.
function printClosestWrongPairs() {
  const closest = [];
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      if (aloneAt[i] || aloneAt[j] || labelOf(i, j) !== "different") continue;
      closest.push({ sim: cosineSimilarity(vectors[i], vectors[j]), i, j });
    }
  }
  closest.sort((a, b) => b.sim - a.sim);
  console.log("closest different-story pairs:");
  for (const { sim, i, j } of closest.slice(0, 8)) console.log(`  ${sim.toFixed(4)}${isTemplated(i, j) ? " [templated]" : ""}  ${keyOf(signals[i])}  //  ${keyOf(signals[j])}`);
}

/** One clustering pass over the whole sample at `joinThreshold`; returns each item's Narrative number. */
async function cluster(joinThreshold) {
  const order = signals.map((s, i) => ({ s, i })).sort((a, b) => (a.s.publishedAt < b.s.publishedAt ? -1 : a.s.publishedAt > b.s.publishedAt ? 1 : a.s.id < b.s.id ? -1 : 1));
  const byId = new Map(signals.map((s, i) => [s.id, i]));
  const candidates = [];
  const assign = new Array(N);
  let nextId = 1;
  const store = {
    unclusteredSignals: () => order.map((o) => o.s),
    recentNarratives: () => candidates,
    createNarrative: (s) => (assign[byId.get(s.id)] = nextId++),
    joinNarrative: (id, s) => void (assign[byId.get(s.id)] = id),
  };
  await clusterNewSignals(store, { id: "measure", dimension: vectors[0].length, embed: async (s) => vectors[byId.get(s.id)] }, { config: { joinThreshold, batchSize: N } });
  return assign;
}

/**
 * Different-story pairs that look alike for a mechanical reason: both from Hacker News (shared summary boilerplate), an
 * identical title, or two BBC programme titles ("Tech Life", "Tech Now") that differ by one word and are told apart only by
 * their summaries, which the committed sample does not hold. "Cross-story" over-merges exclude these.
 */
const isTemplated = (i, j) =>
  (signals[i].sourceId === "rss:hn-frontpage" && signals[j].sourceId === "rss:hn-frontpage") ||
  signals[i].title === signals[j].title ||
  (/^Tech (Life|Now)$/.test(signals[i].title) && /^Tech (Life|Now)$/.test(signals[j].title));

printClosestWrongPairs();

const header = ["threshold", "clusters", "largest", "over-merged (items)", "cross-story over-merged", "same pairs joined", "different pairs joined (templated + other)", "groups split of " + Object.keys(labels.groups).length];
console.log("\n" + header.join("  |  "));
const from = Number(opt("--from") ?? 0.3);
const to = Number(opt("--to") ?? 0.9);
const stepSize = Number(opt("--step") ?? 0.05);
for (let step = 0; from + step * stepSize <= to + 1e-9; step++) {
  const threshold = from + step * stepSize;
  const assign = await cluster(threshold);
  const members = new Map();
  assign.forEach((c, i) => members.set(c, [...(members.get(c) ?? []), i]));
  let largest = 0;
  let overMerged = 0;
  let overMergedItems = 0;
  let crossStory = 0;
  for (const m of members.values()) {
    largest = Math.max(largest, m.length);
    const pairs = m.flatMap((a, x) => m.slice(x + 1).map((b) => [a, b])).filter(([a, b]) => labelOf(a, b) === "different");
    if (pairs.length > 0) {
      overMerged++;
      overMergedItems += m.length;
      if (pairs.some(([a, b]) => !isTemplated(a, b))) crossStory++;
    }
  }
  let sameJoined = 0;
  let sameTotal = 0;
  let differentJoined = 0;
  let templatedJoined = 0;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const l = labelOf(i, j);
      if (l === "same") {
        sameTotal++;
        if (assign[i] === assign[j]) sameJoined++;
      } else if (l === "different" && assign[i] === assign[j]) {
        differentJoined++;
        if (isTemplated(i, j)) templatedJoined++;
      }
    }
  }
  const split = Object.values(labels.groups).filter((keys) => new Set(keys.map((k) => assign[at(k)])).size > 1).length;
  console.log(
    `${threshold.toFixed(2)}  |  ${members.size}  |  ${largest}  |  ${overMerged} (${overMergedItems})  |  ${crossStory}  |  ${sameJoined}/${sameTotal}  |  ${differentJoined} (${templatedJoined} + ${differentJoined - templatedJoined})  |  ${split}`,
  );
}
