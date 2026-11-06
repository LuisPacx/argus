import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBrain, resolveRouting } from "./brain.ts";
import { Datastore, type NarrativeEmbedder } from "./datastore.ts";
import { DEFAULT_JUDGE_CONFIG, judgePendingNarratives, type JudgeConfig } from "./judge.ts";
import type { ResearchBudgetConfig } from "./research-budget.ts";
import { FAKE_CLAUDE } from "./testing/fake-claude.ts";
import { tempDir } from "./testing/temp.ts";

const NOW = new Date("2026-06-14T12:00:00.000Z");
const CUR: NarrativeEmbedder = { id: "sem-test", dimension: 2 };
const OLD: NarrativeEmbedder = { id: "hashing-v1", dimension: 2 };
const ANSWER = JSON.stringify({ scores: { momentum: 7, novelty: 6, buildability: 8, hook: 5, legitimacy: 9 }, rationale: "clear and buildable" });

function setup(env: Record<string, string> = {}, brainOpts: ConstructorParameters<typeof ClaudeCodeBrain>[0] = {}) {
  const store = Datastore.open(":memory:");
  const dir = tempDir("argus-judge-");
  const log = join(dir, "calls.jsonl");
  const passEnv = ["FAKE_CLAUDE_MODE", "FAKE_CLAUDE_RESULT", "FAKE_CLAUDE_LOG", "FAKE_CLAUDE_SEQUENCE"];
  const brain = new ClaudeCodeBrain({
    killGraceMs: 200,
    command: FAKE_CLAUDE,
    env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "sk-must-not-leak", FAKE_CLAUDE_MODE: "success", FAKE_CLAUDE_RESULT: ANSWER, FAKE_CLAUDE_LOG: log, ...env },
    passEnv,
    ...brainOpts,
  });
  const lines: string[] = [];
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> }) : []);
  const pass = (config: Partial<JudgeConfig> = {}, over: { embedder?: NarrativeEmbedder; now?: Date; signal?: AbortSignal; research?: ResearchBudgetConfig } = {}) =>
    judgePendingNarratives(store, brain, over.embedder ?? CUR, { now: over.now ?? NOW, config, log: (l) => lines.push(l), signal: over.signal, research: over.research });
  return { store, brain, pass, calls, lines, dir };
}

let n = 0;
/** A one-Signal Narrative built by `embedder`, last changed at `at`. Returns its id. */
function addNarrative(store: Datastore, title: string, opts: { embedder?: NarrativeEmbedder; at?: Date; sourceId?: string } = {}): number {
  const id = `s:${++n}`;
  store.recordSignals([{ id, sourceId: opts.sourceId ?? "rss:a", sourceLabel: "Feed", title, summary: `${title} summary`, url: `https://a.example/${id}`, publishedAt: "2026-06-14T09:00:00.000Z" }]);
  const sig = store.unclusteredSignals(500).find((s) => s.id === id)!;
  return store.createNarrative(sig, [1, 0], (opts.at ?? NOW).toISOString(), opts.embedder ?? CUR);
}

/** Another Signal joins the Narrative; from a new Source it is a material change. */
function addSignal(store: Datastore, narrativeId: number, sourceId: string, at: Date): void {
  const id = `s:${++n}`;
  store.recordSignals([{ id, sourceId, sourceLabel: sourceId, title: `More ${id}`, summary: "", url: `https://a.example/${id}`, publishedAt: at.toISOString() }]);
  const sig = store.unclusteredSignals(500).find((s) => s.id === id)!;
  store.joinNarrative(narrativeId, sig, [1, 0], at.toISOString());
}

const minutes = (m: number) => new Date(NOW.getTime() + m * 60_000);

