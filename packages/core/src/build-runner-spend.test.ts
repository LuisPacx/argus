import { rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { killLiveBrainChildren } from "./brain.ts";
import { MIN_RETRY_BUDGET_USD, runNextBuild } from "./build-runner.ts";
import { DEFAULT_RESEARCH_BUDGET_CONFIG, researchRunCaps, researchUsage } from "./research-budget.ts";
import { DEFAULT_BUILD_USD_PER_MINUTE } from "./run-cost.ts";
import { makeHarness, type Harness } from "./testing/build-harness.ts";
import { untilExists, untilTrue } from "./testing/wait.ts";

// Hardening ticket 10: what a Build is recorded at when its agent is killed or crashes and prints no result. The fake claude prints
// real-shaped stream-json turns first (FAKE_CLAUDE_TURNS), so the usage is on stdout when the child is killed, as in a real run.

/** One streamed turn on the fake sonnet: `cache_read` tokens priced at $0.10/MTok are the bulk, plus 2 input and a stub 16 output tokens. */
const usd = (dollars: number) => ({ input_tokens: 2, output_tokens: 16, cache_read_input_tokens: Math.round((dollars / 0.1) * 1e6), cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } });
const TURN_EXTRA = (2 * 2 + 16 * 10) / 1e6; // the 2 input and 16 output tokens of a turn, on sonnet
const turns = (...dollars: number[]) => JSON.stringify(dollars.map(usd));
const WAITING = { FAKE_CLAUDE_EFFECT: "wait-release,commit" };
const minutes = (m: number) => m * 60_000;

