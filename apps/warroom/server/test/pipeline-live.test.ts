import { Datastore, type PipelineLiveResponse, PIPELINE } from "@argus/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PipelineLivePayload } from "../../app/utils/pipeline-layout.ts";

/** GET /api/pipeline-live: the real route handler over an in-memory store (the rolling-24 h seeding and boundaries are tested in core, pipeline-live.test.ts). */
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("useStore", () => store);
const live = (await import("../api/pipeline-live.get.ts")).default as unknown as () => PipelineLiveResponse;
const graph = (await import("../api/pipeline.get.ts")).default as unknown as () => {
  nodes: Array<{ id: string; rules: Array<{ label: string; value: number | string; display: string; defaultDisplay?: string }> }>;
};

beforeEach(() => {
  store = Datastore.open(":memory:");
});
afterEach(() => {
  delete process.env.ARGUS_META_INTERVAL_MINUTES;
});

const run = (task: string, backend: string, cost: number) => store.finishBrainRun(store.startBrainRun({ proposalId: 0, task, backend, model: "m" }), { sessionId: null, totalCostUsd: cost, exitStatus: "success" });

// The client reads the payload through its own type: the server's response must stay assignable to it (a renamed field fails the type check).
const asPayload = (r: PipelineLiveResponse): PipelineLivePayload => r;

it("returns a count for every edge that has a metric, zeros on a fresh store, and no spend entry for plain-code nodes", () => {
  const out = asPayload(live());
  expect(Object.keys(out.edges).sort()).toEqual(PIPELINE.edges.filter((e) => e.metric !== undefined).map((e) => e.id).sort());
  for (const e of Object.values(out.edges)) expect(e.count).toBe(0);
  expect(Object.keys(out.nodes).sort()).toEqual(["build", "judge", "meta", "proposals", "spec"]);
  expect(JSON.parse(JSON.stringify(out))).toEqual(out);
});

it("keeps Est. usage and real API dollars in separate fields, and reports a study or unknown task under other without crashing", () => {
  run("judge", "claude-code", 0.5);
  run("judge", "api", 0.004);
  run("study", "claude-code", 2);
  run("mystery", "api", 0.3);
  const out = live();
  expect(out.nodes.judge).toEqual({ runs: 1, spendUsd: 0.5, apiRuns: 1, apiUsd: 0.004 });
  expect(out.other).toEqual({ tasks: ["mystery", "study"], runs: 1, spendUsd: 2, apiRuns: 1, apiUsd: 0.3 });
});

it("counts Narratives that passed the gate against the stored Rubric's gate, not the seed", () => {
  store.recordSignals([{ id: "s:1", sourceId: "rss:a", sourceLabel: "Feed", title: "Story", summary: "", url: "https://a.example/1", publishedAt: new Date().toISOString() }]);
  const narrativeId = store.createNarrative(store.unclusteredSignals(5)[0]!, [1, 0], new Date().toISOString(), { id: "e", dimension: 2 });
  store.recordScore({ narrativeId, rubricVersion: 1, scores: { momentum: 7, novelty: 6, buildability: 6.5, hook: 5, legitimacy: 9 }, total: 7, rationale: "r", signalCount: 1, changedMateriallyAt: new Date().toISOString(), createdAt: new Date().toISOString() });
  const r = store.getRubric();
  const passed = () => live().edges["narratives-judge"]!.passedGate;
  store.saveRubric({ baseVersion: r.version, dimensions: r.dimensions.map(({ key, description, weight }) => ({ key, description, weight })), gateMinScore: 6 });
  expect(passed()).toBe(1);
  const r2 = store.getRubric();
  store.saveRubric({ baseVersion: r2.version, dimensions: r2.dimensions.map(({ key, description, weight }) => ({ key, description, weight })), gateMinScore: 7 });
  expect(passed()).toBe(0);
  expect(live().edges["narratives-judge"]!.count).toBe(1);
});

it("GET /api/pipeline shows an env-overridden value as the effective one, with the code's default beside it", () => {
  const meta = () => graph().nodes.find((n) => n.id === "meta")!.rules.find((r) => r.label === "Ranked every")!;
  expect(meta()).toMatchObject({ display: "15 min" });
  expect(meta().defaultDisplay).toBeUndefined();
  process.env.ARGUS_META_INTERVAL_MINUTES = "5";
  expect(meta()).toMatchObject({ value: 5, display: "5 min", defaultDisplay: "15 min" });
});

it("a failing store leaves the route throwing, which the page turns into 'live numbers unavailable' (see pipeline-render.test.ts)", () => {
  store.close();
  expect(() => live()).toThrow();
});
