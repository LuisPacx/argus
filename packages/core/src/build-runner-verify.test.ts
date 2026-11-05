import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tempPath } from "./testing/temp.ts";
import { describe, expect, it, vi } from "vitest";
import { buildLogPathFor, classifyFinalMessage, runNextBuild } from "./build-runner.ts";
import { PAGE, fakePreview, makeHarness, type Harness } from "./testing/build-harness.ts";
import { untilExists } from "./testing/wait.ts";

/** Runs one Build and returns the Proposal after, its last status reason, and what the fakes saw. */
async function build(h: Harness, name = "Cat Coin") {
  const p = h.seedApproved(name);
  const outcome = await runNextBuild(h.store, h.brain, h.options);
  const after = h.store.getProposal(p.id)!;
  const reason = h.store.historyFor(p.id).at(-1)!.reason;
  return { p, outcome, after, reason, deploys: h.deployCalls(), runs: h.store.brainRunsFor(p.id) };
}

// Each test runs whole Builds: git, a container's worth of fake processes, a bundle and a deploy. Under load that is not 5 s.
describe("Build Runner: a Build succeeds only on argus's own checks", { timeout: 60_000 }, () => {
  describe("the final message's last line", () => {
    it("classifies only the last line, per the template README contract", () => {
      expect(classifyFinalMessage("Done.\npnpm check passed")).toEqual({ kind: "ok" });
      expect(classifyFinalMessage("")).toEqual({ kind: "ok" });
      expect(classifyFinalMessage('ARGUS_BUILD_FAILED::{"summary":"checks failed"}\nmore text')).toEqual({ kind: "ok" });
      expect(classifyFinalMessage('Done.\nARGUS_BUILD_FAILED::{"summary":"checks failed"}')).toEqual({ kind: "failed", summary: "checks failed" });
      expect(classifyFinalMessage('Stop.\nARGUS_NEEDS_HUMAN::{"reason":"needs an on-chain program"}\n')).toEqual({ kind: "needs-human", reason: "needs an on-chain program" });
    });

    it("treats an unparseable, empty or decorated marker as a failure, never as success", () => {
      for (const last of [
        "ARGUS_BUILD_FAILED::{not json",
        "ARGUS_NEEDS_HUMAN::{}",
        'ARGUS_BUILD_FAILED::{"summary":""}',
        'ARGUS_BUILD_FAILED::{"summary":7}',
        '`ARGUS_BUILD_FAILED::{"summary":"x"}`',
        'Result: ARGUS_NEEDS_HUMAN::{"reason":"x"}',
        'ARGUS_DONE::{"ok":true}',
      ]) {
        expect(classifyFinalMessage(`ok\n${last}`).kind, last).toBe("failed");
      }
    });
  });

  it("a marker only inside a tool result is ignored: the run still succeeds", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_NOISE: "1" } });
    expect((await build(h)).after.status).toBe("built");
  });

  it("a needs-human marker only inside a tool result does not route to needs-human", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_NOISE: 'ARGUS_NEEDS_HUMAN::{"reason":"from a tool result"}' } });
    expect((await build(h)).after.status).toBe("built");
  });

  it("needs-human is final: one claude run, no retry, no deploy", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_EFFECT: "", FAKE_CLAUDE_RESULT: 'No.\nARGUS_NEEDS_HUMAN::{"reason":"needs a wallet"}' } });
    const r = await build(h);
    expect(r.after.status).toBe("needs-human");
    expect(h.calls(h.claudeLog)).toHaveLength(1);
    expect(h.store.listProposals().some((p) => p.status === "building")).toBe(false);
  });

  it("a Spec whose first line is `## Needs human` goes approved -> needs-human before anything is spawned", async () => {
    const h = makeHarness();
    const p = h.seedApproved("Chain Coin");
    writeFileSync(p.specPath!, "## Needs human\n\nThe Tech needs an on-chain program.\n");
    const outcome = await runNextBuild(h.store, h.brain, h.options);
    const after = h.store.getProposal(p.id)!;
    expect(outcome).toEqual({ proposalId: p.id, result: "needs-human" });
    expect(after.status).toBe("needs-human");
    expect(h.store.historyFor(p.id).at(-1)).toMatchObject({ from: "approved", to: "needs-human" });
    expect(h.store.historyFor(p.id).at(-1)!.reason).toContain("on-chain program");
    expect(h.calls(h.claudeLog)).toEqual([]);
    expect(h.calls(h.ghLog)).toEqual([]);
    expect(h.podmanCalls()).toEqual([]);
    expect(h.store.brainRunsFor(p.id)).toEqual([]);
    expect(existsSync(h.repoDir(p.slug))).toBe(false);
  });

  it("ARGUS_BUILD_FAILED as the last line fails the Build with the summary, no deploy", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_RESULT: 'I gave up.\nARGUS_BUILD_FAILED::{"summary":"pnpm check still failing"}' } });
    const r = await build(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.reason).toContain("pnpm check still failing");
    expect(r.deploys).toEqual([]);
    expect(r.runs).toMatchObject([{ exitStatus: "success", totalCostUsd: 0.0123 }]);
  });

  it("ARGUS_NEEDS_HUMAN as the last line moves the Proposal to needs-human, no deploy", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_EFFECT: "", FAKE_CLAUDE_RESULT: 'Not buildable.\nARGUS_NEEDS_HUMAN::{"reason":"needs an on-chain program"}' } });
    const r = await build(h);
    expect(r).toMatchObject({ outcome: { result: "needs-human" }, after: { status: "needs-human" } });
    expect(r.reason).toContain("needs an on-chain program");
    expect(r.deploys).toEqual([]);
    expect(r.after.agentCostUsd).toBeCloseTo(0.0123);
  });

  it("fails when HEAD has not advanced past the Spec commit", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_EFFECT: "" } });
    const r = await build(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.reason).toContain("HEAD has not advanced");
    expect(r.deploys).toEqual([]);
  });

  it("fails when the working tree is not clean", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_EFFECT: "commit,dirty" } });
    const r = await build(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.reason).toContain("working tree is not clean");
    expect(r.reason).toContain("leftover.txt");
    expect(r.deploys).toEqual([]);
  });

  for (const [effect, what] of [
    ["tamper-scripts,commit", "scripts/check-footer.ts"],
    ["tamper-claude,commit", ".claude/settings.json"],
    ["tamper-github,commit", ".github/workflows/ci.yml"],
  ] as const) {
    it(`fails when ${what} differs from the template commit`, async () => {
      const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_EFFECT: effect } });
      const r = await build(h);
      expect(r.after.status).toBe("build-failed");
      expect(r.reason).toContain("protected paths differ");
      expect(r.reason).toContain(what);
      expect(r.deploys).toEqual([]);
    });
  }

  it("fails when the scripts field of package.json differs from the template", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_EFFECT: "tamper-package-scripts,commit" } });
    const r = await build(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.reason).toContain("scripts field of package.json");
    expect(r.deploys).toEqual([]);
  });

  it("never runs a script from the Build repo: runner git ignores hooks and fsmonitor the agent planted in .git", async () => {
    const marker = tempPath("pwned");
    rmSync(marker, { force: true });
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_EFFECT: "commit,plant-git-scripts", FAKE_CLAUDE_MARKER: marker } });
    const r = await build(h);
    expect(r.after.status).toBe("built");
    expect(existsSync(marker)).toBe(false);
  });

  describe("the deployed preview", () => {
    it("is not built when a linked page lacks the exact disclosure sentence", async () => {
      const h = makeHarness({
        fetch: fakePreview({ "/": [200, "text/html", PAGE('<a href="/about">about</a>')], "/about": [200, "text/html", "<!doctype html><html><body>about us</body></html>"] }),
      });
      const r = await build(h);
      expect(r.after).toMatchObject({ status: "build-failed", previewUrl: null });
      expect(r.reason).toContain("/about");
      expect(r.reason).toContain("still deployed");
      expect(r.deploys).toHaveLength(1);
    });

    it("is not built when the 404 page lacks it", async () => {
      const h = makeHarness({ fetch: fakePreview({ "/__argus_not_found__": [404, "text/html", "<!doctype html><html><body>nope</body></html>"] }) });
      const r = await build(h);
      expect(r.after.status).toBe("build-failed");
      expect(r.reason).toContain("/__argus_not_found__");
    });

    it("is not built when it never responds", async () => {
      const h = makeHarness({ fetch: (async () => new Response("bad gateway", { status: 502 })) as typeof fetch });
      const r = await build(h);
      expect(r.after).toMatchObject({ status: "build-failed", previewUrl: null });
      expect(r.reason).toContain("did not respond");
    });

    it("is not built when wrangler prints no workers.dev URL", async () => {
      const h = makeHarness({ wranglerEnv: { FAKE_WRANGLER_URL: "https://example.com/not-cloudflare" } });
      const r = await build(h);
      expect(r.after.status).toBe("build-failed");
      expect(r.reason).toContain("no workers.dev URL");
    });

    it("is not built when wrangler deploy fails", async () => {
      const h = makeHarness({ wranglerEnv: { FAKE_WRANGLER_FAIL: "1" } });
      const r = await build(h);
      expect(r.after).toMatchObject({ status: "build-failed", previewUrl: null });
      expect(r.reason).toContain("wrangler deploy failed");
      // The spend of the claude run is still on the card.
      expect(r.after.agentCostUsd).toBeCloseTo(0.0123);
    });
  });
});

