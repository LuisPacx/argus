// Measures the Narrative join threshold on the recorded sample (docs/adr/0006). Clusters the sample with the real
// HashingEmbedder and clusterNewSignals at thresholds 0.30 to 0.80, and scores each run against the hand labels.
//
//   node scripts/measure-narrative-threshold.mjs [<full-sample.json>]
//
// By default the embedder sees titles only (all the committed fixture holds). Give the `full` file that
// collect-narrative-sample.mjs can write and it embeds title and summary, in published order, as production does.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HashingEmbedder, clusterNewSignals, cosineSimilarity } from "../packages/core/src/narratives.ts";

const fixtures = (name) => fileURLToPath(new URL(`../packages/core/src/fixtures/${name}`, import.meta.url));
const sample = JSON.parse(readFileSync(fixtures("narrative-sample.json"), "utf8"));
const labels = JSON.parse(readFileSync(fixtures("narrative-sample-labels.json"), "utf8"));
const fullPath = process.argv[2];
const full = fullPath ? JSON.parse(readFileSync(fullPath, "utf8")) : undefined;
if (full && full.length !== sample.length) throw new Error("the full file does not match the fixture");

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

const embedder = new HashingEmbedder();
const vectors = await Promise.all(signals.map((s) => embedder.embed(s)));

// Distribution of pairwise cosine similarity.
const bins = new Array(20).fill(0);
const bySame = [];
const byDifferent = [];
for (let i = 0; i < N; i++) {
  for (let j = i + 1; j < N; j++) {
    const sim = cosineSimilarity(vectors[i], vectors[j]);
    bins[Math.min(19, Math.floor(sim * 20))]++;
    const l = labelOf(i, j);
    if (l === "same") bySame.push(sim);
    else if (l === "different") byDifferent.push(sim);
  }
}
const quantile = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(2);
console.log(`${N} items, ${(N * (N - 1)) / 2} pairs, embedder input: ${full ? "title + summary" : "title only"}`);
console.log("pairs per 0.05 of similarity:", bins.map((n, k) => `${(k / 20).toFixed(2)}:${n}`).join(" "));
console.log(`same-story pairs (${bySame.length}) p10/p50/p90 ${[0.1, 0.5, 0.9].map((p) => quantile(bySame, p)).join("/")}; different-story pairs (${byDifferent.length}) p50/p99/max ${[0.5, 0.99, 0.99999].map((p) => quantile(byDifferent, p)).join("/")}`);

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
  await clusterNewSignals(store, { embed: async (s) => vectors[byId.get(s.id)] }, { config: { joinThreshold, batchSize: N } });
  return assign;
}

/** Different-story pairs that look alike for a mechanical reason: both from Hacker News (shared summary boilerplate), both a Wired coupon page, or an identical title. */
const isTemplated = (i, j) =>
  (signals[i].sourceId === "rss:hn-frontpage" && signals[j].sourceId === "rss:hn-frontpage") ||
  (/(promo|coupon|discount) code/i.test(signals[i].title) && /(promo|coupon|discount) code/i.test(signals[j].title)) ||
  signals[i].title === signals[j].title;

console.log("\nthreshold  clusters  largest  over-merged clusters (items)  same pairs joined  different pairs joined (templated + other)  groups split (of " + Object.keys(labels.groups).length + ")");
for (let step = 0; step <= 10; step++) {
  const threshold = 0.3 + step * 0.05;
  const assign = await cluster(threshold);
  const members = new Map();
  assign.forEach((c, i) => members.set(c, [...(members.get(c) ?? []), i]));
  let largest = 0;
  let overMerged = 0;
  let overMergedItems = 0;
  for (const m of members.values()) {
    largest = Math.max(largest, m.length);
    if (m.some((a, x) => m.slice(x + 1).some((b) => labelOf(a, b) === "different"))) {
      overMerged++;
      overMergedItems += m.length;
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
  console.log(`${threshold.toFixed(2)}       ${String(members.size).padStart(6)}  ${String(largest).padStart(7)}  ${String(overMerged).padStart(10)} (${String(overMergedItems).padStart(3)})  ${String(sameJoined).padStart(10)}/${sameTotal}  ${String(differentJoined).padStart(8)} (${templatedJoined} + ${differentJoined - templatedJoined})  ${String(split).padStart(14)}`);
}
