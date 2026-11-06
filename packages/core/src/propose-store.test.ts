import { describe, expect, it } from "vitest";
import { Datastore, MAX_NEW_PROPOSALS_PER_DAY, NarrativeAlreadyProposedError, ProposalCapReachedError, type NarrativeEmbedder, type NewResearchProposal } from "./datastore.ts";
import type { DimensionScores } from "./rubric.ts";

const NOW = new Date("2026-06-14T12:00:00.000Z");
const CUR: NarrativeEmbedder = { id: "sem-test", dimension: 2 };
const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const SCORES: DimensionScores = { momentum: 7, novelty: 6, buildability: 8, hook: 5, legitimacy: 9 };

let n = 0;
function addNarrative(store: Datastore, opts: { at?: Date; embedder?: NarrativeEmbedder } = {}): number {
  const id = `s:${++n}`;
  store.recordSignals([{ id, sourceId: "rss:a", sourceLabel: "Feed", title: `Story ${n}`, summary: "", url: `https://a.example/${id}`, publishedAt: "2026-06-14T09:00:00.000Z" }]);
  const sig = store.unclusteredSignals(500).find((s) => s.id === id)!;
  return store.createNarrative(sig, [1, 0], (opts.at ?? NOW).toISOString(), opts.embedder ?? CUR);
}

function score(store: Datastore, narrativeId: number, over: Partial<DimensionScores> = {}, at = NOW): number {
  const scores = { ...SCORES, ...over };
  return store.recordScore({ narrativeId, rubricVersion: 1, scores, total: Object.values(scores).reduce((a, b) => a + b, 0) / 5, rationale: "r", signalCount: 1, changedMateriallyAt: NOW.toISOString(), createdAt: at.toISOString() });
}

const fields = (name: string) => ({ narrativeSummary: "s", techOneLiner: "t", whyNow: "w", name, ticker: "TKR", description: "d", evidenceLinks: ["https://e.example/1", "https://e.example/2", "https://e.example/3"] });
const research = (narrativeId: number, scoreId: number, name = "Cat"): NewResearchProposal => ({ ...fields(name), narrativeId, scoreId });

