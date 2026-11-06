import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore } from "./datastore.ts";
import { HashingEmbedder, JOIN_THRESHOLD, clusterNewSignals } from "./narratives.ts";
import type { Signal } from "./sources/source.ts";

// A recorded poll of the 13 configured RSS feeds (titles, Source ids, links). The Narrative join threshold was set from this
// sample and its hand labels (narrative-sample-labels.json, docs/adr/0006); these tests pin what it does to labelled stories.
const fixtures = join(import.meta.dirname, "fixtures");
const sample = JSON.parse(readFileSync(join(fixtures, "narrative-sample.json"), "utf8")) as Array<{ sourceId: string; title: string; url: string }>;

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

/** The sample through one clustering pass with the default config; the Narrative id of each item, by label key. */
async function narrativeOf(): Promise<(k: string) => number> {
  const ds = Datastore.open(":memory:");
  ds.recordSignals(signals);
  await clusterNewSignals(ds, new HashingEmbedder(), { now: NOW });
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
  it("is the measured, precision-first value", () => {
    expect(JOIN_THRESHOLD).toBe(0.6);
  });

  it("joins labelled same-story Signals from different outlets", async () => {
    const n = await narrativeOf();
    const together = (...keys: string[]) => expect(new Set(keys.map(n)).size, keys.join(" / ")).toBe(1);
    together(
      titled("rss:bbc-world", "Paraguay President"),
      titled("rss:npr-news", "Paraguay's president"),
      titled("rss:cointelegraph", "Paraguay president resigns"),
    );
    together(titled("rss:bbc-world", "Trump signs order"), titled("rss:guardian-world", "Trump signs proclamation"));
    together(titled("rss:coindesk", "Trump-linked American Bitcoin"), titled("rss:the-block", "Eric Trump"));
    together(titled("rss:bbc-world", "Major tech stocks"), titled("rss:bbc-technology", "Major tech stocks"));
  });

  it("keeps labelled different stories apart, including pairs that share generic words", async () => {
    const n = await narrativeOf();
    const apart = (a: string, b: string) => expect(n(a), `${a} / ${b}`).not.toBe(n(b));
    // Different stories that share generic words, or (the Hackintosh headline) collide in the 256-wide hash.
    apart(titled("rss:wired", "How Elon Musk and Big Tech"), titled("rss:cointelegraph", "‘Lawyer up’"));
    apart(titled("rss:wired", "Apple MacBook Pro OLED"), titled("rss:coindesk", "Trump-linked American Bitcoin"));
    apart(titled("rss:bbc-world", "Hoax bomb threats"), titled("rss:guardian-world", "EU presses UK"));
    apart(titled("rss:techcrunch", "OpenAI president"), titled("rss:the-block", "BitGo launches"));
    apart(titled("rss:bbc-world", "Trump signs order"), titled("rss:guardian-world", "Fox News"));
    apart(titled("rss:hn-frontpage", "The Hackintosh Reborn"), titled("rss:bbc-world", "Paraguay President"));
  });
});
