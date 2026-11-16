import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore, MAX_NEW_PROPOSALS_PER_DAY, MemeTrioExistsError, NarrativeAlreadyProposedError, ProposalCapReachedError, type NarrativeEmbedder, type NewResearchProposal } from "./datastore.ts";
import { NEWS_MEME_FLOORS, newsMemeKey, type NarrativeSnapshotV3, type NewMemeTrio } from "./meme/types.ts";
import type { DimensionScores } from "./rubric.ts";
import { tempDir } from "./testing/temp.ts";

const NOW = new Date("2026-06-14T12:00:00.000Z");
const CUR: NarrativeEmbedder = { id: "sem-test", dimension: 2 };
const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const SCORES: DimensionScores = { momentum: 7, novelty: 6, buildability: 8, hook: 5, legitimacy: 9 };

let n = 0;
function addNarrative(store: Datastore, opts: { at?: Date; embedder?: NarrativeEmbedder } = {}): number {
  const id = `s:${++n}`;
  store.recordSignals([{ id, sourceId: "pumpportal:events", sourceLabel: "Feed", title: `Story ${n}`, summary: "", url: `https://a.example/${id}`, publishedAt: "2026-06-14T09:00:00.000Z" }]);
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

  it("refuses the Proposal past the cap in a rolling day, in the datastore itself", () => {
    const cap = MAX_NEW_PROPOSALS_PER_DAY;
    const store = Datastore.open(":memory:");
    for (let i = 0; i < cap; i++) {
      const nid = addNarrative(store);
      store.createResearchProposal(research(nid, score(store, nid), `P${i}`), { now: hours(i / 2) });
    }
    const nid = addNarrative(store);
    const sid = score(store, nid);
    const extra = `P${cap}`;
    expect(() => store.createResearchProposal(research(nid, sid, extra), { now: hours(cap / 2 + 1) })).toThrow(ProposalCapReachedError);
    expect(store.listProposals()).toHaveLength(cap);
    // The count rolls: the first Proposal (hour 0) is more than 24 h old at hour 24.5.
    expect(store.createResearchProposal(research(nid, sid, extra), { now: hours(24.5) })).toMatchObject({ name: extra });
    expect(store.researchProposalsSince(hours(24.5 - 24).toISOString())).toBe(cap);
  });

  it("a caller can lower the cap but never raise it above the maximum", () => {
    const store = Datastore.open(":memory:");
    const a = addNarrative(store);
    store.createResearchProposal(research(a, score(store, a), "A"), { now: NOW, maxPerDay: 1 });
    const b = addNarrative(store);
    expect(() => store.createResearchProposal(research(b, score(store, b), "B"), { now: NOW, maxPerDay: 1 })).toThrow(ProposalCapReachedError);
    const store2 = Datastore.open(":memory:");
    for (let i = 0; i < MAX_NEW_PROPOSALS_PER_DAY; i++) {
      const nid = addNarrative(store2);
      store2.createResearchProposal(research(nid, score(store2, nid), `P${i}`), { now: NOW, maxPerDay: 500 });
    }
    const nid = addNarrative(store2);
    expect(() => store2.createResearchProposal(research(nid, score(store2, nid), "Over"), { now: NOW, maxPerDay: 500 })).toThrow(ProposalCapReachedError);
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

  it("never offers a launchpad Narrative, even with a market Signal and a Score at or above the gate; a news one still qualifies", () => {
    const store = Datastore.open(":memory:");
    const news = addNarrative(store);
    score(store, news, { buildability: 9 });
    const id = `s:${++n}`;
    store.recordSignals([{ id, sourceId: "pumpportal:events", sourceLabel: "Feed", title: "Token", summary: "", url: `https://a.example/${id}`, publishedAt: "2026-06-14T09:00:00.000Z" }]);
    const sig = store.unclusteredSignals(500).find((s) => s.id === id)!;
    const lp = store.createNarrative(sig, [], NOW.toISOString(), CUR, { title: "Token", keys: [] });
    score(store, lp, { buildability: 10, momentum: 10 });
    expect(store.narrativeKind(lp)).toBe("launchpad");
    expect(store.narrativeKind(news)).toBe("news");
    expect(store.narrativesToPropose(CUR, since, 5, 10).map((c) => c.narrative.id)).toEqual([news]);
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

describe("collision results on a Proposal", () => {
  const checked = (status: "clear" | "collides" | "unknown", source: string) => ({ status, detail: `${source} says ${status}`, source, checkedAt: NOW.toISOString() });
  const results = { dex: checked("collides", "DexScreener"), github: checked("unknown", "GitHub") };

  it("are stored with the Proposal and read back whole, status, check time and source per result", () => {
    const store = Datastore.open(":memory:");
    const nid = addNarrative(store);
    const p = store.createResearchProposal({ ...research(nid, score(store, nid)), collisions: results }, { now: NOW });
    expect(p.collisions).toEqual(results);
    expect(store.getProposal(p.id)!.collisions).toEqual(results);
    expect(store.listProposals()[0]!.collisions).toEqual(results);
  });

  it("are null, meaning not checked, for a Proposal that was never checked", () => {
    const store = Datastore.open(":memory:");
    expect(store.createProposal(fields("Hand")).collisions).toBeNull();
  });

  it("an older database gains the column, and its Proposals read as not checked", () => {
    const store = Datastore.open(":memory:");
    const nid = addNarrative(store);
    const p = store.createResearchProposal(research(nid, score(store, nid)), { now: NOW });
    expect(p.collisions).toBeNull();
  });

  it("the propose runs of a retried name all become the Proposal's cost", () => {
    const store = Datastore.open(":memory:");
    const nid = addNarrative(store);
    const run = () => store.startBrainRun({ proposalId: 0, narrativeId: nid, task: "propose", backend: "claude-code", model: "sonnet" }, NOW);
    const [a, b] = [run(), run()];
    store.finishBrainRun(a, { sessionId: null, totalCostUsd: 0.2, exitStatus: "success" });
    store.finishBrainRun(b, { sessionId: null, totalCostUsd: 0.3, exitStatus: "success" });
    const p = store.createResearchProposal(research(nid, score(store, nid)), { now: NOW, attachRunId: [a, b] });
    expect(p.agentCostUsd).toBeCloseTo(0.5, 10);
  });
});

// ---------------------------------------------------------------------------------------------------- news memes (proposal-routing ticket 04)

/** A headline Signal (a Source outside the market ones) joined to a Narrative. */
function addHeadline(store: Datastore, narrativeId: number, at: Date = NOW, sourceId = "rss:wire"): void {
  const id = `h:${++n}`;
  store.recordSignals([{ id, sourceId, sourceLabel: "Wire", title: `Headline ${n}`, summary: "", url: `https://wire.example/${id}`, publishedAt: at.toISOString() }], at);
  const sig = store.unclusteredSignals(500).find((s) => s.id === id)!;
  store.joinNarrative(narrativeId, sig, [1, 0], at.toISOString());
}

/** A news story that fails the gate and passes the floors, with a market Signal and a headline. */
function addStory(store: Datastore, over: Partial<DimensionScores> = {}, at: Date = NOW): number {
  const nid = addNarrative(store, { at });
  addHeadline(store, nid, at);
  score(store, nid, { buildability: 3, legitimacy: 6, hook: 8, momentum: 9, ...over }, at);
  return nid;
}

const storySnapshot = (nid: number, scoreId: number): NarrativeSnapshotV3 => ({
  version: 3,
  kind: "narrative",
  capturedAt: NOW.toISOString(),
  narrative: { id: nid, title: "Story", summary: "", signalCount: 2, createdAt: NOW.toISOString(), lastSignalAt: NOW.toISOString() },
  score: { id: scoreId, rubricVersion: 1, total: 6, scores: { ...SCORES, buildability: 3 }, rationale: "r", gateMin: 5, createdAt: NOW.toISOString() },
  trigger: { kind: "news-meme", reason: "buildability 3 under the gate of 5", at: NOW.toISOString() },
  news: [],
});

const newsTrio = (nid: number, scoreId: number): NewMemeTrio => ({
  narrative: { id: nid, scoreId },
  metaKey: newsMemeKey(nid),
  metaLabel: "Story",
  snapshot: storySnapshot(nid, scoreId),
  reason: "News meme: buildability 3 under the gate of 5",
  summary: "From news: Story.",
  evidenceLinks: ["https://wire.example/a"],
  ideas: ["Alpha", "Bravo", "Charlie"].map((x, i) => ({ name: `Idea ${x}`, ticker: ["AAA", "BBB", "CCC"][i]!, angle: "joke", difference: "d", description: "pitch", hook: "gm", imageIdea: "chair", riskLabels: [] })),
});

describe("narrativesToMeme", () => {
  const since = hours(-12).toISOString();
  const pick = (store: Datastore, over: { since?: string } = {}) => store.narrativesToMeme(CUR, over.since ?? since, 5, NEWS_MEME_FLOORS, 10).map((c) => c.narrative.id);

  it("returns a news Narrative with a market Signal and a news Signal whose latest Score is under the gate and over the floors, with that Score", () => {
    const store = Datastore.open(":memory:");
    const nid = addStory(store);
    const out = store.narrativesToMeme(CUR, since, 5, NEWS_MEME_FLOORS, 10);
    expect(out.map((c) => c.narrative.id)).toEqual([nid]);
    expect(out[0]!.score.scores).toMatchObject({ buildability: 3, legitimacy: 6, hook: 8, momentum: 9 });
  });

  it("takes the floors as inclusive and the gate as exclusive; one dimension under its floor leaves the story out", () => {
    const store = Datastore.open(":memory:");
    const edge = addStory(store, { buildability: 4.9, legitimacy: 5, hook: 6, momentum: 6 });
    addStory(store, { buildability: 5 }); // at the gate: a Tech Proposal candidate, not a meme
    addStory(store, { legitimacy: 4.9 });
    addStory(store, { hook: 5.9 });
    addStory(store, { momentum: 5.9 });
    expect(pick(store)).toEqual([edge]);
  });

  it("leaves out a launchpad Narrative, an unscored one, one with no market Signal, one from another embedder and one with an older newest Signal", () => {
    const store = Datastore.open(":memory:");
    const good = addStory(store);
    const id = `s:${++n}`;
    store.recordSignals([{ id, sourceId: "pumpportal:events", sourceLabel: "Feed", title: "Token", summary: "", url: `https://a.example/${id}`, publishedAt: NOW.toISOString() }]);
    const lp = store.createNarrative(store.unclusteredSignals(500).find((s) => s.id === id)!, [], NOW.toISOString(), CUR, { title: "Token", keys: [] });
    addHeadline(store, lp);
    score(store, lp, { buildability: 3, legitimacy: 6, hook: 8, momentum: 9 });
    expect(store.narrativeKind(lp)).toBe("launchpad");
    const unscored = addNarrative(store);
    addHeadline(store, unscored);
    // a context-only Narrative: one headline, no market Signal
    store.recordSignals([{ id: "x:only", sourceId: "rss:wire", sourceLabel: "Wire", title: "Only news", summary: "", url: "https://wire.example/only", publishedAt: NOW.toISOString() }]);
    const noMarket = store.createNarrative(store.unclusteredSignals(500).find((s) => s.id === "x:only")!, [1, 0], NOW.toISOString(), CUR);
    score(store, noMarket, { buildability: 3, legitimacy: 6, hook: 8, momentum: 9 });
    const foreign = addNarrative(store, { embedder: { id: "hashing-v1", dimension: 2 } });
    addHeadline(store, foreign);
    score(store, foreign, { buildability: 3, legitimacy: 6, hook: 8, momentum: 9 });
    const stale = addStory(store, {}, hours(-13)); // its newest Signal is 13 h old
    expect(pick(store)).toEqual([good]);
    expect(pick(store, { since: hours(-14).toISOString() }).sort()).toEqual([good, stale].sort()); // the window is the caller's
  });

  it("needs at least one news Signal: a Narrative of market Signals only is never a story, and the same Narrative with one headline is", () => {
    const store = Datastore.open(":memory:");
    const nid = addNarrative(store); // one pumpportal Signal
    store.recordSignals([{ id: "d:1", sourceId: "dexscreener:trending", sourceLabel: "Dex", title: "FOO coin", summary: "", url: "https://dex.example/foo", publishedAt: NOW.toISOString() }]);
    store.joinNarrative(nid, store.unclusteredSignals(500).find((s) => s.id === "d:1")!, [1, 0], NOW.toISOString());
    score(store, nid, { buildability: 3, legitimacy: 6, hook: 8, momentum: 9 });
    expect(pick(store)).toEqual([]);
    addHeadline(store, nid);
    expect(pick(store)).toEqual([nid]);
  });

  it("judges the latest Score: a re-score that lifts a Narrative over the floors makes it appear, and one that lifts buildability to the gate removes it", () => {
    const store = Datastore.open(":memory:");
    const nid = addStory(store, { hook: 4 });
    expect(pick(store)).toEqual([]);
    score(store, nid, { buildability: 3, legitimacy: 6, hook: 7, momentum: 7 }, hours(1));
    expect(pick(store)).toEqual([nid]);
    score(store, nid, { buildability: 6, legitimacy: 6, hook: 7, momentum: 7 }, hours(2));
    expect(pick(store)).toEqual([]);
  });

  it("leaves a Narrative out for good once it has a meme trio (one trio per Narrative ever), whatever became of the trio, and keeps the others", () => {
    const store = Datastore.open(":memory:");
    const a = addStory(store);
    const b = addStory(store);
    const made = store.createMemeProposals(newsTrio(a, store.latestScore(a)!.id), { now: NOW });
    expect(pick(store)).toEqual([b]);
    for (const p of made) store.transition(p.id, "dismissed", "operator", "no");
    expect(pick(store, { since: hours(-100).toISOString() })).toEqual([b]);
    expect(store.hasMemeEver(newsMemeKey(a))).toBe(true);
    expect(store.hasMemeEver(newsMemeKey(b))).toBe(false);
  });

  it("orders by hook plus momentum, then id, and honours `limit` and `onlyId`", () => {
    const store = Datastore.open(":memory:");
    const low = addStory(store, { hook: 6, momentum: 6 });
    const high = addStory(store, { hook: 9, momentum: 9 });
    expect(pick(store)).toEqual([high, low]);
    expect(store.narrativesToMeme(CUR, since, 5, NEWS_MEME_FLOORS, 1).map((c) => c.narrative.id)).toEqual([high]);
    expect(store.narrativesToMeme(CUR, since, 5, NEWS_MEME_FLOORS, 10, low).map((c) => c.narrative.id)).toEqual([low]);
  });
});

describe("a news meme and the Tech path are independent (proposal-routing ticket 04)", () => {
  it("createMemeProposals stores the Narrative and Score on each idea, refuses a second trio for the same Narrative at any time, and the trio lives 12 h", () => {
    const store = Datastore.open(":memory:");
    const nid = addStory(store);
    const sid = store.latestScore(nid)!.id;
    const made = store.createMemeProposals(newsTrio(nid, sid), { now: NOW });
    expect(made).toHaveLength(3);
    for (const p of made) expect(p).toMatchObject({ kind: "meme", narrativeId: nid, scoreId: sid, metaKey: newsMemeKey(nid), status: "new", expiresAt: hours(12).toISOString() });
    expect(made[0]!.metaSnapshot).toMatchObject({ version: 3, kind: "narrative" });
    expect(() => store.createMemeProposals(newsTrio(nid, sid), { now: hours(1) })).toThrow(MemeTrioExistsError);
    expect(() => store.createMemeProposals(newsTrio(nid, sid), { now: hours(200) })).toThrow(MemeTrioExistsError); // far past the 6 h window of a Meta's trio
    expect(store.listProposals()).toHaveLength(3);
  });

  it("a Narrative with a trio is still offered by narrativesToPropose once its buildability reaches the gate, and gets its Tech Proposal; a Tech Proposal still blocks a second one", () => {
    const store = Datastore.open(":memory:");
    const nid = addStory(store);
    store.createMemeProposals(newsTrio(nid, store.latestScore(nid)!.id), { now: NOW });
    const since = hours(-72).toISOString();
    expect(store.narrativesToPropose(CUR, since, 5, 10)).toEqual([]); // buildability 3: under the gate
    const lifted = score(store, nid, { buildability: 7 }, hours(1));
    expect(store.narrativesToPropose(CUR, since, 5, 10).map((c) => c.narrative.id)).toEqual([nid]);
    const tech = store.createResearchProposal(research(nid, lifted), { now: hours(2) });
    expect(tech).toMatchObject({ kind: "narrative", narrativeId: nid });
    expect(() => store.createResearchProposal(research(nid, lifted, "Dog"), { now: hours(2) })).toThrow(NarrativeAlreadyProposedError);
    expect(store.narrativesToPropose(CUR, since, 5, 10)).toEqual([]); // the Tech Proposal blocks it now
    expect(store.listProposals().filter((p) => p.kind === "meme")).toHaveLength(3);
  });

  it("a Tech Proposal does not stop a news meme either: the selector leaves a Narrative out only for its own trio", () => {
    const store = Datastore.open(":memory:");
    const nid = addStory(store);
    store.createResearchProposal(research(nid, store.latestScore(nid)!.id), { now: NOW });
    expect(store.narrativesToMeme(CUR, hours(-12).toISOString(), 5, NEWS_MEME_FLOORS, 10).map((c) => c.narrative.id)).toEqual([nid]);
  });

  it("the Narrative list's hasProposal means a Tech Proposal: a trio does not set it", () => {
    const store = Datastore.open(":memory:");
    const nid = addStory(store);
    store.createMemeProposals(newsTrio(nid, store.latestScore(nid)!.id), { now: NOW });
    expect(store.queryNarratives({}).find((x) => x.id === nid)!.hasProposal).toBe(false);
    expect(store.queryNarratives({ hasProposal: true })).toEqual([]);
    expect(store.queryNarratives({ hasProposal: false }).map((x) => x.id)).toEqual([nid]);
    store.createResearchProposal(research(nid, score(store, nid, { buildability: 7 }, hours(1))), { now: hours(2) });
    expect(store.queryNarratives({}).find((x) => x.id === nid)!.hasProposal).toBe(true);
  });

  it("researchProposalsSince counts a Tech Proposal and no meme: a trio of news memes and one Tech Proposal count 1", () => {
    const store = Datastore.open(":memory:");
    const a = addStory(store);
    store.createMemeProposals(newsTrio(a, store.latestScore(a)!.id), { now: NOW });
    expect(store.researchProposalsSince(hours(-24).toISOString())).toBe(0);
    const b = addNarrative(store);
    store.createResearchProposal(research(b, score(store, b)), { now: NOW });
    expect(store.researchProposalsSince(hours(-24).toISOString())).toBe(1);
    expect(store.listProposals().filter((p) => p.narrativeId !== null)).toHaveLength(4); // the cap counts by kind, not by the column
  });

  it("the Proposals list's Score sort puts a news meme after the scored ones: it has a Narrative and a Score, but no Score of its own", () => {
    const store = Datastore.open(":memory:");
    const a = addStory(store, { hook: 10, momentum: 10, legitimacy: 10 });
    store.createMemeProposals(newsTrio(a, store.latestScore(a)!.id), { now: hours(1) });
    const b = addNarrative(store);
    const tech = store.createResearchProposal(research(b, score(store, b, { momentum: 1 })), { now: NOW });
    expect(store.queryProposals({ sort: "score" })[0]!.id).toBe(tech.id);
  });
});

describe("the unique index on proposals.narrative_id (proposal-routing ticket 04)", () => {
  const indexSql = (db: DatabaseSync) => (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'proposals_narrative_id'").get() as { sql: string }).sql;

  it("is unique over Tech (`narrative`) rows only, so a trio and a Tech Proposal share a Narrative id, and the database itself refuses a second Tech row", () => {
    const path = join(tempDir("narrative-index-"), "argus.db");
    const store = Datastore.open(path);
    const nid = addStory(store);
    const sid = store.latestScore(nid)!.id;
    store.createMemeProposals(newsTrio(nid, sid), { now: NOW });
    store.createResearchProposal(research(nid, sid), { now: NOW });
    store.close();
    const raw = new DatabaseSync(path);
    expect(indexSql(raw)).toContain("kind = 'narrative'");
    const insert = () => raw.prepare("INSERT INTO proposals (slug, status, kind, narrative_id, created_at, updated_at) VALUES (?, 'new', 'narrative', ?, ?, ?)").run(`dup-${Math.random()}`, nid, NOW.toISOString(), NOW.toISOString());
    expect(insert).toThrow(/UNIQUE/);
    raw.close();
  });

  it("an existing database with the old index (every narrative_id unique) is migrated by opening it, and opening it again changes nothing", () => {
    const path = join(tempDir("narrative-index-old-"), "argus.db");
    const first = Datastore.open(path);
    const nid = addStory(first);
    const tech = first.createResearchProposal(research(nid, first.latestScore(nid)!.id), { now: NOW });
    first.close();
    // Put the database back as the live one is: the index as it was made before the change.
    const old = new DatabaseSync(path);
    old.exec("DROP INDEX proposals_narrative_id");
    old.exec("CREATE UNIQUE INDEX proposals_narrative_id ON proposals (narrative_id) WHERE narrative_id IS NOT NULL");
    expect(indexSql(old)).not.toContain("kind");
    old.close();
    const second = Datastore.open(path);
    second.createMemeProposals(newsTrio(nid, tech.scoreId!), { now: NOW }); // the old index would refuse this
    second.close();
    const check = new DatabaseSync(path);
    const sql = indexSql(check);
    expect(sql).toContain("kind = 'narrative'");
    const rows = (check.prepare("SELECT COUNT(*) AS c FROM proposals").get() as { c: number }).c;
    check.close();
    Datastore.open(path).close();
    const again = new DatabaseSync(path);
    expect(indexSql(again)).toBe(sql);
    expect((again.prepare("SELECT COUNT(*) AS c FROM proposals").get() as { c: number }).c).toBe(rows);
    again.close();
  });
});