describe("the judge pass", () => {
  it("scores a new Narrative against the current Rubric and stores the Score with the Rubric version", async () => {
    const { store, pass } = setup();
    const id = addNarrative(store, "Tokenized stocks arrive");
    const out = await pass();
    expect(out).toMatchObject({ judged: 1, refused: 0, failed: 0 });
    const scores = store.getNarrative(id)!.scores;
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({
      narrativeId: id,
      rubricVersion: 1,
      scores: { momentum: 7, novelty: 6, buildability: 8, hook: 5, legitimacy: 9 },
      total: 7,
      rationale: "clear and buildable",
      signalCount: 1,
      changedMateriallyAt: NOW.toISOString(),
    });
  });

  it("records the run first and its usage after: an in-flight row opened before the spawn, closed with the cost", async () => {
    const { store, pass } = setup();
    const id = addNarrative(store, "A story");
    await pass();
    const run = store.judgeRunsFor(id);
    expect(run).toMatchObject([{ proposalId: 0, narrativeId: id, task: "judge", backend: "claude-code", model: "haiku", exitStatus: "success", totalCostUsd: 0.0123 }]);
    expect(run[0]!.sessionId).toBe("5e55a0a0-0000-4000-8000-000000000001");
  });

  it("runs with no tools, isolation flags, a lowered budget and the haiku model, on the subscription (no API key in the child)", async () => {
    const { store, pass, calls } = setup({}, { skillsDir: join(import.meta.dirname, "../../../.claude/skills") });
    addNarrative(store, "A story");
    await pass();
    const [{ argv, env }] = calls() as [{ argv: string[]; env: Record<string, string> }];
    expect(argv[1]).toMatch(/^\/judge\n\nScore the Narrative below against Rubric version 1\./);
    expect(argv[argv.indexOf("--model") + 1]).toBe("haiku");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv).not.toContain("--allowedTools");
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("0.1");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("project");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
  });

  it("does not write proposals.updated_at (Proposal expiry counts from it)", async () => {
    const { store, pass } = setup();
    const p = store.createProposal({ narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: "Cat", ticker: "CAT", description: "d", evidenceLinks: [] });
    const before = store.getProposal(p.id)!;
    addNarrative(store, "A story");
    await pass();
    const after = store.getProposal(p.id)!;
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.expiresAt).toBe(before.expiresAt);
    expect(after.agentCostUsd).toBe(before.agentCostUsd);
  });

  it("judges only the current embedder's Narratives", async () => {
    const { store, pass, calls } = setup();
    const lexical = addNarrative(store, "Old lexical narrative", { embedder: OLD });
    const current = addNarrative(store, "Current narrative");
    const out = await pass();
    expect(out.judged).toBe(1);
    expect(calls()).toHaveLength(1);
    expect(store.getNarrative(lexical)!.scores).toEqual([]);
    expect(store.getNarrative(current)!.scores).toHaveLength(1);
  });

  it("skips a Narrative of the same embedder name but another vector length", async () => {
    const { store, pass } = setup();
    addNarrative(store, "Wrong dimension", { embedder: { id: CUR.id, dimension: 384 } });
    expect((await pass()).judged).toBe(0);
  });

  it("does not judge a Narrative whose last Signal is outside the window", async () => {
    const { store, pass } = setup();
    addNarrative(store, "Stale story", { at: new Date(NOW.getTime() - 73 * 3_600_000) });
    expect((await pass()).judged).toBe(0);
  });
});

