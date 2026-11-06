import { describe, expect, it } from "vitest";
import { BRAIN_RUN_IN_FLIGHT, Datastore } from "./datastore.ts";

const NOW = new Date("2026-06-14T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const SINCE = hoursAgo(24).toISOString();
const CAPS = { judge: 0.02, propose: 0.05 };

function run(store: Datastore, o: { task?: string; backend?: string; cost?: number; exit?: string; at?: Date; proposalId?: number }): number {
  const id = store.startBrainRun({ proposalId: o.proposalId ?? 0, task: o.task ?? "judge", backend: o.backend ?? "api", model: "m" }, o.at ?? NOW);
  if ((o.exit ?? "success") !== BRAIN_RUN_IN_FLIGHT) store.finishBrainRun(id, { sessionId: null, totalCostUsd: o.cost ?? 0, exitStatus: o.exit ?? "success" });
  return id;
}

describe("real-dollar API spend (kept apart from Est. usage)", () => {
  it("sums what API runs reported in the last 24 hours, ignoring subscription runs and older ones", () => {
    const store = Datastore.open(":memory:");
    run(store, { cost: 0.004 });
    run(store, { task: "propose", cost: 0.006 });
    run(store, { backend: "claude-code", cost: 5 });
    run(store, { cost: 9, at: hoursAgo(25) });
    expect(store.apiSpendSince(SINCE, CAPS)).toEqual({ runs: 2, costUsd: 0.01, chargedUsd: 0.01 });
  });

  it("charges an API run that never reported a cost (in flight, interrupted, timed out) at its task's cap; a plain failure is not charged beyond what it reported", () => {
    const store = Datastore.open(":memory:");
    run(store, { exit: BRAIN_RUN_IN_FLIGHT });
    run(store, { task: "propose", exit: "interrupted" });
    run(store, { exit: "timed-out" });
    run(store, { exit: "failed" });
    run(store, { exit: "invalid-output", cost: 0.003 });
    const spend = store.apiSpendSince(SINCE, CAPS);
    expect(spend.runs).toBe(5);
    expect(spend.costUsd).toBeCloseTo(0.003, 10);
    expect(spend.chargedUsd).toBeCloseTo(0.02 + 0.05 + 0.02 + 0.003, 10);
  });

  it("a failed API call whose cost was unknown carries its ceiling as its cost, so it is counted", () => {
    const store = Datastore.open(":memory:");
    run(store, { exit: "failed", cost: 0.0015 });
    expect(store.apiSpendSince(SINCE, CAPS).chargedUsd).toBeCloseTo(0.0015, 10);
  });

  it("API runs never count towards Est. usage (the judge, propose and research figures), but do count as runs", () => {
    const store = Datastore.open(":memory:");
    run(store, { backend: "claude-code", cost: 1 });
    run(store, { backend: "api", cost: 0.5 });
    run(store, { backend: "api", exit: BRAIN_RUN_IN_FLIGHT });
    for (const spend of [store.judgeSpendSince(SINCE, CAPS), store.researchSpendSince(SINCE, CAPS)]) {
      expect(spend).toEqual({ runs: 3, costUsd: 1, chargedUsd: 1 });
    }
  });

  it("finishing a run can record the backend and model that actually ran it (the fallback may switch them mid-run)", () => {
    const store = Datastore.open(":memory:");
    const id = store.startBrainRun({ proposalId: 0, narrativeId: undefined, task: "judge", backend: "claude-code", model: "haiku" }, NOW);
    store.finishBrainRun(id, { sessionId: null, totalCostUsd: 0.002, exitStatus: "success", backend: "api", model: "claude-haiku-5-5" });
    expect(store.apiSpendSince(SINCE, CAPS)).toMatchObject({ runs: 1, chargedUsd: 0.002 });
    const other = store.startBrainRun({ proposalId: 0, task: "judge", backend: "claude-code", model: "haiku" }, NOW);
    store.finishBrainRun(other, { sessionId: null, totalCostUsd: 0.01, exitStatus: "success" }); // untouched when not given
    expect(store.apiSpendSince(SINCE, CAPS).runs).toBe(1);
  });

  it("a Proposal's Est. usage leaves API runs out and its API spend is its own figure", () => {
    const store = Datastore.open(":memory:");
    const p = store.createProposal({ narrativeSummary: "s", techOneLiner: "t", whyNow: "w", name: "Cat", ticker: "CAT", description: "d", evidenceLinks: ["https://e.example/1", "https://e.example/2", "https://e.example/3"] });
    run(store, { proposalId: p.id, task: "spec", backend: "claude-code", cost: 0.5 });
    run(store, { proposalId: p.id, task: "propose", backend: "api", cost: 0.004 });
    expect(store.getProposal(p.id)).toMatchObject({ agentCostUsd: 0.5, apiCostUsd: 0.004 });
  });
});
