import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore } from "./datastore.ts";
import { decodeVectors } from "./embedding-codec.ts";
import { JOIN_THRESHOLD, clusterNewSignals, type Embedder } from "./narratives.ts";
import type { Signal } from "./sources/source.ts";

// A recorded poll of the 13 configured RSS feeds (titles, Source ids, links), hand-labelled into same-story groups
// (narrative-sample-labels.json), and the semantic model's embedding of each title (narrative-sample-embeddings.json,
// produced by `node scripts/measure-narrative-threshold.mjs --embedder semantic --write-embeddings`). The model is not loaded
// here: these tests pin what JOIN_THRESHOLD does to the recorded vectors. `pnpm verify:semantic` checks the vectors against the real model.
const fixtures = join(import.meta.dirname, "fixtures");
const read = <T>(name: string) => JSON.parse(readFileSync(join(fixtures, name), "utf8")) as T;
const sample = read<Array<{ sourceId: string; title: string; url: string }>>("narrative-sample.json");
const labels = read<{ groups: Record<string, string[]> }>("narrative-sample-labels.json");
const embeddings = read<{ embedder: string; dimension: number; count: number; data: string }>("narrative-sample-embeddings.json");
const vectors = decodeVectors(embeddings);

const NOW = new Date("2026-11-05T12:00:00.000Z");
const key = (s: { sourceId: string; title: string }) => `${s.sourceId} | ${s.title}`;
const signals: Signal[] = sample.map((s, i) => ({
  id: `sample:${i}`,
  sourceId: s.sourceId,
  sourceLabel: s.sourceId,
  title: s.title,
  summary: "",
  url: s.url,
  publishedAt: new Date(NOW.getTime() - (sample.length - i) * 60_000).toISOString(),
}));
/** The recorded vectors, served through the Embedder seam in place of the model. */
const recorded: Embedder = {
  id: embeddings.embedder,
  dimension: embeddings.dimension,
  embed: async (s) => vectors[Number((s as Signal).id.split(":")[1])]!,
};

/** The sample through one clustering pass with the default config; the Narrative id of each item, by label key. */
async function narrativeOf(): Promise<(k: string) => number> {
  const ds = Datastore.open(":memory:");
  ds.recordSignals(signals);
  await clusterNewSignals(ds, recorded, { now: NOW });
  const idToNarrative = new Map<string, number>();
  for (const n of ds.listNarratives(sample.length)) for (const s of ds.getNarrative(n.id)!.signals) idToNarrative.set(s.id, n.id);
  const idOfKey = new Map(sample.map((s, i) => [key(s), `sample:${i}`]));
  return (k) => {
    const id = idOfKey.get(k);
    if (!id) throw new Error(`label for an unknown item: ${k}`);
    return idToNarrative.get(id)!;
  };
}

const titled = (sourceId: string, titleStart: string) => {
  const hit = sample.filter((s) => s.sourceId === sourceId && s.title.startsWith(titleStart));
  if (hit.length !== 1) throw new Error(`${sourceId} ${titleStart}: ${hit.length} matches`);
  return key(hit[0]!);
};

describe("Narrative threshold on the recorded sample", () => {
  it("joins labelled same-story Signals from different outlets", async () => {
    const n = await narrativeOf();
    const together = (...keys: string[]) => expect(new Set(keys.map(n)).size, keys.join(" / ")).toBe(1);
    together(titled("rss:bbc-world", "Major tech stocks"), titled("rss:bbc-technology", "Major tech stocks"));
    together(titled("rss:bbc-world", "Trump signs order"), titled("rss:guardian-world", "Trump signs proclamation"));
    together(titled("rss:coindesk", "Trump-linked American Bitcoin"), titled("rss:the-block", "Eric Trump"));
    together(titled("rss:bbc-world", "Paraguay President"), titled("rss:npr-news", "Paraguay's president"));
  });

  it("keeps labelled different stories apart, including pairs that share generic words", async () => {
    const n = await narrativeOf();
    const apart = (a: string, b: string) => expect(n(a), `${a} / ${b}`).not.toBe(n(b));
    apart(titled("rss:wired", "How Elon Musk and Big Tech"), titled("rss:cointelegraph", "‘Lawyer up’"));
    apart(titled("rss:wired", "Apple MacBook Pro OLED"), titled("rss:coindesk", "Trump-linked American Bitcoin"));
    apart(titled("rss:bbc-world", "Hoax bomb threats"), titled("rss:guardian-world", "EU presses UK"));
    apart(titled("rss:techcrunch", "OpenAI president"), titled("rss:the-block", "BitGo launches"));
    apart(titled("rss:bbc-world", "Trump signs order"), titled("rss:guardian-world", "Fox News"));
    // Two crypto-market headlines of the same day, the closest different-story pair the model scores (0.878).
    apart(titled("rss:cointelegraph", "Here’s what happened in crypto today"), titled("rss:decrypt", "Morning Minute: Democrat Sweep"));
  });

  it("merges no two of the 38 labelled stories, and joins at least 50 of the 112 same-story pairs (the lexical embedder joined 7 at best)", async () => {
    const n = await narrativeOf();
    const stories = Object.entries(labels.groups);
    const items = stories.flatMap(([story, keys]) => keys.map((k) => ({ story, narrative: n(k) })));
    let crossStory = 0;
    let sameJoined = 0;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (items[i]!.narrative !== items[j]!.narrative) continue;
        if (items[i]!.story === items[j]!.story) sameJoined++;
        else crossStory++;
      }
    }
    expect(crossStory).toBe(0);
    expect(sameJoined).toBeGreaterThanOrEqual(50); // 53 of the 112 same-story pairs when measured; the lexical embedder's best was 7
    expect(JOIN_THRESHOLD).toBeGreaterThan(0.88); // below it the closest different-story pair (0.88) can merge
  });
});

