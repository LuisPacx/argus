import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore } from "./datastore.ts";
import { HashingEmbedder, clusterNewSignals } from "./narratives.ts";
import type { Signal } from "./sources/source.ts";

const fixtureSignals = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "narrative-signals.json"), "utf8")) as Signal[];
const NOW = new Date("2026-06-14T13:00:00.000Z");
const embedder = new HashingEmbedder();

/** Runs the fixture through the clustering pass and returns the Signal ids of each Narrative, oldest Narrative first. */
async function groups(signals: Signal[]): Promise<string[][]> {
  const ds = Datastore.open(":memory:");
  ds.recordSignals(signals);
  await clusterNewSignals(ds, embedder, { now: NOW });
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