describe("delta only", () => {
  it("does not re-judge an unchanged Narrative", async () => {
    const { store, pass, calls } = setup();
    const id = addNarrative(store, "A story");
    await pass();
    await pass({}, { now: minutes(30) });
    await pass({}, { now: minutes(60) });
    expect(calls()).toHaveLength(1);
    expect(store.getNarrative(id)!.scores).toHaveLength(1);
  });

  it("does not re-judge when a Signal joins without changing it materially", async () => {
    const { store, pass, calls } = setup();
    const id = addNarrative(store, "A story");
    addSignal(store, id, "rss:b", minutes(1)); // new Source: material, before the first judge
    await pass({}, { now: minutes(5) });
    addSignal(store, id, "rss:b", minutes(10)); // same Source again: 3 Signals of 2 counted at the last change, not doubled
    const detail = store.getNarrative(id)!;
    expect(detail.signalCount).toBe(3);
    expect(detail.changedMateriallyAt).toBe(minutes(1).toISOString());
    await pass({}, { now: minutes(35) });
    expect(calls()).toHaveLength(1);
  });

  it("re-judges when new Signals change a Narrative materially, and keeps both Scores as history, newest first", async () => {
    const { store, pass, calls } = setup();
    const id = addNarrative(store, "A story");
    await pass({}, { now: minutes(1) });
    addSignal(store, id, "rss:other", minutes(10)); // a Source the Narrative had not heard from
    const out = await pass({}, { now: minutes(30) });
    expect(out.judged).toBe(1);
    expect(calls()).toHaveLength(2);
    const history = store.getNarrative(id)!.scores;
    expect(history).toHaveLength(2);
    expect(history.map((s) => s.signalCount)).toEqual([2, 1]);
    expect(history[0]!.changedMateriallyAt).toBe(minutes(10).toISOString());
    // And it settles again.
    await pass({}, { now: minutes(60) });
    expect(calls()).toHaveLength(2);
  });

  it("a change that lands while the judge is running is judged on the next pass", async () => {
    const { store, brain, pass, calls } = setup();
    const id = addNarrative(store, "A story");
    const run = brain.run.bind(brain);
    // The Signal arrives after the pass read the Narrative and before its answer is stored.
    brain.run = (async (...args: Parameters<typeof run>) => {
      const out = await run(...args);
      addSignal(store, id, "rss:late", minutes(2));
      return out;
    }) as typeof brain.run;
    await pass({}, { now: minutes(1) });
    expect(store.getNarrative(id)!.scores[0]!.signalCount).toBe(1);
    brain.run = run;
    await pass({}, { now: minutes(31) });
    expect(calls()).toHaveLength(2);
    expect(store.getNarrative(id)!.scores).toHaveLength(2);
  });

  it("scores later Narratives with the Rubric as edited since: each Score names the version it used", async () => {
    const { store, pass } = setup();
    const a = addNarrative(store, "First");
    await pass();
    const r = store.getRubric();
    store.saveRubric({ baseVersion: r.version, gateMinScore: 6, dimensions: r.dimensions });
    const b = addNarrative(store, "Second");
    await pass({}, { now: minutes(30) });
    expect(store.getNarrative(a)!.scores.map((s) => s.rubricVersion)).toEqual([1]);
    expect(store.getNarrative(b)!.scores.map((s) => s.rubricVersion)).toEqual([2]);
  });

  it("judges the busiest Narratives first", async () => {
    const { store, pass, calls } = setup();
    addNarrative(store, "Quiet story");
    const busy = addNarrative(store, "Busy story");
    addSignal(store, busy, "rss:b", minutes(-5));
    addSignal(store, busy, "rss:c", minutes(-4));
    await pass({ maxPerPass: 1 });
    expect(calls()[0]!.argv[1]).toContain("Busy story");
  });
});

