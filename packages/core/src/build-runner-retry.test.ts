import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHomeFor, runNextBuild } from "./build-runner.ts";
import { makeHarness, vcs, type Harness } from "./testing/build-harness.ts";
import { untilExists } from "./testing/wait.ts";

const SESSION = "5e55a0a0-0000-4000-8000-000000000001";

/** The fake claude's environment per call: entry N applies to the Nth claude run of the test. */
const sequence = (...calls: Array<Record<string, string>>) => ({ FAKE_CLAUDE_SEQUENCE: JSON.stringify(calls) });

async function build(h: Harness, name = "Cat Coin") {
  const p = h.seedApproved(name);
  const outcome = await runNextBuild(h.store, h.brain, h.options);
  return { p, outcome, after: h.store.getProposal(p.id)!, runs: h.store.brainRunsFor(p.id), history: h.store.historyFor(p.id), claude: h.calls(h.claudeLog) };
}

// Each test runs whole Builds (two of them, with a retry): git, a container's worth of fake processes, a bundle and a deploy.
describe("Build Runner: one automatic retry", { timeout: 90_000 }, () => {
  it("retries a failed claude run once, with the error and the last log lines in the prompt, and the retry's success makes it built", async () => {
    const h = makeHarness({ claudeEnv: sequence({ FAKE_CLAUDE_MODE: "failure", FAKE_CLAUDE_EFFECT: "" }, {}) });
    const r = await build(h);

    expect(r.outcome).toEqual({ proposalId: r.p.id, result: "built" });
    expect(r.claude).toHaveLength(2);
    // The same command; the first attempt's prompt is the plain one.
    expect(r.claude[0]!.argv[1]).toBe(`/implement-spec ${r.p.id}`);
    const retryPrompt = r.claude[1]!.argv[1] as string;
    expect(retryPrompt.startsWith(`/implement-spec ${r.p.id}\n`)).toBe(true);
    expect(retryPrompt).toContain("claude failed: Something broke"); // the error
    expect(retryPrompt).toContain('"text":"working"'); // a line from the end of the first attempt's log
    // The Proposal stayed `building` between the attempts; two runs, both with their spend.
    expect(r.history.map((e) => e.to)).toEqual(["new", "shortlisted", "spec-drafted", "approved", "building", "built"]);
    expect(r.runs).toMatchObject([
      { task: "build", exitStatus: "failed", totalCostUsd: 0.004 },
      { task: "build", exitStatus: "success", totalCostUsd: 0.0123 },
    ]);
    expect(r.after.agentCostUsd).toBeCloseTo(0.0163);
    expect(r.after.brainRunInFlightSince).toBeNull();
    expect(readFileSync(join(h.dataDir, "proposals", String(r.p.id), "build.log"), "utf8")).toContain("# argus: Retrying");
  });

  it("is exactly one retry: a second failure is build-failed with the session stored", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_MODE: "failure", FAKE_CLAUDE_EFFECT: "" } });
    const r = await build(h);

    expect(r.outcome).toEqual({ proposalId: r.p.id, result: "build-failed" });
    expect(r.claude).toHaveLength(2);
    expect(r.after).toMatchObject({ status: "build-failed", buildSessionId: SESSION, brainRunInFlightSince: null });
    expect(r.history.at(-1)).toMatchObject({ from: "building", to: "build-failed", actor: "build" });
    expect(r.history.at(-1)!.reason).toContain("claude failed");
    expect(r.runs).toMatchObject([{ exitStatus: "failed" }, { exitStatus: "failed" }]);
    expect(r.after.agentCostUsd).toBeCloseTo(0.008);
    expect(h.deployCalls()).toEqual([]);
    // Kept for a resume.
    expect(existsSync(buildHomeFor(h.dataDir, r.p.id))).toBe(true);
  });

  it("an ARGUS_BUILD_FAILED last line enters the retry, and its summary is in the retry prompt", async () => {
    const h = makeHarness({
      // The first attempt committed; the retry has nothing new to commit.
      claudeEnv: sequence({ FAKE_CLAUDE_RESULT: 'I gave up.\nARGUS_BUILD_FAILED::{"summary":"pnpm check still failing in the cart"}' }, { FAKE_CLAUDE_EFFECT: "" }),
    });
    const r = await build(h);

    expect(r.after.status).toBe("built");
    expect(r.claude).toHaveLength(2);
    expect(r.claude[1]!.argv[1]).toContain("the Build reported failure: pnpm check still failing in the cart");
  });

  it("a budget-exceeded result is a failure and is retried", async () => {
    const h = makeHarness({ claudeEnv: sequence({ FAKE_CLAUDE_MODE: "budget", FAKE_CLAUDE_EFFECT: "" }, {}) });
    const r = await build(h);

    expect(r.after.status).toBe("built");
    expect(r.claude[1]!.argv[1]).toContain("--max-budget-usd");
    expect(r.runs).toMatchObject([{ exitStatus: "budget-exceeded", totalCostUsd: 2.01 }, { exitStatus: "success" }]);
  });

  it("a deploy failure is retried too", async () => {
    const h = makeHarness({ wranglerEnv: { FAKE_WRANGLER_FAIL: "1" } });
    const r = await build(h);

    expect(r.after.status).toBe("build-failed");
    expect(r.claude).toHaveLength(2);
    expect(r.claude[1]!.argv[1]).toContain("wrangler deploy failed");
  });

  it("discards uncommitted work before the retry, so it starts from a clean tree at the last commit", async () => {
    const h = makeHarness({
      claudeEnv: { FAKE_CLAUDE_LOG_STATUS: "1", ...sequence({ FAKE_CLAUDE_EFFECT: "commit,modify-spec,stage-file,dirty" }, { FAKE_CLAUDE_EFFECT: "" }) },
    });
    const r = await build(h);

    expect(r.claude[0]!.status).toBe(""); // the first run started clean
    expect(r.claude[1]!.status).toBe(""); // and so did the retry, though the first left a modified, a staged and an untracked file
    expect(r.after.status).toBe("built");
    const repo = h.repoDir("cat-coin");
    expect(existsSync(join(repo, "leftover.txt"))).toBe(false);
    expect(existsSync(join(repo, "staged.txt"))).toBe(false);
    expect(readFileSync(join(repo, "SPEC.md"), "utf8")).not.toContain("half-done");
    expect(vcs(repo, "status", "--porcelain")).toBe("");
    // The committed work survived: the retry started from it.
    expect(existsSync(join(repo, "src/feature.ts"))).toBe(true);
  });

  it("the wall clock kills the child, counts as a failure and is retried once; the session comes from the stream's init message", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_MODE: "hang-init", FAKE_CLAUDE_EFFECT: "" }, routing: { build: { timeoutMs: 5_000 } } });
    const r = await build(h);

    expect(r.after).toMatchObject({ status: "build-failed", buildSessionId: SESSION, brainRunInFlightSince: null });
    expect(r.runs).toMatchObject([{ exitStatus: "timed-out", totalCostUsd: 0 }, { exitStatus: "timed-out", totalCostUsd: 0 }]);
    expect(r.history.at(-1)!.reason).toContain("timed-out");
    expect(h.containers()).toEqual([]);
  });

  it("a setup failure is not retried", async () => {
    const h = makeHarness({ ghEnv: { FAKE_GH_FAIL: "1" } });
    const r = await build(h);

    expect(r.after.status).toBe("build-failed");
    expect(r.claude).toEqual([]);
    expect(r.runs).toHaveLength(1);
  });

  it("a shutdown is not retried", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_MODE: "hang-report", FAKE_CLAUDE_EFFECT: "" } });
    const ac = new AbortController();
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options, ac.signal);
    await untilExists(h.started);
    ac.abort();
    expect(await running).toEqual({ proposalId: p.id, result: "build-failed" });
    expect(h.calls(h.claudeLog)).toHaveLength(1);
    expect(h.store.brainRunsFor(p.id)).toMatchObject([{ exitStatus: "interrupted" }]);
  });
});
