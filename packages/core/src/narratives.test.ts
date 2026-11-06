import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore } from "./datastore.ts";
import { HashingEmbedder, clusterNewSignals, cosineSimilarity, type Embedder } from "./narratives.ts";
import type { Signal } from "./sources/source.ts";
import { tempDir } from "./testing/temp.ts";

const fixtureSignals = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "narrative-signals.json"), "utf8")) as Signal[];
const NOW = new Date("2026-06-14T13:00:00.000Z");
const embedder = new HashingEmbedder();

/** Runs the fixture through the clustering pass and returns the Signal ids of each Narrative, oldest Narrative first. */
async function groups(signals: Signal[]): Promise<string[][]> {
  const ds = Datastore.open(":memory:");
  ds.recordSignals(signals);
  // 0.4 is the lexical embedder's scale; JOIN_THRESHOLD is for the semantic model (docs/adr/0007).
  await clusterNewSignals(ds, embedder, { now: NOW, config: { joinThreshold: 0.4 } });
  return ds
    .listNarratives()
    .sort((a, b) => a.id - b.id)
    .map((n) => ds.getNarrative(n.id)!.signals.map((s) => s.id).sort());
}

const same = (id: string, sourceId: string, over: Partial<Signal> = {}): Signal => ({
  id,
  sourceId,
  sourceLabel: sourceId,
  title: "Robinhood tokenized stocks Europe",
  summary: "",
  url: "",
  publishedAt: "2026-06-14T09:00:00.000Z",
  ...over,
});
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

describe("what the embedder reads", () => {
  const HN_SUMMARY = "Article URL: https://example.com/post Comments URL: https://news.ycombinator.com/item?id=45678901 Points: 123 # Comments: 45";

  it("ignores the Hacker News summary template, so two unrelated HN items do not look alike", async () => {
    const a = { title: "MoofTCP, a modern replacement for MacTCP", summary: HN_SUMMARY };
    const b = { title: "Brazilian credit guarantor fund data breach", summary: HN_SUMMARY };
    expect(await embedder.embed(a)).toEqual(await embedder.embed({ ...a, summary: "" }));
    expect(cosineSimilarity(await embedder.embed(a), await embedder.embed(b))).toBeLessThan(0.1);
  });

  it("keeps a real summary that follows the template", async () => {
    const title = "MoofTCP, a modern replacement for MacTCP";
    const plain = await embedder.embed({ title, summary: "" });
    expect(await embedder.embed({ title, summary: `${HN_SUMMARY} Networking for old Macs` })).not.toEqual(plain);
  });
});

describe("a shutdown during clustering", () => {
  it("stops before the next Signal's embed, keeps the Signals already clustered, and the rest are clustered by the next pass", async () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals([1, 2, 3, 4].map((i) => same(`s:${i}`, `rss:src${i}`, { title: `Distinct headline ${i}`, publishedAt: `2026-06-14T09:0${i}:00.000Z` })));
    const ac = new AbortController();
    let embeds = 0;
    const aborting: Embedder = { id: "fake", dimension: 2, embed: async () => (++embeds === 2 && ac.abort(), [1, 0]) };
    const out = await clusterNewSignals(ds, aborting, { now: NOW, signal: ac.signal });
    expect(embeds).toBe(2); // the abort during the 2nd embed stops the loop before the 3rd
    expect(out.clustered).toBe(2);
    expect(ds.unclusteredSignals(500).map((s) => s.id)).toEqual(["s:3", "s:4"]);
    expect((await clusterNewSignals(ds, aborting, { now: NOW })).clustered).toBe(2);
    expect(ds.unclusteredSignals(500)).toEqual([]);
  });

  it("an already-aborted signal embeds nothing", async () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals([same("s:1", "rss:a")]);
    let embeds = 0;
    const ac = new AbortController();
    ac.abort();
    const out = await clusterNewSignals(ds, { id: "fake", dimension: 2, embed: async () => (embeds++, [1, 0]) }, { now: NOW, signal: ac.signal });
    expect(embeds).toBe(0);
    expect(out).toEqual({ clustered: 0, created: 0 });
  });
});

describe("pages that never join a Narrative", () => {
  const coupon = (id: string, title: string): Signal => ({ ...same(id, "rss:wired"), title });
  const sameVector: Embedder = { id: "fake", dimension: 2, embed: async () => [1, 0] };

  it("stand alone even when the embedder says they match, and are never joined", async () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals([
      coupon("s:1", "Ray-Ban Promo Codes: Save 50% in November 2026"),
      coupon("s:2", "Udemy Coupon Codes: 20% Off November 2026"),
      same("s:3", "rss:bbc-world", { title: "A real headline" }),
      same("s:4", "rss:guardian-world", { title: "A real headline, reworded" }),
    ]);
    await clusterNewSignals(ds, sameVector, { now: NOW });
    const counts = ds.listNarratives().map((n) => n.signalCount).sort();
    expect(counts).toEqual([1, 1, 2]);
  });
});