describe("Build Runner: spend is recorded on every path", { timeout: 60_000 }, () => {
  it("a failed claude run records its cost and session on the run and the card", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_MODE: "failure", FAKE_CLAUDE_EFFECT: "" } });
    const r = await build(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.runs).toMatchObject([{ task: "build", exitStatus: "failed", totalCostUsd: 0.004, sessionId: "5e55a0a0-0000-4000-8000-000000000001" }]);
    expect(r.after.agentCostUsd).toBeCloseTo(0.004);
    expect(r.after.brainRunInFlightSince).toBeNull();
    expect(r.deploys).toEqual([]);
  });

  it("hitting the budget cap fails the Build and records the spend", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_MODE: "budget", FAKE_CLAUDE_EFFECT: "" } });
    const r = await build(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.runs).toMatchObject([{ exitStatus: "budget-exceeded", totalCostUsd: 2.01 }]);
  });

  it("the wall-clock cap kills the child, fails the Build and records the run", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_MODE: "hang-report", FAKE_CLAUDE_EFFECT: "" }, routing: { build: { timeoutMs: 60_000 } } });
    // The cap is a timer here, driven by hand once claude says it is up (its SIGTERM handler, which reports the cost, is
    // installed by then): no guess at how long node takes to start under load.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const p = h.seedApproved("Cat Coin");
      const running = runNextBuild(h.store, h.brain, h.options);
      await untilExists(h.started);
      vi.advanceTimersByTime(60_000);
      await running;
      const runs = h.store.brainRunsFor(p.id);
      expect(h.store.getProposal(p.id)!.status).toBe("build-failed");
      expect(runs).toMatchObject([{ exitStatus: "timed-out", totalCostUsd: 0.004 }]);
      expect(h.store.historyFor(p.id).at(-1)!.reason).toContain("timed-out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shutdown mid-run kills the child, records it interrupted and frees the Build slot", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_MODE: "hang-report", FAKE_CLAUDE_EFFECT: "" } });
    const ac = new AbortController();
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options, ac.signal);
    await untilExists(h.started);
    ac.abort();
    expect(await running).toEqual({ proposalId: p.id, result: "build-failed" });
    expect(h.store.brainRunsFor(p.id)).toMatchObject([{ exitStatus: "interrupted" }]);
    expect(h.store.getProposal(p.id)).toMatchObject({ status: "build-failed", brainRunInFlightSince: null });
    expect(h.deployCalls()).toEqual([]);
  });

  it("a setup failure (gh repo create) spawns no claude, records no spend and fails the Build", async () => {
    const h = makeHarness({ ghEnv: { FAKE_GH_FAIL: "1" } });
    const r = await build(h);
    expect(r.after.status).toBe("build-failed");
    expect(r.reason).toContain("gh repo create failed");
    expect(h.calls(h.claudeLog)).toEqual([]);
    expect(r.runs).toMatchObject([{ exitStatus: "failed", totalCostUsd: 0 }]);
    expect(r.after.brainRunInFlightSince).toBeNull();
  });

  it("refuses to build over an existing directory", async () => {
    const h = makeHarness();
    const p = h.seedApproved("Cat Coin");
    writeFileSync(h.repoDir("cat-coin"), "in the way");
    const outcome = await runNextBuild(h.store, h.brain, h.options);
    expect(outcome).toEqual({ proposalId: p.id, result: "build-failed" });
    expect(h.store.historyFor(p.id).at(-1)!.reason).toContain("already exists");
    expect(readFileSync(h.repoDir("cat-coin"), "utf8")).toBe("in the way");
    expect(h.calls(h.claudeLog)).toEqual([]);
  });

  it("a Proposal dismissed during the run keeps its dismissal; the spend is still recorded", async () => {
    const h = makeHarness({ claudeEnv: { FAKE_CLAUDE_EFFECT: "wait-release,commit" } });
    const p = h.seedApproved("Cat Coin");
    const running = runNextBuild(h.store, h.brain, h.options);
    await untilExists(h.started);
    h.store.transition(p.id, "dismissed", "operator", "changed my mind");
    writeFileSync(h.release, "");
    expect(await running).toEqual({ proposalId: p.id, result: "abandoned" });
    expect(h.store.getProposal(p.id)).toMatchObject({ status: "dismissed", previewUrl: null });
    expect(h.store.brainRunsFor(p.id)).toMatchObject([{ exitStatus: "success", totalCostUsd: 0.0123 }]);
    expect(h.deployCalls()).toEqual([]);
  });

  it("a Build run left open by a dead worker is swept: the run is interrupted and the Proposal build-failed", async () => {
    const h = makeHarness();
    const p = h.seedApproved("Cat Coin");
    h.store.transition(p.id, "building", "build");
    h.store.startBrainRun({ proposalId: p.id, task: "build", backend: "claude-code", model: "sonnet" });
    const later = new Date(Date.now() + 5 * 60 * 60_000);
    expect(h.store.interruptStaleBrainRuns((task) => h.brain.staleAfterMs(task), later)).toBe(1);
    expect(h.store.getProposal(p.id)).toMatchObject({ status: "build-failed", brainRunInFlightSince: null });
    expect(h.store.brainRunsFor(p.id)).toMatchObject([{ exitStatus: "interrupted" }]);
    expect(h.store.historyFor(p.id).at(-1)).toMatchObject({ to: "build-failed", actor: "build" });
    expect(buildLogPathFor(h.dataDir, p.id)).toContain(`${p.id}/build.log`);
  });
});