describe("refused and failed answers", () => {
  it("refuses a malformed answer: no Score, the run is recorded as invalid-output, the refusal is logged with the problem", async () => {
    const { store, pass, lines } = setup({ FAKE_CLAUDE_RESULT: "Sure! Here are the scores: 7, 6, 8, 5, 9" });
    const id = addNarrative(store, "A story");
    const out = await pass();
    expect(out).toMatchObject({ judged: 0, refused: 1 });
    expect(store.getNarrative(id)!.scores).toEqual([]);
    expect(store.judgeRunsFor(id)).toMatchObject([{ exitStatus: "invalid-output", totalCostUsd: 0.0123 }]);
    expect(lines.join("\n")).toMatch(/narrative \d+ refused: output is not a single JSON object.*Sure! Here are/);
  });

  it("never coerces: a string score or a missing dimension stores nothing", async () => {
    for (const answer of [
      JSON.stringify({ scores: { momentum: "7", novelty: 6, buildability: 8, hook: 5, legitimacy: 9 }, rationale: "r" }),
      JSON.stringify({ scores: { momentum: 7, novelty: 6, buildability: 8, hook: 5 }, rationale: "r" }),
    ]) {
      const { store, pass } = setup({ FAKE_CLAUDE_RESULT: answer });
      const id = addNarrative(store, "A story");
      expect((await pass()).refused).toBe(1);
      expect(store.getNarrative(id)!.scores).toEqual([]);
    }
  });

  it("clamps an out-of-scale number to the Rubric scale and stores that", async () => {
    const { store, pass } = setup({ FAKE_CLAUDE_RESULT: JSON.stringify({ scores: { momentum: 99, novelty: -4, buildability: 8, hook: 5, legitimacy: 9 }, rationale: "r" }) });
    const id = addNarrative(store, "A story");
    await pass();
    expect(store.getNarrative(id)!.scores[0]!.scores).toMatchObject({ momentum: 10, novelty: 0 });
  });

  it("does not retry a refused answer until the Narrative changes materially again", async () => {
    const { store, pass, calls } = setup({ FAKE_CLAUDE_RESULT: "nope" });
    const id = addNarrative(store, "A story");
    await pass();
    await pass({}, { now: minutes(30) });
    expect(calls()).toHaveLength(1);
    addSignal(store, id, "rss:other", minutes(40));
    await pass({}, { now: minutes(60) });
    expect(calls()).toHaveLength(2);
  });

  it("a run that hit its budget cap is recorded with its cost and parked until the Narrative changes", async () => {
    const { store, pass, calls } = setup({ FAKE_CLAUDE_MODE: "budget" });
    const id = addNarrative(store, "A story");
    expect(await pass()).toMatchObject({ judged: 0, failed: 1 });
    await pass({}, { now: minutes(30) });
    expect(calls()).toHaveLength(1);
    expect(store.judgeRunsFor(id)).toMatchObject([{ exitStatus: "budget-exceeded" }]);
    expect(store.judgeRunsFor(id)[0]!.totalCostUsd).toBeGreaterThan(0);
    expect(store.getNarrative(id)!.scores).toEqual([]);
  });

  it("a transient failure (claude error, no result, auth or network trouble) leaves the Narrative eligible on the next pass, with its cost recorded", async () => {
    for (const mode of ["failure", "noresult"]) {
      const { store, pass, calls } = setup({ FAKE_CLAUDE_MODE: mode });
      const id = addNarrative(store, "A story");
      expect(await pass()).toMatchObject({ judged: 0, failed: 1 });
      expect(store.judgeRunsFor(id)).toMatchObject([{ exitStatus: "failed" }]);
      await pass({}, { now: minutes(30) });
      expect(calls(), mode).toHaveLength(2);
      expect(store.judgeRunsFor(id)).toHaveLength(2);
    }
  });

  it("a claude that cannot be started at all (missing binary) is transient too", async () => {
    const { store, pass } = setup({}, { command: join(tempDir("argus-nobin-"), "no-such-claude") });
    const id = addNarrative(store, "A story");
    expect(await pass()).toMatchObject({ judged: 0, failed: 1 });
    expect(store.judgeRunsFor(id)).toMatchObject([{ exitStatus: "failed" }]);
    expect(store.narrativesToJudge(CUR, new Date(NOW.getTime() - 72 * 3_600_000).toISOString(), 10).map((n) => n.id)).toEqual([id]);
  });

  it("a Narrative recovers on the pass after the outage ends", async () => {
    const { store, pass } = setup({ FAKE_CLAUDE_SEQUENCE: JSON.stringify([{ FAKE_CLAUDE_MODE: "failure" }, {}]) });
    const id = addNarrative(store, "A story");
    expect(await pass()).toMatchObject({ judged: 0, failed: 1 });
    expect(await pass({}, { now: minutes(30) })).toMatchObject({ judged: 1, failed: 0 });
    expect(store.getNarrative(id)!.scores).toHaveLength(1);
  });

  it("consecutive transient failures end the pass early, logged once, and the next pass tries again", async () => {
    const { store, pass, calls, lines } = setup({ FAKE_CLAUDE_MODE: "failure" });
    for (let i = 0; i < 6; i++) addNarrative(store, `Story ${i}`);
    expect(await pass()).toMatchObject({ judged: 0, failed: 3, stoppedBy: "backoff" });
    expect(calls()).toHaveLength(3);
    expect(lines.filter((l) => l.includes("consecutive failures"))).toHaveLength(1);
    expect(await pass({}, { now: minutes(30) })).toMatchObject({ failed: 3, stoppedBy: "backoff" });
    expect(calls()).toHaveLength(6);
  });

  it("a success resets the consecutive-failure count", async () => {
    const seq = [{ FAKE_CLAUDE_MODE: "failure" }, { FAKE_CLAUDE_MODE: "failure" }, {}, { FAKE_CLAUDE_MODE: "failure" }, { FAKE_CLAUDE_MODE: "failure" }, {}];
    const { store, pass, calls } = setup({ FAKE_CLAUDE_SEQUENCE: JSON.stringify(seq) });
    for (let i = 0; i < 6; i++) addNarrative(store, `Story ${i}`);
    const out = await pass();
    expect(out).toMatchObject({ judged: 2, failed: 4 });
    expect(out.stoppedBy).toBeUndefined();
    expect(calls()).toHaveLength(6);
  });

  it("a refused answer is not a transient failure: it does not count toward the backoff", async () => {
    const { store, pass, calls } = setup({ FAKE_CLAUDE_RESULT: "garbage" });
    for (let i = 0; i < 5; i++) addNarrative(store, `Story ${i}`);
    const out = await pass();
    expect(out).toMatchObject({ refused: 5, failed: 0 });
    expect(out.stoppedBy).toBeUndefined();
    expect(calls()).toHaveLength(5);
  });

  it("repeated transient failures stay bounded by the 24 h run and spend caps across passes", async () => {
    const { store, pass, calls } = setup({ FAKE_CLAUDE_MODE: "failure" }); // each failing fake run costs $0.004
    for (let i = 0; i < 6; i++) addNarrative(store, `Story ${i}`);
    for (let p = 0; p < 6; p++) await pass({ maxRunsPerDay: 7 }, { now: minutes(30 * p) });
    expect(calls()).toHaveLength(7);
    expect(await pass({ maxRunsPerDay: 7 }, { now: minutes(200) })).toMatchObject({ judged: 0, stoppedBy: "daily-cap" });
    const { store: s2, pass: pass2, calls: calls2 } = setup({ FAKE_CLAUDE_MODE: "failure" });
    for (let i = 0; i < 6; i++) addNarrative(s2, `Story ${i}`);
    for (let p = 0; p < 6; p++) await pass2({ maxDailyUsd: 0.019 }, { now: minutes(30 * p) });
    expect(calls2()).toHaveLength(5); // four runs spend 0.016, the fifth brings it to 0.02, over the cap
  });

  it("a rate-limited run stops the pass at once and is tried again on the next one", async () => {
    const { store, pass, calls } = setup({ FAKE_CLAUDE_MODE: "ratelimit" });
    addNarrative(store, "One");
    addNarrative(store, "Two");
    expect(await pass()).toMatchObject({ judged: 0, stoppedBy: "rate-limited" });
    expect(calls()).toHaveLength(1);
    await pass({}, { now: minutes(30) });
    expect(calls()).toHaveLength(2);
  });

  it("an aborted pass spawns nothing", async () => {
    const { store, pass, calls } = setup();
    addNarrative(store, "A story");
    const ac = new AbortController();
    ac.abort();
    expect(await pass({}, { signal: ac.signal })).toMatchObject({ judged: 0, stoppedBy: "interrupted" });
    expect(calls()).toHaveLength(0);
    expect(store.judgeRunsFor(1)).toEqual([]);
  });

  it("skips a Narrative that already has a judge run in flight", async () => {
    const { store, pass, calls } = setup();
    const id = addNarrative(store, "A story");
    store.startBrainRun({ proposalId: 0, narrativeId: id, task: "judge", backend: "claude-code", model: "haiku" });
    await pass();
    expect(calls()).toHaveLength(0);
  });
});

