import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrainError, ClaudeCodeBrain, DEFAULT_ROUTING, resolveRouting, type BrainTask } from "./brain.ts";
import { BRAIN_RUN_IN_FLIGHT, costSourceFor, Datastore } from "./datastore.ts";
import { DEFAULT_RESEARCH_BUDGET_CONFIG, researchRunCaps, researchUsage } from "./research-budget.ts";
import { DEFAULT_BUILD_USD_PER_MINUTE } from "./run-cost.ts";
import { FAKE_CLAUDE } from "./testing/fake-claude.ts";
import { tempDir } from "./testing/temp.ts";

// Hardening ticket 10: what a run that ended without a result is recorded at, and how the figures that sum runs count it.

const minutes = (m: number) => m * 60_000;
const T0 = new Date("2026-11-17T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const SINCE = at(-24 * 3_600_000).toISOString();

describe("migration: cost_source on a database made before the column", () => {
  it("backfills every finished run (exact, estimated at a cap, unknown) and loads the old rows", () => {
    const path = join(tempDir("argus-cost-source-"), "argus.db");
    const first = Datastore.open(path);
    const mk = (task: string, exit: string, cost: number, session: string | null = null, backend = "claude-code") => {
      const id = first.startBrainRun({ proposalId: 0, task, backend, model: "m" }, T0);
      first.finishBrainRun(id, { sessionId: session, totalCostUsd: cost, exitStatus: exit });
      return id;
    };
    const ids = {
      reported: mk("judge", "success", 0.02),
      researchTimedOut: mk("propose", "timed-out", 0),
      buildKilled: mk("build", "interrupted", 0),
      clean: mk("judge", "failed", 0), // claude never started
      apiCeiling: mk("judge", "failed", 0.01, null, "api"),
    };
    const open = first.startBrainRun({ proposalId: 0, task: "judge", backend: "claude-code", model: "m" }, T0);
    first.close();
    // The file as the worker before this change left it: no cost_source column.
    const raw = new DatabaseSync(path);
    raw.exec("ALTER TABLE brain_runs DROP COLUMN cost_source");
    raw.close();

    const ds = Datastore.open(path);
    const kind = (id: number) => ds.brainRunsFor(0).find((r) => r.id === id)!.costSource;
    expect(kind(ids.reported)).toBe("exact");
    expect(kind(ids.researchTimedOut)).toBe("estimated"); // charged at its route's cap
    expect(kind(ids.buildKilled)).toBe("unknown"); // nothing charged it: a floor, said so
    expect(kind(ids.clean)).toBe("exact");
    expect(kind(ids.apiCeiling)).toBe("estimated"); // an API run's ceiling charge
    expect(ds.brainRunsFor(0).find((r) => r.id === open)).toMatchObject({ exitStatus: BRAIN_RUN_IN_FLIGHT });
    // A second open changes nothing.
    ds.close();
    Datastore.open(path).close();
  });

  it("costSourceFor: a reported cost is exact, an abnormal end with none is estimated where a cap charges it and unknown where nothing does", () => {
    const run = (task: string, exitStatus: string, totalCostUsd = 0, sessionId: string | null = null) => costSourceFor({ task, backend: "claude-code", exitStatus, sessionId, totalCostUsd });
    expect(run("build", "success", 3)).toBe("exact");
    expect(run("build", "timed-out")).toBe("unknown");
    expect(run("spec", "cancelled")).toBe("estimated");
    expect(run("judge", "failed", 0, "5e55a0a0-0000-4000-8000-000000000001")).toBe("estimated");
    expect(run("judge", "failed")).toBe("exact");
  });
});

describe("the research routes keep their cap charge, shown as estimated", () => {
  const TASKS = ["judge", "propose", "meta-summary", "meta-group", "meme-ideas"] as const;
  // The five routes with a small wall-clock cap, run against the fake claude's hang mode: a real kill, a real BrainError.
  const brain = () =>
    new ClaudeCodeBrain({
      command: FAKE_CLAUDE,
      routing: resolveRouting(Object.fromEntries(TASKS.map((t) => [t, { timeoutMs: 400 }]))),
      env: { PATH: process.env.PATH, FAKE_CLAUDE_MODE: "hang" },
      passEnv: ["FAKE_CLAUDE_MODE"],
      killGraceMs: 200,
    });

  /** What every pass does when brain.run throws: the run closes with what the error carries. */
  async function ended(store: Datastore, b: ClaudeCodeBrain, task: BrainTask, signal?: AbortSignal): Promise<number> {
    const runId = store.startBrainRun({ proposalId: 0, task, ...b.routeFor(task) }, new Date());
    try {
      await b.run(task, { prompt: "x" }, { signal });
    } catch (e) {
      const err = e as BrainError;
      store.finishBrainRun(runId, { sessionId: err.sessionId ?? null, totalCostUsd: err.totalCostUsd, exitStatus: err.kind, backend: err.backend, model: err.model });
      return runId;
    }
    throw new Error("the run should have been killed");
  }

  for (const task of TASKS) {
    for (const how of ["timed-out", "interrupted"] as const) {
      it(`${task}: a ${how} run is charged at its route cap, marked estimated, and counted by its task's figure, the research budget and the daily total`, async () => {
        const store = Datastore.open(":memory:");
        const b = brain();
        let runId: number;
        if (how === "timed-out") runId = await ended(store, b, task);
        else {
          const ac = new AbortController();
          setTimeout(() => ac.abort(), 100);
          runId = await ended(store, b, task, ac.signal);
        }
        const cap = DEFAULT_ROUTING[task].maxBudgetUsd;
        const caps = researchRunCaps(b);
        expect(caps[task]).toBe(cap);
        expect(store.brainRunsFor(0).find((r) => r.id === runId)).toMatchObject({ exitStatus: how, totalCostUsd: 0, costSource: "estimated" });

        const perTask = {
          judge: store.judgeSpendSince(SINCE, caps),
          propose: store.proposeSpendSince(SINCE, caps),
          "meta-summary": store.metaSummarySpendSince(SINCE, caps),
          "meta-group": store.metaGroupSpendSince(SINCE, caps),
          "meme-ideas": store.memeIdeasSpendSince(SINCE, caps),
        }[task];
        expect(perTask).toEqual({ runs: 1, costUsd: 0, chargedUsd: cap });
        const usage = researchUsage(store, new Date(), DEFAULT_RESEARCH_BUDGET_CONFIG, caps);
        expect(usage).toMatchObject({ usedUsd: cap, reportedUsd: 0, estimatedUsd: cap, dailyUsedUsd: cap });
        // The activity list shows the charge, not $0, and says it is an estimate.
        if (task !== "meta-summary" && task !== "meta-group") {
          expect(store.recentBrainRuns(5, caps)[0]).toMatchObject({ estCostUsd: cap, costKind: "est", costSource: "estimated" });
        }
      });
    }
  }
});

describe("every Build dollar counts toward the daily budget", () => {
  it("a Build's cost (exact, or the estimate of a killed one, every attempt) raises the daily figure, and a running Build counts what it has streamed", () => {
    const store = Datastore.open(":memory:");
    const caps = researchRunCaps(new ClaudeCodeBrain());
    const before = researchUsage(store, T0, DEFAULT_RESEARCH_BUDGET_CONFIG, caps);
    expect(before.dailyUsedUsd).toBe(0);

    const finished = store.startBrainRun({ proposalId: 1, task: "build", backend: "claude-code", model: "sonnet" }, at(-minutes(50)));
    store.finishBrainRun(finished, { sessionId: null, totalCostUsd: 4, exitStatus: "success" });
    const killed = store.startBrainRun({ proposalId: 1, task: "build", backend: "claude-code", model: "sonnet" }, at(-minutes(30)));
    store.finishBrainRun(killed, { sessionId: null, totalCostUsd: 2.5, exitStatus: "interrupted", costSource: "estimated" });
    const running = store.startBrainRun({ proposalId: 2, task: "build", backend: "claude-code", model: "sonnet" }, at(-minutes(5)));
    store.recordBrainRunSpend(running, { sessionId: null, totalCostUsd: 1.25, costSource: "estimated" });

    const after = researchUsage(store, T0, DEFAULT_RESEARCH_BUDGET_CONFIG, caps);
    expect(after.dailyUsedUsd).toBeCloseTo(7.75, 10);
    expect(after.dailyUsedShareOfQuota).toBeCloseTo(7.75 / DEFAULT_RESEARCH_BUDGET_CONFIG.dailyQuotaUsd, 10);
    // The research share is unchanged: Builds are not research.
    expect(after).toMatchObject({ usedUsd: 0, runs: 0 });
    // A running Build with nothing recorded is not charged at its $25 cap: the daily figure only takes what is known.
    store.startBrainRun({ proposalId: 3, task: "build", backend: "claude-code", model: "sonnet" }, at(-minutes(1)));
    expect(researchUsage(store, T0, DEFAULT_RESEARCH_BUDGET_CONFIG, caps).dailyUsedUsd).toBeCloseTo(7.75, 10);
  });

  it("the Proposal's card figure carries exact vs estimated vs unknown", () => {
    const store = Datastore.open(":memory:");
    const mk = (cost: number, source: "exact" | "estimated", exit = "success") => {
      const p = store.createProposal({ narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: `Cat ${cost}${source}`, ticker: "CAT", description: "d", evidenceLinks: [] });
      const id = store.startBrainRun({ proposalId: p.id, task: "build", backend: "claude-code", model: "sonnet" }, T0);
      store.finishBrainRun(id, { sessionId: null, totalCostUsd: cost, exitStatus: exit, costSource: source });
      return p.id;
    };
    expect(store.getProposal(mk(1, "exact"))).toMatchObject({ agentCostUsd: 1, agentCostKind: "exact" });
    expect(store.getProposal(mk(2, "estimated", "interrupted"))).toMatchObject({ agentCostUsd: 2, agentCostKind: "estimated" });
    const p = store.createProposal({ narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: "Dog", ticker: "DOG", description: "d", evidenceLinks: [] });
    const id = store.startBrainRun({ proposalId: p.id, task: "build", backend: "claude-code", model: "sonnet" }, T0);
    store.finishBrainRun(id, { sessionId: null, totalCostUsd: 0, exitStatus: "timed-out" }); // nothing recovered, nothing charged
    expect(store.getProposal(p.id)).toMatchObject({ agentCostUsd: 0, agentCostKind: "unknown" });
  });
});

describe("Spec drafts that did not finish still count (decision 5)", () => {
  it("a cancelled draft (Undo shortlist) is charged at its cap against the daily budget when it recorded nothing", () => {
    const store = Datastore.open(":memory:");
    const caps = researchRunCaps(new ClaudeCodeBrain());
    const id = store.startBrainRun({ proposalId: 1, task: "spec", backend: "claude-code", model: "sonnet" }, T0);
    store.finishBrainRun(id, { sessionId: null, totalCostUsd: 0, exitStatus: "cancelled" });
    const revise = store.startBrainRun({ proposalId: 1, task: "spec-revise", backend: "claude-code", model: "sonnet" }, T0);
    store.finishBrainRun(revise, { sessionId: null, totalCostUsd: 0, exitStatus: "cancelled" });
    expect(store.dailySpendSince(SINCE, caps)).toEqual({ runs: 2, costUsd: 0, chargedUsd: 2 * DEFAULT_ROUTING.spec.maxBudgetUsd });
    expect(store.brainRunsFor(1).map((r) => r.costSource)).toEqual(["estimated", "estimated"]);
  });
});

describe("the elapsed-time estimate for a Build that left no usable usage", () => {
  const build = (store: Datastore, startMin: number, endMin: number, cost: number, source: "exact" | "estimated" = "exact") => {
    const id = store.startBrainRun({ proposalId: 1, task: "build", backend: "claude-code", model: "sonnet" }, at(minutes(startMin)));
    store.finishBrainRun(id, { sessionId: null, totalCostUsd: cost, exitStatus: "success", costSource: source });
    // finishBrainRun stamps the real clock: put the run's end where the scenario has it.
    const raw = (store as unknown as { db: DatabaseSync }).db;
    raw.prepare("UPDATE brain_runs SET finished_at = ? WHERE id = ?").run(at(minutes(endMin)).toISOString(), id);
    return id;
  };

  it("the default $/min is the Build route's cap over its wall-clock cap", () => {
    expect(DEFAULT_BUILD_USD_PER_MINUTE).toBeCloseTo(DEFAULT_ROUTING.build.maxBudgetUsd / (DEFAULT_ROUTING.build.timeoutMs / 60_000), 12);
  });

  it("with no Build to average, a killed run is charged its minutes at the default rate, capped at the cap it is given, never $0", () => {
    const store = Datastore.open(":memory:");
    expect(store.recentBuildUsdPerMinute()).toBe(DEFAULT_BUILD_USD_PER_MINUTE);
    const id = store.startBrainRun({ proposalId: 1, task: "build", backend: "claude-code", model: "sonnet" }, T0);
    expect(store.estimateBuildRunUsd(id, at(minutes(30)), 25)).toBeCloseTo(30 * DEFAULT_BUILD_USD_PER_MINUTE, 10);
    expect(store.estimateBuildRunUsd(id, at(minutes(240)), 3)).toBe(3); // capped
    expect(store.estimateBuildRunUsd(id, at(0), 25)).toBeCloseTo(DEFAULT_BUILD_USD_PER_MINUTE, 10); // killed at once: one minute, not $0
    expect(store.estimateBuildRunUsd(id, at(0), 25)).toBeGreaterThan(0);
  });

  it("with a history, the rate is the average of the last 10 Builds whose cost claude reported (their cost over their run time)", () => {
    const store = Datastore.open(":memory:");
    // Ten recent Builds: $3 in 20 min, ten of them (so $30 / 200 min = $0.15/min); an older, dearer one and an estimated one are not counted.
    build(store, -1000, -900, 50); // older than the last 10: not in the average
    for (let i = 0; i < 10; i++) build(store, -800 + i * 30, -780 + i * 30, 3);
    build(store, -400, -300, 99, "estimated"); // an estimate is never averaged back into the next estimate
    expect(store.recentBuildUsdPerMinute()).toBeCloseTo(0.15, 10);
    const killed = store.startBrainRun({ proposalId: 2, task: "build", backend: "claude-code", model: "sonnet" }, at(0));
    expect(store.estimateBuildRunUsd(killed, at(minutes(40)), 25)).toBeCloseTo(6, 10);
  });

  it("a Build left open by a dead worker is swept at its last streamed total, or, with none, at its run time to its last heartbeat; never $0", () => {
    const store = Datastore.open(":memory:");
    const stale = () => 1000;
    const streamed = store.startBrainRun({ proposalId: 1, task: "build", backend: "claude-code", model: "sonnet" }, T0);
    store.recordBrainRunSpend(streamed, { sessionId: null, totalCostUsd: 3.2, costSource: "estimated" });
    const silent = store.startBrainRun({ proposalId: 2, task: "build", backend: "claude-code", model: "sonnet" }, T0);
    store.touchBrainRun(silent, at(minutes(20))); // alive for 20 minutes, then the worker died
    expect(store.interruptStaleBrainRuns(stale, at(minutes(60)))).toBe(2);
    const runs = (p: number) => store.brainRunsFor(p)[0]!;
    expect(runs(1)).toMatchObject({ exitStatus: "interrupted", totalCostUsd: 3.2, costSource: "estimated" });
    expect(runs(2)).toMatchObject({ exitStatus: "interrupted", costSource: "estimated" });
    expect(runs(2).totalCostUsd).toBeCloseTo(20 * DEFAULT_BUILD_USD_PER_MINUTE, 10);
  });

  it("a Build that never beat is charged at least a minute", () => {
    const store = Datastore.open(":memory:");
    store.startBrainRun({ proposalId: 1, task: "build", backend: "claude-code", model: "sonnet" }, T0);
    expect(store.interruptStaleBrainRuns(() => 1000, at(minutes(60)))).toBe(1);
    expect(store.brainRunsFor(1)[0]!.totalCostUsd).toBeCloseTo(DEFAULT_BUILD_USD_PER_MINUTE, 10);
  });
});
