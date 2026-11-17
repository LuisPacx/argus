import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore, type WarRoomStore } from "./datastore.ts";
import { MAX_VERDICT_NOTE_CHARS, SCORE_TAGS, VERDICT_TAGS, VERDICTS } from "./narrative-verdict.ts";
import { tempDir } from "./testing/temp.ts";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-17T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms);
const DIMS = { momentum: 7, novelty: 6, buildability: 8, hook: 5, legitimacy: 9 };

/** A store with Narrative 1 (two Scores on Rubric 1) and Narrative 2 (no Score yet), through the production write paths. */
function seeded(path = ":memory:") {
  const store = Datastore.open(path);
  store.recordSignals([
    { id: "s:1", sourceId: "rss:a", sourceLabel: "Feed A", title: "One story", summary: "s", url: "https://a.example/1", publishedAt: at(0).toISOString() },
    { id: "s:2", sourceId: "rss:a", sourceLabel: "Feed A", title: "Another story", summary: "s", url: "https://a.example/2", publishedAt: at(0).toISOString() },
  ]);
  const [a, b] = store.unclusteredSignals(5);
  const n1 = store.createNarrative(a!, [1, 0], at(0).toISOString(), { id: "t", dimension: 2 });
  const n2 = store.createNarrative(b!, [0, 1], at(0).toISOString(), { id: "t", dimension: 2 });
  return { store, n1, n2 };
}
const score = (store: Datastore, narrativeId: number, total: number, ms: number, rubricVersion = 1) =>
  store.recordScore({ narrativeId, rubricVersion, scores: DIMS, total, rationale: `r${total}`, signalCount: 1, changedMateriallyAt: at(0).toISOString(), createdAt: at(ms).toISOString() });
const verdict = (over: Partial<Parameters<Datastore["addNarrativeVerdict"]>[0]> = {}) => ({ narrativeId: 1, verdict: "good" as const, tags: [], dimensions: [], note: "", ...over });

describe("addNarrativeVerdict: the War Room's insert", () => {
  it("stores the verdict with the latest Score's id and Rubric version", () => {
    const { store, n1 } = seeded();
    score(store, n1, 4, 1);
    const latest = score(store, n1, 8, 2, 2);
    const v = store.addNarrativeVerdict(verdict({ verdict: "bad", tags: ["score-too-high"], dimensions: ["hook"], note: "overrated" }), { now: at(HOUR) });
    expect(v).toEqual({ id: 1, narrativeId: n1, verdict: "bad", tags: ["score-too-high"], dimensions: ["hook"], note: "overrated", scoreId: latest, rubricVersion: 2, createdAt: at(HOUR).toISOString() });
    expect(store.verdictsFor(n1)).toEqual([v]);
  });

  it("a second verdict keeps both rows and becomes the current one (newest first)", () => {
    const { store, n1 } = seeded();
    score(store, n1, 4, 1);
    const first = store.addNarrativeVerdict(verdict({ verdict: "bad" }), { now: at(HOUR) });
    const second = store.addNarrativeVerdict(verdict({ verdict: "good", tags: ["score-too-low"] }), { now: at(2 * HOUR) });
    expect(store.verdictsFor(n1).map((v) => [v.id, v.verdict])).toEqual([
      [second.id, "good"],
      [first.id, "bad"],
    ]);
    expect(store.queryNarratives({ sort: "newest" }).find((n) => n.id === n1)!.verdict).toBe("good");
  });

  it("a Narrative with no Score stores a null score id and Rubric version", () => {
    const { store, n2 } = seeded();
    const v = store.addNarrativeVerdict(verdict({ narrativeId: n2 }), { now: at(HOUR) });
    expect(v).toMatchObject({ scoreId: null, rubricVersion: null });
  });

  it("refuses an unknown Narrative and writes nothing", () => {
    const { store } = seeded();
    expect(() => store.addNarrativeVerdict(verdict({ narrativeId: 99 }))).toThrow(/Narrative 99/);
    expect(store.verdictExport()).toEqual([]);
  });

  it("is on the War Room's allowed view, and nothing edits or deletes a verdict (type test)", () => {
    const { store } = seeded();
    const wr: WarRoomStore = store;
    expect(wr.addNarrativeVerdict).toBeDefined();
    expect(wr.verdictsFor).toBeDefined();
    expect(wr.verdictExport).toBeDefined();
    // @ts-expect-error there is no edit
    expect(wr.updateNarrativeVerdict).toBeUndefined();
    // @ts-expect-error there is no delete
    expect(wr.deleteNarrativeVerdict).toBeUndefined();
  });

  it("names the constants the route and the form share", () => {
    expect(VERDICTS).toEqual(["good", "bad"]);
    expect(VERDICT_TAGS).toEqual(["wrong-cluster", "duplicate", "score-too-high", "score-too-low"]);
    expect(SCORE_TAGS).toEqual(["score-too-high", "score-too-low"]);
    expect(MAX_VERDICT_NOTE_CHARS).toBe(500);
  });
});

