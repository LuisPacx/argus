import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Datastore, type Signal } from "@argus/core";
import { beforeEach, expect, it, vi } from "vitest";

/** Endpoint-level tests: the real /api/activity/* handlers, with only Nitro's auto-imported globals stubbed. */
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("useStore", () => store);

const sources = (await import("../api/activity/sources.get.ts")).default as unknown as () => Array<Record<string, unknown>>;
const narratives = (await import("../api/activity/narratives.get.ts")).default as unknown as () => Array<Record<string, unknown>>;
const brainRuns = (await import("../api/activity/brain-runs.get.ts")).default as unknown as () => Array<Record<string, unknown>>;

beforeEach(() => {
  store = Datastore.open(":memory:");
});

const sig = (n: number, sourceId = "rss:a"): Signal => ({
  id: `${sourceId}:${n}`,
  sourceId,
  sourceLabel: `Label ${sourceId}`,
  title: `Story ${n}`,
  summary: "",
  url: `https://e.example/${n}`,
  publishedAt: "2026-06-14T09:00:00.000Z",
});
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

it("GET /api/activity/sources lists one row per Source, sorted, with the 24 h count and the last error", () => {
  store.recordSignals([sig(1, "rss:b")]);
  store.recordSignals([sig(2, "rss:b")], hoursAgo(25));
  store.recordSignals([sig(3, "rss:legacy")]);
  store.recordSourcePoll({ sourceId: "rss:b", label: "B feed" }, hoursAgo(2));
  store.recordSourcePoll({ sourceId: "rss:b", label: "B feed", error: "HTTP 503" }, hoursAgo(1));
  store.recordSourcePoll({ sourceId: "rss:a", label: "A feed" }, hoursAgo(1));
  expect(sources()).toEqual([
    { sourceId: "rss:a", label: "A feed", lastPolledAt: expect.any(String), lastOkAt: expect.any(String), lastError: null, lastErrorAt: null, signals24h: 0 },
    { sourceId: "rss:b", label: "B feed", lastPolledAt: expect.any(String), lastOkAt: expect.any(String), lastError: "HTTP 503", lastErrorAt: expect.any(String), signals24h: 1 },
    { sourceId: "rss:legacy", label: "Label rss:legacy", lastPolledAt: null, lastOkAt: null, lastError: null, lastErrorAt: null, signals24h: 1 },
  ]);
  const b = sources()[1]!;
  expect(Date.parse(b.lastOkAt as string)).toBeLessThan(Date.parse(b.lastErrorAt as string));
});

const SCORES = { momentum: 7, novelty: 6, buildability: 8, hook: 5, legitimacy: 9 };
let n = 0;
function narrative(createdAt: Date): number {
  n += 1;
  store.recordSignals([sig(1000 + n, `rss:n${n}`)]);
  const signal = store.unclusteredSignals(500).find((s) => s.sourceId === `rss:n${n}`)!;
  return store.createNarrative(signal, [1, 0], createdAt.toISOString(), { id: "e", dimension: 2 });
}
const score = (narrativeId: number, buildability: number, rubricVersion = 1, total = 7) =>
  store.recordScore({ narrativeId, rubricVersion, scores: { ...SCORES, buildability }, total, rationale: "r", signalCount: 1, changedMateriallyAt: new Date().toISOString(), createdAt: new Date().toISOString() });

it("GET /api/activity/narratives: an unjudged Narrative has score and gate null", () => {
  const id = narrative(hoursAgo(1));
  expect(narratives()).toEqual([
    { id, title: expect.stringContaining("Story"), signalCount: 1, createdAt: expect.any(String), lastSignalAt: expect.any(String), score: null, gate: null },
  ]);
});

it("GET /api/activity/narratives: a judged Narrative shows its latest Score and a passing gate", () => {
  const id = narrative(hoursAgo(1));
  score(id, 3, 1, 4);
  const latest = score(id, 8, 1, 7.5);
  const min = store.getRubric(1).gateMinScore;
  const [row] = narratives();
  expect(row).toEqual({
    id,
    title: expect.any(String),
    signalCount: 1,
    createdAt: expect.any(String),
    lastSignalAt: expect.any(String),
    score: { total: 7.5, rubricVersion: 1, createdAt: store.latestScore(id)!.createdAt, scores: { ...SCORES, buildability: 8 } },
    gate: { dimension: "buildability", value: 8, min, passed: 8 >= min },
  });
  expect(latest).toBeGreaterThan(0);
  expect((row!.gate as { passed: boolean }).passed).toBe(true);
});

it("GET /api/activity/narratives: the gate uses the Rubric version the Score used, not the current one", () => {
  const id = narrative(hoursAgo(1));
  const v1 = store.getRubric(1);
  const value = v1.gateMinScore - 1;
  score(id, value, 1);
  const dims = v1.dimensions.map(({ key, description, weight }) => ({ key, description, weight }));
  store.saveRubric({ baseVersion: 1, dimensions: dims, gateMinScore: value - 1 });
  expect(store.getRubric().gateMinScore).toBeLessThanOrEqual(value); // the current Rubric would pass it
  expect(narratives()[0]!.gate).toEqual({ dimension: "buildability", value, min: v1.gateMinScore, passed: false });
});