describe("a Build killed or crashed without a result is recorded at an estimate, never $0", { timeout: 90_000 }, () => {
  let current: Harness | undefined;
  const start = (opts?: Parameters<typeof makeHarness>[0]): Harness => (current = makeHarness(opts));
  afterEach(() => {
    if (current) writeFileSync(current.release, ""); // a failed test must not leave claude waiting
    current = undefined;
    vi.useRealTimers();
  });
  const claudeBudgets = (h: Harness) => h.calls(h.claudeLog).map((c) => Number((c.argv as string[])[(c.argv as string[]).indexOf("--max-budget-usd") + 1]));
  const caps = (h: Harness) => researchRunCaps(h.brain);
  const daily = (h: Harness) => researchUsage(h.store, new Date(), DEFAULT_RESEARCH_BUDGET_CONFIG, caps(h)).dailyUsedUsd;

  it("dismissal poll: the streamed usage is priced; the run row, the Proposal's cost and the daily budget all carry it", async () => {
    const h = start({ claudeEnv: { ...WAITING, FAKE_CLAUDE_TURNS: turns(3, 2) } });
    h.options.dismissPollMs = 20;
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options);
    await untilExists(h.started);
    h.store.transition(p.id, "dismissed", "operator", "changed my mind");
    expect(await running).toEqual({ proposalId: p.id, result: "abandoned" });
    const expected = 5 + 2 * TURN_EXTRA;
    const [run] = h.store.brainRunsFor(p.id);
    expect(run).toMatchObject({ exitStatus: "aborted", costSource: "estimated" });
    expect(run!.totalCostUsd).toBeCloseTo(expected, 6);
    expect(h.store.getProposal(p.id)).toMatchObject({ agentCostKind: "estimated" });
    expect(h.store.getProposal(p.id)!.agentCostUsd).toBeCloseTo(expected, 6);
    expect(daily(h)).toBeCloseTo(expected, 6);
  });

  it("dismissal poll with nothing streamed: charged the run's minutes at the average rate of recent Builds (a seeded history), marked estimated", async () => {
    const h = start({ claudeEnv: WAITING });
    h.options.dismissPollMs = 20;
    // Two earlier Builds that cost $4 and $2 over 20 and 10 minutes: $0.20 a minute.
    const t0 = new Date("2026-11-01T10:00:00.000Z").getTime();
    for (const [cost, mins] of [[4, 20], [2, 10]] as const) {
      const id = h.store.startBrainRun({ proposalId: 999, task: "build", backend: "claude-code", model: "sonnet" }, new Date(t0));
      h.store.finishBrainRun(id, { sessionId: null, totalCostUsd: cost, exitStatus: "success" });
      (h.store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db.prepare("UPDATE brain_runs SET finished_at = ? WHERE id = ?").run(new Date(t0 + minutes(mins)).toISOString(), id);
    }
    const p = h.seedApproved("Cat Coin");
    // The clock reads 30 minutes after the run row was opened, so the estimate is exact.
    h.options.now = () => new Date(Date.parse(h.store.brainRunsFor(p.id)[0]!.createdAt) + minutes(30));
    const running = runNextBuild(h.store, h.brain, h.options);
    await untilExists(h.started);
    h.store.transition(p.id, "dismissed", "operator", "changed my mind");
    await running;
    expect(h.store.brainRunsFor(p.id).at(-1)).toMatchObject({ exitStatus: "aborted", costSource: "estimated" });
    expect(h.store.brainRunsFor(p.id).at(-1)!.totalCostUsd).toBeCloseTo(30 * 0.2, 10);
    expect(h.store.getProposal(p.id)!.agentCostUsd).toBeCloseTo(6, 10);
  });

  it("with no Build to average, the run's minutes are charged at the default rate, capped at the route's cap", async () => {
    const h = start({ claudeEnv: WAITING });
    h.options.dismissPollMs = 20;
    const p = h.seedApproved("Cat Coin");
    h.options.now = () => new Date(Date.parse(h.store.brainRunsFor(p.id)[0]!.createdAt) + minutes(300)); // past the 240 minute cap
    const running = runNextBuild(h.store, h.brain, h.options);
    await untilExists(h.started);
    h.store.transition(p.id, "dismissed", "operator", "changed my mind");
    await running;
    // 300 min x $25/240 min would be $31.25: the route's $25 caps it.
    expect(h.store.brainRunsFor(p.id).at(-1)).toMatchObject({ totalCostUsd: 25, costSource: "estimated" });
    expect(300 * DEFAULT_BUILD_USD_PER_MINUTE).toBeGreaterThan(25);
  });

  it("wall-clock cap: timed-out with streamed usage is recorded at it; with none, at the default rate for the run's minutes; the retry gets only what is left of the cap", async () => {
    const h = start({ claudeEnv: { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_EFFECT: "", FAKE_CLAUDE_TURNS: turns(4) }, routing: { build: { timeoutMs: 60_000 } } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options);
    await untilExists(h.started);
    rmSync(h.started);
    vi.advanceTimersByTime(60_000);
    await untilExists(h.started);
    vi.advanceTimersByTime(60_000);
    await running;
    const runs = h.store.brainRunsFor(p.id);
    expect(runs.map((r) => [r.exitStatus, r.costSource])).toEqual([["timed-out", "estimated"], ["timed-out", "estimated"]]);
    expect(runs[0]!.totalCostUsd).toBeCloseTo(4 + TURN_EXTRA, 6);
    expect(runs[1]!.totalCostUsd).toBeCloseTo(4 + TURN_EXTRA, 6);
    // Attempt 1 may spend the whole $25, attempt 2 what attempt 1 left: both attempts sum against the Build's cap.
    const [first, second] = claudeBudgets(h);
    expect(first).toBe(25);
    expect(second).toBeCloseTo(25 - (4 + TURN_EXTRA), 5);
    expect(h.store.getProposal(p.id)!.agentCostUsd).toBeCloseTo(2 * (4 + TURN_EXTRA), 6);
  });

  it("wall-clock cap with no usage on the stream: charged the run's minutes (at least one) at the default rate, never $0", async () => {
    const h = start({ claudeEnv: { FAKE_CLAUDE_MODE: "hang-init", FAKE_CLAUDE_EFFECT: "" }, routing: { build: { timeoutMs: 60_000 } } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options);
    await untilExists(h.started);
    rmSync(h.started);
    vi.advanceTimersByTime(60_000);
    await untilExists(h.started);
    vi.advanceTimersByTime(60_000);
    await running;
    const runs = h.store.brainRunsFor(p.id);
    expect(runs.map((r) => [r.exitStatus, r.costSource])).toEqual([["timed-out", "estimated"], ["timed-out", "estimated"]]);
    // The real clock ran for seconds, so the one-minute floor applies to each.
    for (const r of runs) expect(r.totalCostUsd).toBeCloseTo(DEFAULT_BUILD_USD_PER_MINUTE, 10);
    expect(h.store.getProposal(p.id)).toMatchObject({ status: "build-failed", agentCostKind: "estimated" });
  });

  it("shutdown (killLiveBrainChildren): recorded interrupted at the streamed estimate, not retried", async () => {
    const h = start({ claudeEnv: { ...WAITING, FAKE_CLAUDE_TURNS: turns(1.5) } });
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options);
    await untilExists(h.started);
    expect(await killLiveBrainChildren(200)).toBe(1);
    expect(await running).toEqual({ proposalId: p.id, result: "build-failed" });
    const runs = h.store.brainRunsFor(p.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ exitStatus: "interrupted", costSource: "estimated" });
    expect(runs[0]!.totalCostUsd).toBeCloseTo(1.5 + TURN_EXTRA, 6);
    expect(h.store.getProposal(p.id)).toMatchObject({ status: "build-failed", agentCostKind: "estimated" });
  });

  it("claude crashes without a result: the stream's estimate is recorded; the two attempts sum against the $25 cap and the Proposal's total has both", async () => {
    const h = start({ claudeEnv: { FAKE_CLAUDE_MODE: "noresult", FAKE_CLAUDE_EFFECT: "", FAKE_CLAUDE_TURNS: turns(5) } });
    const p = h.seedApproved("Cat Coin");
    expect(await runNextBuild(h.store, h.brain, h.options)).toEqual({ proposalId: p.id, result: "build-failed" });
    const runs = h.store.brainRunsFor(p.id);
    expect(runs.map((r) => [r.exitStatus, r.costSource])).toEqual([["failed", "estimated"], ["failed", "estimated"]]);
    const each = 5 + TURN_EXTRA;
    const [first, second] = claudeBudgets(h);
    expect(first).toBe(25);
    expect(second).toBeCloseTo(25 - each, 5); // the second attempt gets only the remainder
    expect(h.store.getProposal(p.id)!.agentCostUsd).toBeCloseTo(2 * each, 6);
    expect(daily(h)).toBeCloseTo(2 * each, 6);
  });

  it("a first attempt that used (almost) the whole cap is not retried: the Build fails with the reason", async () => {
    const used = 25 - MIN_RETRY_BUDGET_USD + 0.5; // leaves less than the smallest retry
    const h = start({ claudeEnv: { FAKE_CLAUDE_MODE: "noresult", FAKE_CLAUDE_EFFECT: "", FAKE_CLAUDE_TURNS: turns(used) } });
    const p = h.seedApproved("Cat Coin");
    expect(await runNextBuild(h.store, h.brain, h.options)).toEqual({ proposalId: p.id, result: "build-failed" });
    expect(h.calls(h.claudeLog)).toHaveLength(1);
    expect(h.store.brainRunsFor(p.id)).toHaveLength(1);
    expect(h.store.historyFor(p.id).at(-1)!.reason).toContain("Not retried");
    expect(h.store.getProposal(p.id)!.agentCostUsd).toBeCloseTo(used + TURN_EXTRA, 6);
  });

  it("claude crashes with nothing on the stream: the explicit fallback charge (the run's minutes at the default rate), not $0", async () => {
    const h = start({ claudeEnv: { FAKE_CLAUDE_MODE: "noresult", FAKE_CLAUDE_EFFECT: "" } });
    const p = h.seedApproved("Cat Coin");
    await runNextBuild(h.store, h.brain, h.options);
    const runs = h.store.brainRunsFor(p.id);
    expect(runs.map((r) => r.costSource)).toEqual(["estimated", "estimated"]);
    for (const r of runs) expect(r.totalCostUsd).toBeCloseTo(DEFAULT_BUILD_USD_PER_MINUTE, 10);
  });

  it("while the agent runs, the streamed total is on the run row (so a worker that dies leaves it), and the exact cost replaces it when claude finishes", async () => {
    const h = start({ claudeEnv: { ...WAITING, FAKE_CLAUDE_TURNS: turns(2) } });
    h.options.heartbeatMs = 10;
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options);
    await untilExists(h.started);
    await untilTrue(() => (h.store.brainRunsFor(p.id)[0]?.totalCostUsd ?? 0) > 0, "the streamed total on the run row");
    expect(h.store.brainRunsFor(p.id)[0]).toMatchObject({ exitStatus: "in-flight", costSource: "estimated" });
    expect(h.store.brainRunsFor(p.id)[0]!.totalCostUsd).toBeCloseTo(2 + TURN_EXTRA, 6);
    writeFileSync(h.release, "");
    await running;
    // claude finished: its own result (the fake's $0.0123) is the cost, exact.
    expect(h.store.brainRunsFor(p.id)[0]).toMatchObject({ exitStatus: "success", totalCostUsd: 0.0123, costSource: "exact" });
  });
});