describe("verdictExport", () => {
  it("is empty with no verdicts", () => {
    expect(seeded().store.verdictExport()).toEqual([]);
  });

  it("joins each verdict to the Score it was made against and to the latest Score now, with scoreChanged", () => {
    const { store, n1, n2 } = seeded();
    const s1 = score(store, n1, 4, 1);
    store.addNarrativeVerdict(verdict({ verdict: "bad", tags: ["score-too-high"], dimensions: ["momentum", "hook"], note: "n" }), { now: at(HOUR) });
    store.addNarrativeVerdict(verdict({ narrativeId: n2, verdict: "good" }), { now: at(HOUR) });
    let out = store.verdictExport();
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: 1,
      narrativeId: n1,
      title: "One story",
      verdict: "bad",
      tags: ["score-too-high"],
      dimensions: ["momentum", "hook"],
      note: "n",
      createdAt: at(HOUR).toISOString(),
      score: { id: s1, rubricVersion: 1, scores: DIMS, total: 4, rationale: "r4" },
      latestScore: { id: s1, rubricVersion: 1, scores: DIMS, total: 4, rationale: "r4" },
      scoreChanged: false,
    });
    expect(out[1]).toMatchObject({ narrativeId: n2, score: null, latestScore: null, scoreChanged: false });
    const s2 = score(store, n1, 8, 2 * HOUR, 2);
    score(store, n2, 3, 2 * HOUR);
    out = store.verdictExport();
    expect(out[0]).toMatchObject({ score: { id: s1, total: 4 }, latestScore: { id: s2, rubricVersion: 2, total: 8 }, scoreChanged: true });
    expect(out[1]).toMatchObject({ score: null, latestScore: { total: 3 }, scoreChanged: true });
  });
});

describe("the Narratives list", () => {
  it("filters by the current verdict: good, bad, none; a pill value on every row", () => {
    const { store, n1, n2 } = seeded();
    expect(store.queryNarratives({ verdict: "none" }).map((n) => n.id).sort()).toEqual([n1, n2]);
    store.addNarrativeVerdict(verdict({ verdict: "bad" }), { now: at(HOUR) });
    store.addNarrativeVerdict(verdict({ verdict: "good" }), { now: at(2 * HOUR) });
    store.addNarrativeVerdict(verdict({ narrativeId: n2, verdict: "bad" }), { now: at(HOUR) });
    expect(store.queryNarratives({ verdict: "good" }).map((n) => n.id)).toEqual([n1]);
    expect(store.queryNarratives({ verdict: "bad" }).map((n) => n.id)).toEqual([n2]);
    expect(store.queryNarratives({ verdict: "none" })).toEqual([]);
    expect(store.queryNarratives().map((n) => [n.id, n.verdict]).sort()).toEqual([[n1, "good"], [n2, "bad"]]);
  });

  it("a launchpad Narrative (never judged) can get a verdict with null score fields", () => {
    const { store } = seeded();
    store.recordSignals([{ id: "lp:1", sourceId: "pumpportal:events", sourceLabel: "PumpPortal", title: "Token", summary: "s", url: "", publishedAt: at(0).toISOString() }]);
    const sig = store.unclusteredSignals(5).find((s) => s.id === "lp:1")!;
    const lp = store.createNarrative(sig, [], at(0).toISOString(), { id: "t", dimension: 2 }, { title: "Token", keys: [] });
    expect(store.addNarrativeVerdict(verdict({ narrativeId: lp, verdict: "bad", tags: ["duplicate"] }), { now: at(HOUR) })).toMatchObject({ scoreId: null, rubricVersion: null });
    expect(store.queryNarratives({ kind: "launchpad", verdict: "bad" }).map((n) => n.id)).toEqual([lp]);
  });
});

describe("the schema", () => {
  it("is idempotent on a second open, and an old database without the table opens, reads and gets it", () => {
    const path = join(tempDir("argus-verdict-"), "old.db");
    const { store, n1 } = seeded(path);
    store.addNarrativeVerdict(verdict(), { now: at(HOUR) });
    store.close();
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE narrative_verdicts");
    raw.close();
    const reopened = Datastore.open(path);
    expect(reopened.verdictsFor(n1)).toEqual([]);
    expect(reopened.queryNarratives({ verdict: "none" }).map((n) => n.id)).toContain(n1);
    expect(reopened.addNarrativeVerdict(verdict(), { now: at(HOUR) }).id).toBe(1);
    reopened.close();
    const again = Datastore.open(path);
    expect(again.verdictsFor(n1)).toHaveLength(1);
    again.close();
  });
});