// A second sample, collected after the threshold was set and never used to choose it (ticket hardening/04; labelling rule
// in narrative-holdout-labels.json). The same recorded-vector approach: 146 fresh headlines, 62 same-story pairs in 13 multi-headline stories plus one singleton.
describe("Narrative threshold on the holdout sample", () => {
  const holdout = read<Array<{ sourceId: string; title: string; url: string }>>("narrative-holdout.json");
  const holdoutLabels = read<{ groups: Record<string, string[]>; topics: Record<string, string[]> }>("narrative-holdout-labels.json");
  const holdoutEmbeddings = read<{ embedder: string; dimension: number; count: number; data: string }>("narrative-holdout-embeddings.json");
  const holdoutVectors = decodeVectors(holdoutEmbeddings);
  const indexOf = new Map(holdout.map((s, i) => [key(s), i]));
  const at = (k: string) => {
    const i = indexOf.get(k);
    if (i === undefined) throw new Error(`label for an unknown item: ${k}`);
    return i;
  };

  it("joins at least 20 of the 62 same-story pairs, merges no two stories, and keeps the closest wrong pair under the threshold with a margin", async () => {
    const holdoutSignals: Signal[] = holdout.map((s, i) => ({
      id: `holdout:${i}`,
      sourceId: s.sourceId,
      sourceLabel: s.sourceId,
      title: s.title,
      summary: "",
      url: s.url,
      publishedAt: new Date(NOW.getTime() - (holdout.length - i) * 60_000).toISOString(),
    }));
    const embedder: Embedder = { id: holdoutEmbeddings.embedder, dimension: holdoutEmbeddings.dimension, embed: async (s) => holdoutVectors[Number((s as Signal).id.split(":")[1])]! };
    const ds = Datastore.open(":memory:");
    ds.recordSignals(holdoutSignals);
    await clusterNewSignals(ds, embedder, { now: NOW });
    const narrativeOfId = new Map<string, number>();
    for (const n of ds.listNarratives(holdout.length)) for (const s of ds.getNarrative(n.id)!.signals) narrativeOfId.set(s.id, n.id);
    const narrative = (i: number) => narrativeOfId.get(`holdout:${i}`)!;

    const storyOf = new Map<number, string>();
    for (const [story, keys] of Object.entries(holdoutLabels.groups)) for (const k of keys) storyOf.set(at(k), story);
    const topicSets = Object.values(holdoutLabels.topics).map((keys) => new Set(keys.map(at)));
    const related = (i: number, j: number) => topicSets.some((t) => t.has(i) && t.has(j));

    let sameJoined = 0;
    let wrongJoined = 0;
    let closestWrong = 0;
    for (let i = 0; i < holdout.length; i++) {
      for (let j = i + 1; j < holdout.length; j++) {
        const same = storyOf.has(i) && storyOf.get(i) === storyOf.get(j);
        if (same) {
          if (narrative(i) === narrative(j)) sameJoined++;
        } else if (!related(i, j)) {
          if (narrative(i) === narrative(j)) wrongJoined++;
          closestWrong = Math.max(closestWrong, holdoutVectors[i]!.reduce((sum, v, k) => sum + v * holdoutVectors[j]![k]!, 0));
        }
      }
    }
    expect(wrongJoined).toBe(0);
    expect(sameJoined).toBeGreaterThanOrEqual(20); // 25 of the 62 when measured at 0.90
    expect(closestWrong).toBeLessThan(JOIN_THRESHOLD - 0.03); // 0.859 when measured: a margin of 0.041, against 0.022 on the tuning sample
  });
});
