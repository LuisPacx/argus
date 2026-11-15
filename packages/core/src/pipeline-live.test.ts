import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Datastore, type NewProposal } from "./datastore.ts";
import { PIPELINE } from "./pipeline-graph.ts";
import { resolvePipelineLive } from "./pipeline-live.ts";
import { tempPath } from "./testing/temp.ts";

const HOUR = 3_600_000;
const NOW = new Date("2026-11-14T12:00:00.000Z");
/** 23 h 59 m old: inside the rolling 24 h. */
const IN = new Date(NOW.getTime() - 24 * HOUR + 60_000);
/** 24 h 01 m old: outside it. */
const OUT = new Date(NOW.getTime() - 24 * HOUR - 60_000);
const EMBEDDER = { id: "e", dimension: 2 };
const SCORES = (buildability: number) => ({ momentum: 7, novelty: 6, buildability, hook: 5, legitimacy: 9 });
const fields = (name: string): NewProposal => ({ narrativeSummary: "s", techOneLiner: "t", whyNow: "w", name, ticker: "TKR", description: "d", evidenceLinks: ["https://e.example/1", "https://e.example/2", "https://e.example/3"] });

let path: string;
let store: Datastore;
let raw: DatabaseSync;

beforeEach(() => {
  path = tempPath("pipeline-live", ".db");
  store = Datastore.open(path);
  raw = new DatabaseSync(path);
});
afterEach(() => {
  raw.close();
  store.close();
});

const signal = (id: string, at: Date) => store.recordSignals([{ id, sourceId: "rss:a", sourceLabel: "Feed", title: id, summary: "", url: `https://a.example/${id}`, publishedAt: "2026-11-14T09:00:00.000Z" }], at);
function narrative(id: string, createdAt: Date, signalAt: Date): number {
  signal(id, signalAt);
  const sig = store.unclusteredSignals(50).find((s) => s.id === id)!;
  return store.createNarrative(sig, [1, 0], createdAt.toISOString(), EMBEDDER);
}
const score = (narrativeId: number, buildability: number, at: Date) =>
  store.recordScore({ narrativeId, rubricVersion: 1, scores: SCORES(buildability), total: 7, rationale: "r", signalCount: 1, changedMateriallyAt: at.toISOString(), createdAt: at.toISOString() });
function run(task: string, backend: string, cost: number, at: Date): void {
  store.finishBrainRun(store.startBrainRun({ proposalId: 0, task, backend, model: "m" }, at), { sessionId: null, totalCostUsd: cost, exitStatus: "success" });
}