describe("spend caps", () => {
  it("has defaults: 10 per pass, 150 runs and $2 per rolling day", () => {
    expect(DEFAULT_JUDGE_CONFIG).toMatchObject({ maxPerPass: 10, maxRunsPerDay: 150, maxDailyUsd: 2 });
  });

  it("judges at most maxPerPass Narratives in one pass and the rest on the next", async () => {
    const { store, pass, calls } = setup();
    for (let i = 0; i < 5; i++) addNarrative(store, `Story ${i}`);
    expect((await pass({ maxPerPass: 2 })).judged).toBe(2);
    expect((await pass({ maxPerPass: 2 }, { now: minutes(30) })).judged).toBe(2);
    expect((await pass({ maxPerPass: 2 }, { now: minutes(60) })).judged).toBe(1);
    expect(calls()).toHaveLength(5);
  });

  it("stops at the daily spend cap, counting the last 24 hours of judge runs", async () => {
    const { store, pass, calls } = setup(); // each fake run costs $0.0123
    for (let i = 0; i < 6; i++) addNarrative(store, `Story ${i}`);
    const out = await pass({ maxDailyUsd: 0.03, maxPerPass: 10 });
    expect(out).toMatchObject({ judged: 3, stoppedBy: "daily-cap" }); // 0.0123, 0.0246, 0.0369 >= 0.03: the third crosses it
    expect(calls()).toHaveLength(3);
    // Still capped later the same day; no spawn.
    expect(await pass({ maxDailyUsd: 0.03 }, { now: minutes(30) })).toMatchObject({ judged: 0, stoppedBy: "daily-cap" });
    expect(calls()).toHaveLength(3);
    // A day later the spend has aged out.
    const later = new Date(NOW.getTime() + 25 * 3_600_000);
    addNarrative(store, "Fresh story", { at: later });
    expect((await pass({ maxDailyUsd: 0.03, maxPerPass: 1 }, { now: later })).judged).toBe(1);
  });

  it("stops at the daily run count even when the runs were cheap", async () => {
    const { store, pass, calls } = setup();
    for (let i = 0; i < 4; i++) addNarrative(store, `Story ${i}`);
    expect(await pass({ maxRunsPerDay: 2 })).toMatchObject({ judged: 2, stoppedBy: "daily-cap" });
    expect(calls()).toHaveLength(2);
  });

  it("a refused or failed run counts against the cap too", async () => {
    const { store, pass } = setup({ FAKE_CLAUDE_RESULT: "garbage" });
    for (let i = 0; i < 4; i++) addNarrative(store, `Story ${i}`);
    expect(await pass({ maxDailyUsd: 0.02 })).toMatchObject({ refused: 2, stoppedBy: "daily-cap" });
  });
});