describe("createResearchProposal", () => {
  it("creates a `new` Proposal through the system actor, linked to its Narrative and Score, with its expiry counted from updated_at", () => {
    const store = Datastore.open(":memory:");
    const nid = addNarrative(store, { at: hours(-5) });
    const sid = score(store, nid);
    const p = store.createResearchProposal(research(nid, sid), { now: NOW });
    expect(p).toMatchObject({ status: "new", narrativeId: nid, scoreId: sid, narrativeCreatedAt: hours(-5).toISOString(), createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    expect(p.expiresAt).toBe(hours(48).toISOString());
    expect(store.historyFor(p.id)).toMatchObject([{ from: null, to: "new", actor: "system", at: NOW.toISOString() }]);
    expect(store.historyFor(p.id)[0]!.reason).toContain(`Narrative ${nid}`);
  });

  it("validates the evidence links like a hand-entered Proposal", () => {
    const store = Datastore.open(":memory:");
    const nid = addNarrative(store);
    const sid = score(store, nid);
    expect(() => store.createResearchProposal({ ...research(nid, sid), evidenceLinks: ["javascript:alert(1)"] }, { now: NOW })).toThrow(/http or https/);
    expect(store.listProposals()).toEqual([]);
  });

  it("proposes a Narrative at most once, even after the first Proposal is dismissed", () => {
    const store = Datastore.open(":memory:");
    const nid = addNarrative(store);
    const sid = score(store, nid);
    const first = store.createResearchProposal(research(nid, sid), { now: NOW });
    expect(() => store.createResearchProposal(research(nid, sid, "Dog"), { now: NOW })).toThrow(NarrativeAlreadyProposedError);
    store.transition(first.id, "dismissed", "operator", "no");
    expect(() => store.createResearchProposal(research(nid, sid, "Dog"), { now: hours(30) })).toThrow(NarrativeAlreadyProposedError);
    expect(store.listProposals()).toHaveLength(1);
  });

  it("a hand-entered Proposal has no Narrative and does not count toward the research cap", () => {
    const store = Datastore.open(":memory:");
    for (let i = 0; i < 12; i++) store.createProposal({ ...fields(`Hand ${i}`) });
    const nid = addNarrative(store);
    const p = store.createResearchProposal(research(nid, score(store, nid)), { now: NOW });
    expect(p.narrativeId).toBe(nid);
    expect(store.listProposals().find((x) => x.name === "Hand 0")).toMatchObject({ narrativeId: null, scoreId: null, narrativeCreatedAt: null });
  });

  it("refuses the 11th new Proposal in a rolling day, in the datastore itself", () => {
    expect(MAX_NEW_PROPOSALS_PER_DAY).toBe(10);
    const store = Datastore.open(":memory:");
    for (let i = 0; i < 10; i++) {
      const nid = addNarrative(store);
      store.createResearchProposal(research(nid, score(store, nid), `P${i}`), { now: hours(i) });
    }
    const nid = addNarrative(store);
    const sid = score(store, nid);
    expect(() => store.createResearchProposal(research(nid, sid, "P10"), { now: hours(11) })).toThrow(ProposalCapReachedError);
    expect(store.listProposals()).toHaveLength(10);
    // The count rolls: the first Proposal (hour 0) is more than 24 h old at hour 24.5.
    expect(store.createResearchProposal(research(nid, sid, "P10"), { now: hours(24.5) })).toMatchObject({ name: "P10" });
    expect(store.researchProposalsSince(hours(24.5 - 24).toISOString())).toBe(10);
  });

  it("a caller can lower the cap but never raise it above 10", () => {
    const store = Datastore.open(":memory:");
    const a = addNarrative(store);
    store.createResearchProposal(research(a, score(store, a), "A"), { now: NOW, maxPerDay: 1 });
    const b = addNarrative(store);
    expect(() => store.createResearchProposal(research(b, score(store, b), "B"), { now: NOW, maxPerDay: 1 })).toThrow(ProposalCapReachedError);
    const store2 = Datastore.open(":memory:");
    for (let i = 0; i < 10; i++) {
      const nid = addNarrative(store2);
      store2.createResearchProposal(research(nid, score(store2, nid), `P${i}`), { now: NOW, maxPerDay: 500 });
    }
    const nid = addNarrative(store2);
    expect(() => store2.createResearchProposal(research(nid, score(store2, nid), "P10"), { now: NOW, maxPerDay: 500 })).toThrow(ProposalCapReachedError);
  });
});

describe("narrativesToPropose", () => {
  const since = hours(-72).toISOString();

  it("offers a scored Narrative that passes the buildability gate, best total first, with its latest Score", () => {
    const store = Datastore.open(":memory:");
    const a = addNarrative(store);
    const b = addNarrative(store);
    score(store, a, { momentum: 5 });
    const sb = score(store, b, { momentum: 10 });
    const out = store.narrativesToPropose(CUR, since, 5, 10);
    expect(out.map((c) => c.narrative.id)).toEqual([b, a]);
    expect(out[0]!.score.id).toBe(sb);
  });

  it("applies the gate to buildability only: at the minimum passes, below it never", () => {
    const store = Datastore.open(":memory:");
    const atGate = addNarrative(store);
    const below = addNarrative(store);
    score(store, atGate, { buildability: 5 });
    score(store, below, { buildability: 4.9, momentum: 10, novelty: 10, hook: 10, legitimacy: 10 });
    expect(store.narrativesToPropose(CUR, since, 5, 10).map((c) => c.narrative.id)).toEqual([atGate]);
  });

  it("judges the gate on the latest Score: a re-score below the gate withdraws the Narrative", () => {
    const store = Datastore.open(":memory:");
    const a = addNarrative(store);
    score(store, a, { buildability: 9 });
    score(store, a, { buildability: 2 }, hours(1));
    expect(store.narrativesToPropose(CUR, since, 5, 10)).toEqual([]);
  });

  it("leaves out unscored Narratives, proposed ones, other embedders, and Narratives outside the window", () => {
    const store = Datastore.open(":memory:");
    addNarrative(store); // unscored
    const proposed = addNarrative(store);
    store.createResearchProposal(research(proposed, score(store, proposed)), { now: NOW });
    const other = addNarrative(store, { embedder: { id: "hashing-v1", dimension: 2 } });
    score(store, other);
    const old = addNarrative(store, { at: hours(-100) });
    score(store, old);
    expect(store.narrativesToPropose(CUR, since, 5, 10)).toEqual([]);
  });

  it("parks a Narrative whose propose run was refused or over budget until it is scored again; other failures stay eligible", () => {
    const store = Datastore.open(":memory:");
    const refused = addNarrative(store);
    const dear = addNarrative(store);
    const flaky = addNarrative(store);
    const inFlight = addNarrative(store);
    for (const id of [refused, dear, flaky, inFlight]) score(store, id);
    const run = (narrativeId: number, status?: string) => {
      const r = store.startBrainRun({ proposalId: 0, narrativeId, task: "propose", backend: "claude-code", model: "sonnet" }, hours(1));
      if (status) store.finishBrainRun(r, { sessionId: null, totalCostUsd: 0.1, exitStatus: status });
    };
    run(refused, "invalid-output");
    run(dear, "budget-exceeded");
    run(flaky, "failed");
    run(inFlight);
    expect(store.narrativesToPropose(CUR, since, 5, 10).map((c) => c.narrative.id)).toEqual([flaky]);
    score(store, refused, {}, hours(2)); // judged again after the refusal
    expect(store.narrativesToPropose(CUR, since, 5, 10).map((c) => c.narrative.id).sort()).toEqual([refused, flaky].sort());
  });

  it("returns at most `limit`", () => {
    const store = Datastore.open(":memory:");
    for (let i = 0; i < 4; i++) {
      const id = addNarrative(store);
      score(store, id);
    }
    expect(store.narrativesToPropose(CUR, since, 5, 2)).toHaveLength(2);
  });
});

describe("research spend", () => {
  it("sums judge and propose runs started in the window, whatever their ending, and nothing else", () => {
    const store = Datastore.open(":memory:");
    const add = (task: string, cost: number, at: Date, status = "success") => {
      const id = store.startBrainRun({ proposalId: 0, task, backend: "claude-code", model: "m" }, at);
      store.finishBrainRun(id, { sessionId: null, totalCostUsd: cost, exitStatus: status });
    };
    add("judge", 0.5, hours(-1));
    add("propose", 1.25, hours(-2), "invalid-output");
    add("propose", 9, hours(-30)); // older than the window
    add("spec", 3, hours(-1));
    add("build", 4, hours(-1));
    expect(store.researchSpendSince(hours(-24).toISOString())).toEqual({ runs: 2, costUsd: 1.75, chargedUsd: 1.75 });
    expect(store.proposeSpendSince(hours(-24).toISOString())).toEqual({ runs: 1, costUsd: 1.25, chargedUsd: 1.25 });
  });

  it("charges a run that ended without a reported cost (timed out, interrupted, left in flight by a dead worker) at its task's cap, and keeps the reported cost apart", () => {
    const store = Datastore.open(":memory:");
    const add = (task: string, cost: number, status: string) => {
      const id = store.startBrainRun({ proposalId: 0, task, backend: "claude-code", model: "m" }, hours(-1));
      if (status !== "in-flight") store.finishBrainRun(id, { sessionId: null, totalCostUsd: cost, exitStatus: status });
    };
    add("propose", 0, "timed-out");
    add("judge", 0, "interrupted");
    add("propose", 0, "in-flight");
    add("propose", 0.3, "timed-out"); // a cost was reported: that is what it is charged
    add("judge", 0.02, "success");
    add("propose", 0, "failed"); // a failure with no cost may be a claude that never started: not charged
    const caps = { judge: 0.1, propose: 1 };
    const out = store.researchSpendSince(hours(-24).toISOString(), caps);
    expect(out.runs).toBe(6);
    expect(out.costUsd).toBeCloseTo(0.32, 10);
    expect(out.chargedUsd).toBeCloseTo(1 + 0.1 + 1 + 0.3 + 0.02, 10);
    expect(store.proposeSpendSince(hours(-24).toISOString(), caps).chargedUsd).toBeCloseTo(2.3, 10);
    // Without caps nothing is charged beyond the reported cost.
    expect(store.researchSpendSince(hours(-24).toISOString()).chargedUsd).toBeCloseTo(0.32, 10);
  });
});