it("GET /api/activity/narratives: newest 20 by createdAt, ties by id descending", () => {
  const ids: number[] = [];
  for (let i = 0; i < 22; i++) ids.push(narrative(hoursAgo(100 - i)));
  const tie = hoursAgo(0.5);
  const a = narrative(tie);
  const b = narrative(tie);
  const rows = narratives();
  expect(rows).toHaveLength(20);
  expect(rows.map((r) => r.id)).toEqual([b, a, ...ids.slice().reverse().slice(0, 18)]);
});

it("GET /api/activity/brain-runs: finished, in-flight, interrupted, pre-migration, API and excluded runs", () => {
  const start = (task: string, backend = "claude-code", narrativeId?: number) =>
    store.startBrainRun({ proposalId: 0, task, backend, model: "m", ...(narrativeId ? { narrativeId } : {}) }, new Date(Date.now() - 90_000));
  const done = start("judge");
  store.finishBrainRun(done, { sessionId: null, totalCostUsd: 0.5, exitStatus: "success" });
  const interrupted = start("propose");
  store.interruptStaleBrainRuns(() => 1000);
  const api = start("judge", "api");
  store.finishBrainRun(api, { sessionId: null, totalCostUsd: 0.004, exitStatus: "success" });
  start("spec");
  store.finishBrainRun(start("build"), { sessionId: null, totalCostUsd: 9, exitStatus: "success" });
  const open = start("propose");
  const rows = brainRuns();
  expect(rows.map((r) => r.id)).toEqual([open, api, interrupted, done]);
  expect(rows[0]).toEqual({
    id: open, task: "propose", status: "in-flight", backend: "claude-code", model: "m", narrativeId: null, proposalId: 0,
    estCostUsd: 0, costKind: "est", startedAt: expect.any(String), finishedAt: null, durationSec: null,
  });
  expect(rows[1]).toMatchObject({ id: api, backend: "api", costKind: "api", estCostUsd: 0.004, status: "success" });
  expect(rows[2]).toMatchObject({ id: interrupted, status: "interrupted", finishedAt: expect.any(String), durationSec: expect.any(Number) });
  expect(rows[3]).toMatchObject({ id: done, status: "success", costKind: "est", estCostUsd: 0.5, durationSec: 90 });
  expect(Date.parse(rows[3]!.finishedAt as string) - Date.parse(rows[3]!.startedAt as string)).toBeGreaterThanOrEqual(90_000);
});

it("GET /api/activity/brain-runs: a finished row from before the finished_at column has finishedAt and durationSec null", () => {
  const dir = mkdtempSync(join(tmpdir(), "argus-activity-"));
  const path = join(dir, "argus.db");
  const first = Datastore.open(path);
  const id = first.startBrainRun({ proposalId: 0, task: "judge", backend: "claude-code", model: "m" });
  first.finishBrainRun(id, { sessionId: null, totalCostUsd: 1, exitStatus: "success" });
  first.close();
  const raw = new DatabaseSync(path);
  raw.exec("UPDATE brain_runs SET finished_at = NULL");
  raw.close();
  store = Datastore.open(path);
  expect(brainRuns()).toEqual([
    { id, task: "judge", status: "success", backend: "claude-code", model: "m", narrativeId: null, proposalId: 0, estCostUsd: 1, costKind: "est", startedAt: expect.any(String), finishedAt: null, durationSec: null },
  ]);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it("GET /api/activity/brain-runs: the list stops at the newest 20", () => {
  for (let i = 0; i < 22; i++) store.recordBrainRun({ proposalId: 0, task: "judge", backend: "claude-code", model: "m", sessionId: null, totalCostUsd: 0, exitStatus: "success" });
  const rows = brainRuns();
  expect(rows).toHaveLength(20);
  expect(rows[0]!.id).toBe(22);
  expect(rows[19]!.id).toBe(3);
});

it("every /api/activity/* handler is a .get.ts, and the page has no button, form or click handler", () => {
  const dir = join(import.meta.dirname, "../api/activity");
  expect(readdirSync(dir).filter((f) => !f.endsWith(".get.ts"))).toEqual([]);
  expect(readdirSync(dir).sort()).toEqual(["brain-runs.get.ts", "narratives.get.ts", "sources.get.ts"]);
  const page = readFileSync(join(import.meta.dirname, "../../app/pages/activity.vue"), "utf8");
  expect(page).not.toMatch(/@click|<form|<button|<UButton|useStore|method:/);
});

it("activity.vue starts timers only inside onMounted and refreshes on one 10 s interval", () => {
  const page = readFileSync(join(import.meta.dirname, "../../app/pages/activity.vue"), "utf8");
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(page)![1]!;
  // Strip every onMounted(() => { ... }) body (closing brace at column 0 of the call), then no timer may remain.
  const outside = script.replace(/onMounted\(\(\) => \{[\s\S]*?\n\}\);/g, "");
  expect(outside).not.toMatch(/\b(setInterval|setTimeout)\(/);
  expect(script.match(/setInterval\(refresh, 10_000\)/g)).toHaveLength(1);
  expect(script).toMatch(/onBeforeUnmount/);
  expect(script).not.toMatch(/ref\(Date\.now\(\)\)/); // the clock starts at a fixed value, so the server and client first render agree
  const render = page.slice(page.indexOf("<template>"));
  expect(render).not.toMatch(/Date\.now|new Date\(\)/);
});