describe("the shared research budget (judge plus propose)", () => {
  const budget = (usd: number): ResearchBudgetConfig => ({ dailyQuotaUsd: usd * 2, share: 0.5 });

  it("stops when judge and propose together have used the budget, counting propose spend the judge never made", async () => {
    const { store, pass, calls, lines } = setup();
    for (let i = 0; i < 4; i++) addNarrative(store, `Story ${i}`);
    const run = store.startBrainRun({ proposalId: 0, narrativeId: 1, task: "propose", backend: "claude-code", model: "sonnet" }, minutes(-60));
    store.finishBrainRun(run, { sessionId: null, totalCostUsd: 0.04, exitStatus: "success" });
    // budget $0.05: 0.04 already used by propose; one judge run (0.0123) brings it to 0.0523, over the budget
    expect(await pass({}, { research: budget(0.05) })).toMatchObject({ judged: 1, stoppedBy: "research-cap" });
    expect(calls()).toHaveLength(1);
    expect(lines.join("\n")).toMatch(/research budget reached/);
    // Still waiting later the same day; no spawn.
    expect(await pass({}, { now: minutes(30), research: budget(0.05) })).toMatchObject({ judged: 0, stoppedBy: "research-cap" });
    expect(calls()).toHaveLength(1);
  });

  it("waits for the next day: the spend ages out of the rolling 24 hours and judging resumes", async () => {
    const { store, pass } = setup();
    addNarrative(store, "Story");
    const run = store.startBrainRun({ proposalId: 0, narrativeId: 1, task: "propose", backend: "claude-code", model: "sonnet" }, NOW);
    store.finishBrainRun(run, { sessionId: null, totalCostUsd: 1, exitStatus: "success" });
    expect(await pass({}, { research: budget(1) })).toMatchObject({ judged: 0, stoppedBy: "research-cap" });
    const later = new Date(NOW.getTime() + 24 * 3_600_000 + 60_000);
    addNarrative(store, "Fresh story", { at: later });
    expect(await pass({}, { now: later, research: budget(1) })).toMatchObject({ judged: 2 }); // the waiting Narrative and the fresh one
  });

  it("a timed-out run prints no cost but is charged at the judge route's cap, which then stops the pass", async () => {
    const { store, pass, calls } = setup({ FAKE_CLAUDE_MODE: "hang" }, { routing: resolveRouting({ judge: { timeoutMs: 300, maxBudgetUsd: 0.2 } }) });
    for (let i = 0; i < 4; i++) addNarrative(store, `Story ${i}`);
    expect(await pass({}, { research: budget(0.2) })).toMatchObject({ judged: 0, failed: 1, stoppedBy: "research-cap" });
    expect(calls()).toHaveLength(1);
    expect(store.judgeRunsFor(1)).toMatchObject([{ exitStatus: "timed-out", totalCostUsd: 0 }]); // the reported cost stays 0
    expect(await pass({}, { now: minutes(30), research: budget(0.2) })).toMatchObject({ stoppedBy: "research-cap" });
    expect(calls()).toHaveLength(1);
  });

  describe("a poison Narrative (its judge run always times out)", () => {
    const timeouts = (store: Datastore, narrativeId: number, count: number, at: Date) => {
      for (let i = 0; i < count; i++) {
        const runId = store.startBrainRun({ proposalId: 0, narrativeId, task: "judge", backend: "claude-code", model: "haiku" }, at);
        store.finishBrainRun(runId, { sessionId: null, totalCostUsd: 0, exitStatus: "timed-out" });
      }
    };

    it("is skipped after 3 consecutive timeouts, so the pass moves on to the next Narrative", async () => {
      const { store, pass, calls } = setup();
      const poison = addNarrative(store, "Poison");
      addSignal(store, poison, "rss:a", NOW); // busiest, so it would be first
      const other = addNarrative(store, "Other");
      timeouts(store, poison, 3, NOW);
      expect(await pass()).toMatchObject({ judged: 1, failed: 0 });
      expect(calls()).toHaveLength(1);
      expect(store.getNarrative(poison)!.scores).toHaveLength(0);
      expect(store.getNarrative(other)!.scores).toHaveLength(1);
    });

    it("is still tried while it has fewer than N timeouts in a row, and N is configurable", async () => {
      const { store, pass } = setup();
      const id = addNarrative(store, "Slow");
      timeouts(store, id, 2, NOW);
      expect(await pass()).toMatchObject({ judged: 1 });
      const { store: s2, pass: pass2 } = setup();
      const id2 = addNarrative(s2, "Slow");
      timeouts(s2, id2, 2, NOW);
      expect(await pass2({ maxConsecutiveTimeouts: 2 })).toMatchObject({ judged: 0 });
    });

    it("a run that did not time out in between breaks the streak", async () => {
      const { store, pass } = setup();
      const id = addNarrative(store, "Flaky");
      timeouts(store, id, 2, NOW);
      const mid = store.startBrainRun({ proposalId: 0, narrativeId: id, task: "judge", backend: "claude-code", model: "haiku" }, NOW);
      store.finishBrainRun(mid, { sessionId: null, totalCostUsd: 0, exitStatus: "failed" });
      timeouts(store, id, 2, NOW);
      expect(await pass()).toMatchObject({ judged: 1 });
    });

    it("is tried again once it changes materially, counting from the stored runs (a restart forgets nothing)", async () => {
      const { store, pass } = setup();
      const id = addNarrative(store, "Poison");
      timeouts(store, id, 3, NOW);
      expect(await pass({}, { now: minutes(10) })).toMatchObject({ judged: 0 });
      addSignal(store, id, "rss:other", minutes(20)); // a new Source: material
      expect(await pass({}, { now: minutes(30) })).toMatchObject({ judged: 1 });
    });
  });

  it("applies the default budget ($6) when none is passed", async () => {
    const { store, pass } = setup();
    addNarrative(store, "Story");
    const run = store.startBrainRun({ proposalId: 0, narrativeId: 1, task: "propose", backend: "claude-code", model: "sonnet" }, minutes(-5));
    store.finishBrainRun(run, { sessionId: null, totalCostUsd: 6, exitStatus: "success" });
    expect(await pass()).toMatchObject({ judged: 0, stoppedBy: "research-cap" });
  });
});

describe("dry run", () => {
  it("logs the command, spawns nothing, and leaves no run row or Score", async () => {
    const { store, pass, calls, lines } = setup({}, { dryRun: true, log: () => {} });
    const id = addNarrative(store, "A story");
    addNarrative(store, "Another story");
    expect(await pass()).toMatchObject({ judged: 0, stoppedBy: "dry-run" });
    expect(calls()).toHaveLength(0);
    expect(store.judgeRunsFor(id)).toEqual([]);
    expect(store.getNarrative(id)!.scores).toEqual([]);
    expect(lines.join("\n")).toContain("dry-run");
  });
});