describe("Narratives and the embedder that built them", () => {
  const lexical: Embedder = { id: "old-lexical", dimension: 3, embed: async () => [1, 0, 0] };
  const semantic: Embedder = { id: "new-semantic", dimension: 3, embed: async () => [1, 0, 0] };

  it("never joins a Signal to a Narrative built by another embedder, even when the vectors line up", async () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals([same("s:1", "a")]);
    await clusterNewSignals(ds, lexical, { now: NOW });
    ds.recordSignals([same("s:2", "a", { publishedAt: "2026-06-14T10:00:00.000Z" }), same("s:3", "a", { publishedAt: "2026-06-14T11:00:00.000Z" })]);
    await clusterNewSignals(ds, semantic, { now: at(1) });
    // s:2 starts a semantic Narrative, s:3 joins it; the lexical Narrative stays alone.
    expect(ds.listNarratives().map((n) => n.signalCount).sort()).toEqual([1, 2]);
  });

  it("records which embedder and dimension built each Narrative", async () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals([same("s:1", "a")]);
    await clusterNewSignals(ds, semantic, { now: NOW });
    expect(ds.narrativeEmbedders()).toEqual([{ embedder: "new-semantic", dimension: 3, narratives: 1 }]);
  });

  it("migrates a database from before the embedder was recorded: its Narratives are the lexical ones, and opening again changes nothing", () => {
    const path = join(tempDir("argus-narratives-"), "argus.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE narratives (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, summary TEXT NOT NULL, centroid TEXT NOT NULL,
      signal_count INTEGER NOT NULL, material_signal_count INTEGER NOT NULL, created_at TEXT NOT NULL, last_signal_at TEXT NOT NULL, changed_materially_at TEXT NOT NULL)`);
    old.prepare("INSERT INTO narratives (title, summary, centroid, signal_count, material_signal_count, created_at, last_signal_at, changed_materially_at) VALUES ('t', '', '[1,0]', 1, 1, 'x', 'y', 'z')").run();
    old.close();
    for (let i = 0; i < 2; i++) {
      const ds = Datastore.open(path);
      expect(ds.narrativeEmbedders()).toEqual([{ embedder: "hashing-v1", dimension: 256, narratives: 1 }]);
      ds.close();
    }
  });
});

describe("when a Narrative changes materially", () => {
  it("stamps creation, a Source it had not heard from, and a doubling of its Signals, but not other joins", async () => {
    const ds = Datastore.open(":memory:");
    const pass = async (signal: Signal, hours: number) => {
      ds.recordSignals([signal]);
      await clusterNewSignals(ds, embedder, { now: at(hours) });
      return ds.listNarratives()[0]!;
    };
    const stamp = (hours: number) => at(hours).toISOString();

    expect((await pass(same("s:1", "a"), 0)).changedMateriallyAt).toBe(stamp(0)); // created
    expect((await pass(same("s:2", "a"), 1)).changedMateriallyAt).toBe(stamp(1)); // 1 -> 2 Signals: doubled
    const third = await pass(same("s:3", "a"), 2); // 3 Signals, same Source: not material
    expect(third.changedMateriallyAt).toBe(stamp(1));
    expect(third.lastSignalAt).toBe(stamp(2));
    expect((await pass(same("s:4", "b"), 3)).changedMateriallyAt).toBe(stamp(3)); // a new Source
    expect((await pass(same("s:5", "b"), 4)).changedMateriallyAt).toBe(stamp(3)); // 5 Signals, doubled only at 8
    expect(ds.listNarratives()).toHaveLength(1);
    expect(ds.listNarratives()[0]!.signalCount).toBe(5);
  });
});

describe("a clustering pass", () => {
  it("leaves Signals already in a Narrative where they are", async () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals(fixtureSignals);
    await clusterNewSignals(ds, embedder, { now: NOW });
    const before = ds.listNarratives();
    expect(await clusterNewSignals(ds, embedder, { now: at(1) })).toEqual({ clustered: 0, created: 0 });
    expect(ds.listNarratives()).toEqual(before);
  });

  it("does not join a Narrative that has had no new Signal for longer than the window", async () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals([same("s:1", "a")]);
    await clusterNewSignals(ds, embedder, { now: NOW });
    ds.recordSignals([same("s:2", "a")]);
    await clusterNewSignals(ds, embedder, { now: at(73) });
    expect(ds.listNarratives().map((n) => n.signalCount)).toEqual([1, 1]);
  });

  it("shows the first Signal as the Narrative's two-line summary, the second line shortened", async () => {
    const ds = Datastore.open(":memory:");
    ds.recordSignals([same("s:1", "a", { summary: "x".repeat(500) })]);
    await clusterNewSignals(ds, embedder, { now: NOW });
    const [n] = ds.listNarratives();
    expect(n!.title).toBe("Robinhood tokenized stocks Europe");
    expect(n!.summary).toHaveLength(200);
  });
});

describe("clustering Signals into Narratives", () => {
  it("groups fixture Signals by subject, deterministically", async () => {
    const expected = [["rss:a:1", "rss:a:4", "rss:b:1"], ["rss:a:2", "rss:b:2"], ["rss:a:3"]];
    expect(await groups(fixtureSignals)).toEqual(expected);
    expect(await groups(fixtureSignals)).toEqual(expected);
    expect(await groups([...fixtureSignals].reverse())).toEqual(expected);
  });

  it("puts each Signal in exactly one Narrative", async () => {
    const all = (await groups(fixtureSignals)).flat();
    expect(all.sort()).toEqual(fixtureSignals.map((s) => s.id).sort());
  });
});