describe("Datastore.pipelineLive and resolvePipelineLive", () => {
  it("counts every edge metric over the rolling 24 h, with a row at 23 h 59 m counted and one at 24 h 01 m not", () => {
    // Signals: ingested in, in, out.
    signal("sig-a", IN);
    signal("sig-b", IN);
    signal("sig-c", OUT);
    // Narratives: created in, out, in.
    const n1 = narrative("n1", IN, IN);
    const n2 = narrative("n2", OUT, IN);
    const n3 = narrative("n3", IN, IN);
    // Scores: n1 twice in the window (counts once; one passes the gate of 7), n3 once (does not pass), n2 only outside it.
    const s1 = score(n1, 8, IN);
    score(n1, 5, IN);
    score(n3, 4, IN);
    const s2 = score(n2, 9, OUT);
    // Proposals: n1's inside the window, n2's outside it, and one hand-entered (no Narrative, never counted).
    const p1 = store.createResearchProposal({ ...fields("One"), narrativeId: n1, scoreId: s1 }, { now: IN });
    const p2 = store.createResearchProposal({ ...fields("Two"), narrativeId: n2, scoreId: s2 }, { now: OUT });
    const p3 = store.createProposal(fields("Three"));
    // p1: shortlisted, spec drafted, approved, built. p3: the same, but its first Build fails and the re-queued one is built. p2 only shortlisted, outside the window.
    for (const [id, steps] of [
      [p1.id, [["shortlisted", "operator"], ["spec-drafted", "system"], ["approved", "operator"], ["building", "build"], ["built", "build"]]],
      [p3.id, [["shortlisted", "operator"], ["spec-drafted", "system"], ["approved", "operator"], ["building", "build"], ["build-failed", "build"], ["approved", "operator"], ["building", "build"], ["built", "build"]]],
      [p2.id, [["shortlisted", "operator"]]],
    ] as const) {
      for (const [to, actor] of steps) store.transition(id, to, actor);
    }
    raw.prepare("UPDATE status_history SET at = ? WHERE proposal_id = ?").run(OUT.toISOString(), p2.id);
    raw.prepare("UPDATE status_history SET at = ? WHERE proposal_id IN (?, ?)").run(IN.toISOString(), p1.id, p3.id);
    // PumpPortal creates (the Study's tokens): in, in, out.
    for (const [mint, at] of [["m1", IN], ["m2", IN], ["m3", OUT]] as const) raw.prepare("INSERT INTO study_tokens (mint, status, first_seen_at) VALUES (?, 'seen', ?)").run(mint, at.toISOString());
    // Brain runs: two judge runs and one API judge run in the window, one judge run outside it, one run per other task, and two tasks no node owns.
    run("judge", "claude-code", 0.5, IN);
    run("judge", "claude-code", 0.25, IN);
    run("judge", "api", 0.004, IN);
    run("judge", "claude-code", 9, OUT);
    run("propose", "claude-code", 1, IN);
    run("spec", "claude-code", 2, IN);
    run("build", "claude-code", 3, IN);
    run("meta-summary", "claude-code", 0.05, IN);
    run("study", "claude-code", 7, IN);
    run("weird", "api", 0.2, IN);

    const data = store.pipelineLive(NOW, 7);
    expect(data.since).toBe("2026-11-13T12:00:00.000Z");
    expect(data.counts).toEqual({
      signals_ingested: 5, // sig-a, sig-b and the three Narratives' own Signals at 23 h 59 m; sig-c at 24 h 01 m is out
      creates_seen: 2,
      narratives_created: 2,
      narratives_judged: 2,
      proposals_created: 1,
      shortlisted: 2,
      spec_drafted: 2,
      approved: 2,
      build_finished: 3,
      built: 2,
    });
    expect(data.narrativesPassedGate).toBe(1);

    const live = resolvePipelineLive(PIPELINE, data);
    expect(live.edges["narratives-judge"]).toEqual({ metric: "narratives_judged", count: 2, passedGate: 1 });
    expect(live.edges["sources-signals"]).toEqual({ metric: "signals_ingested", count: 5 });
    expect(live.edges["sources-study"]).toEqual({ metric: "creates_seen", count: 2 }); // PumpPortal creates are their own edge, apart from Signals
    expect(live.edges["approve-build"]).toEqual({ metric: "build_finished", count: 3 });
    expect(live.edges["build-preview"]).toEqual({ metric: "built", count: 2 });
    expect(live.edges["sources-meta"]).toBeUndefined(); // an edge with no metric has no number
    expect(live.nodes.judge).toEqual({ runs: 2, spendUsd: 0.75, apiRuns: 1, apiUsd: 0.004 }); // Est. usage and real dollars are separate fields
    expect(live.nodes.proposals).toEqual({ runs: 1, spendUsd: 1, apiRuns: 0, apiUsd: 0 });
    expect(live.nodes.spec).toEqual({ runs: 1, spendUsd: 2, apiRuns: 0, apiUsd: 0 });
    expect(live.nodes.build).toEqual({ runs: 1, spendUsd: 3, apiRuns: 0, apiUsd: 0 });
    expect(live.nodes.meta).toEqual({ runs: 1, spendUsd: 0.05, apiRuns: 0, apiUsd: 0 });
    expect(live.nodes.study).toBeUndefined(); // plain code: no brain task, no spend
    // An unknown or retired task (a `study` run, or anything else) is reported under "other" and never crashes the read.
    expect(live.other).toEqual({ tasks: ["study", "weird"], runs: 1, spendUsd: 7, apiRuns: 1, apiUsd: 0.2 });
    expect(live.windowHours).toBe(24);
  });

  it("an empty store gives zeros, and every edge metric in the graph has a count (a metric nobody counts would show no number)", () => {
    const data = store.pipelineLive(NOW, 7);
    const metrics = PIPELINE.edges.flatMap((e) => (e.metric === undefined ? [] : [e.metric]));
    expect(metrics.length).toBeGreaterThan(8);
    for (const m of metrics) expect(data.counts[m], m).toBe(0);
    expect(Object.keys(data.counts).sort()).toEqual([...new Set(metrics)].sort()); // and no count is computed that no edge shows
    const live = resolvePipelineLive(PIPELINE, data);
    expect(Object.keys(live.edges)).toHaveLength(PIPELINE.edges.filter((e) => e.metric !== undefined).length);
    expect(live.nodes.judge).toEqual({ runs: 0, spendUsd: 0, apiRuns: 0, apiUsd: 0 });
    expect(live.other).toEqual({ tasks: [], runs: 0, spendUsd: 0, apiRuns: 0, apiUsd: 0 });
  });

  it("every count reads through an index on its time column (no table scan)", () => {
    const plan = (sql: string): string => (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("2026-11-13T12:00:00.000Z") as unknown as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
    const cases: Array<[string, string, string]> = [
      ["SELECT COUNT(*) FROM signals WHERE ingested_at >= ?", "signals", "signals_ingested_at"],
      ["SELECT COUNT(*) FROM study_tokens WHERE first_seen_at >= ?", "study_tokens", "study_tokens_first_seen"],
      ["SELECT COUNT(*) FROM narratives WHERE created_at >= ?", "narratives", "narratives_created_at"],
      ["SELECT COUNT(DISTINCT narrative_id) AS judged, COUNT(DISTINCT CASE WHEN json_extract(scores, '$.buildability') >= 7 THEN narrative_id END) AS passed FROM scores WHERE created_at >= ?", "scores", "scores_created_at"],
      ["SELECT COUNT(*) FROM proposals WHERE narrative_id IS NOT NULL AND created_at >= ?", "proposals", "proposals_created_at"],
      ["SELECT to_status, COUNT(*) FROM status_history WHERE at >= ? GROUP BY to_status", "status_history", "status_history_at"],
      ["SELECT task, COUNT(*) FROM brain_runs WHERE created_at >= ? GROUP BY task", "brain_runs", "brain_runs_created_at"],
    ];
    for (const [sql, , index] of cases) expect(plan(sql), sql).toContain(index);
  });
});
