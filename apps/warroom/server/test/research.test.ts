import { Datastore } from "@argus/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/** Endpoint-level tests: the real route handlers the research panel and the Proposal card call, with only Nitro's auto-imported globals stubbed. */
type Ev = { params: Record<string, string> };
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("getRouterParam", (e: Ev, k: string) => e.params[k]);
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);
vi.stubGlobal("useDataDir", () => "/argus/data");
vi.stubGlobal("useBuildRoot", () => "/builds/code");

const research = (await import("../api/research.get.ts")).default as unknown as () => Record<string, unknown>;
const list = (await import("../api/proposals/index.get.ts")).default as unknown as () => Array<Record<string, unknown>>;
const one = (await import("../api/proposals/[id].get.ts")).default as unknown as (e: Ev) => Record<string, unknown>;

const SCORES = { momentum: 7, novelty: 6, buildability: 8, hook: 5, legitimacy: 9 };
const fields = (name: string) => ({ narrativeSummary: "s", techOneLiner: "t", whyNow: "w", name, ticker: "TKR", description: "d", evidenceLinks: ["https://e.example/1", "https://e.example/2", "https://e.example/3"] });

function narrativeWithScore(): { narrativeId: number; scoreId: number } {
  store.recordSignals([{ id: "s:1", sourceId: "rss:a", sourceLabel: "Feed", title: "Story", summary: "", url: "https://a.example/1", publishedAt: "2026-06-14T09:00:00.000Z" }]);
  const sig = store.unclusteredSignals(5)[0]!;
  const narrativeId = store.createNarrative(sig, [1, 0], new Date().toISOString(), { id: "e", dimension: 2 });
  const scoreId = store.recordScore({ narrativeId, rubricVersion: 1, scores: SCORES, total: 7, rationale: "r", signalCount: 1, changedMateriallyAt: new Date().toISOString(), createdAt: new Date().toISOString() });
  return { narrativeId, scoreId };
}

const ENV = ["ARGUS_DAILY_QUOTA_USD", "ARGUS_RESEARCH_SHARE", "ARGUS_PROPOSE_MAX_NEW_PER_DAY"];
beforeEach(() => {
  store = Datastore.open(":memory:");
  for (const k of ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

it("GET /api/research reports the rolling 24 h research usage against the budget, and the new-Proposal count against its cap", () => {
  const run = (task: string, cost: number) => store.finishBrainRun(store.startBrainRun({ proposalId: 0, task, backend: "claude-code", model: "m" }), { sessionId: null, totalCostUsd: cost, exitStatus: "success" });
  run("judge", 1);
  run("propose", 2);
  run("spec", 50);
  const { narrativeId, scoreId } = narrativeWithScore();
  store.createResearchProposal({ ...fields("Cat"), narrativeId, scoreId });
  const out = research();
  expect(out).toMatchObject({ usedUsd: 3, runs: 2, quotaUsd: 20, share: 0.3, exhausted: false, newProposals: 1, newProposalsCap: 10, windowHours: 24 });
  expect(out.budgetUsd).toBeCloseTo(6, 6);
  expect(out.usedShareOfQuota).toBeCloseTo(0.15, 6);
});

it("GET /api/research follows the same ARGUS_* settings as the worker, and says so when they are invalid", () => {
  process.env.ARGUS_DAILY_QUOTA_USD = "10";
  process.env.ARGUS_RESEARCH_SHARE = "0.5";
  process.env.ARGUS_PROPOSE_MAX_NEW_PER_DAY = "4";
  expect(research()).toMatchObject({ quotaUsd: 10, share: 0.5, budgetUsd: 5, newProposalsCap: 4 });
  process.env.ARGUS_RESEARCH_SHARE = "7";
  expect(() => research()).toThrow(/ARGUS_RESEARCH_SHARE/);
});

it("GET /api/proposals gives a research Proposal its Narrative's latest Score and age, and a hand-entered one none", () => {
  const { narrativeId, scoreId } = narrativeWithScore();
  const researched = store.createResearchProposal({ ...fields("Researched"), narrativeId, scoreId });
  const hand = store.createProposal(fields("Hand"));
  const rows = list();
  const r = rows.find((x) => x.id === researched.id)!;
  expect(r).toMatchObject({ narrativeId, narrativeCreatedAt: expect.any(String), score: { id: scoreId, scores: SCORES, total: 7, rationale: "r" } });
  expect(rows.find((x) => x.id === hand.id)).toMatchObject({ narrativeId: null, narrativeCreatedAt: null, score: null });
});

it("the card follows a re-score: GET /api/proposals/:id returns the latest Score, not the one it was proposed on", () => {
  const { narrativeId, scoreId } = narrativeWithScore();
  const p = store.createResearchProposal({ ...fields("Cat"), narrativeId, scoreId });
  const newer = store.recordScore({ narrativeId, rubricVersion: 1, scores: { ...SCORES, hook: 10 }, total: 8, rationale: "again", signalCount: 1, changedMateriallyAt: new Date().toISOString(), createdAt: new Date().toISOString() });
  expect(one({ params: { id: String(p.id) } })).toMatchObject({ scoreId, score: { id: newer, scores: { hook: 10 } } });
});
