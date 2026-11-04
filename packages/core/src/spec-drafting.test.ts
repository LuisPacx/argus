import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBrain, resolveRouting, type Brain } from "./brain.ts";
import { Datastore, MAX_SPEC_RATE_LIMIT_ATTEMPTS } from "./datastore.ts";
import { draftPendingSpecs, draftSpec } from "./spec-drafting.ts";
import { FAKE_CLAUDE } from "./testing/fake-claude.ts";

function setup(mode: string, routing = resolveRouting()) {
  const store = Datastore.open(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "argus-spec-"));
  const brain = new ClaudeCodeBrain({
    routing,
    killGraceMs: 200,
    command: FAKE_CLAUDE,
    env: { PATH: process.env.PATH, FAKE_CLAUDE_MODE: mode },
    passEnv: ["FAKE_CLAUDE_MODE"],
  });
  const p = store.createProposal({
    narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: "Cat Coin", ticker: "CAT", description: "d", evidenceLinks: [],
  });
  store.transition(p.id, "shortlisted", "operator");
  return { store, dir, brain, id: p.id };
}

const quiet = () => {};

/** A Brain delegating to `inner`, with `around` wrapped about each run. */
function wrap(inner: Brain, around: (go: () => Promise<unknown>) => Promise<unknown>): Brain {
  return {
    routeFor: (t) => inner.routeFor(t),
    run: ((...args: Parameters<Brain["run"]>) => around(() => inner.run(...args))) as Brain["run"],
  };
}

describe("Spec drafting", () => {
  it("writes spec.md, stores path and hash, records the run, sets spec-drafted", async () => {
    const { store, dir, brain, id } = setup("success");
    expect(await draftPendingSpecs(store, brain, dir, quiet)).toBe(1);
    const p = store.getProposal(id)!;
    expect(p.status).toBe("spec-drafted");
    expect(p.specPath).toBe(join(dir, "proposals", String(id), "spec.md"));
    const text = readFileSync(p.specPath!, "utf8");
    expect(p.specHash).toBe(createHash("sha256").update(text).digest("hex"));
    expect(store.brainRunsFor(id)).toMatchObject([
      { task: "spec", backend: "claude-code", model: "sonnet", sessionId: "fake-session-1", totalCostUsd: 0.0123, exitStatus: "success" },
    ]);
    expect(p.agentCostUsd).toBeCloseTo(0.0123);
  });

  it("a failed draft leaves the Proposal shortlisted with the error, and does not respend", async () => {
    const { store, dir, brain, id } = setup("failure");
    await draftPendingSpecs(store, brain, dir, quiet);
    const p = store.getProposal(id)!;
    expect(p.status).toBe("shortlisted");
    expect(p.specError).toContain("failed");
    expect(p.specPath).toBeNull();
    expect(store.brainRunsFor(id)[0]).toMatchObject({ exitStatus: "failed", totalCostUsd: 0.004 });
    await draftPendingSpecs(store, brain, dir, quiet);
    expect(store.brainRunsFor(id)).toHaveLength(1);
  });

  it("budget exceeded fails the draft and counts the spend", async () => {
    const { store, dir, brain, id } = setup("budget");
    await draftPendingSpecs(store, brain, dir, quiet);
    expect(store.getProposal(id)).toMatchObject({ status: "shortlisted", agentCostUsd: 2.01 });
    expect(store.getProposal(id)!.specError).toContain("budget-exceeded");
  });

  it("rate limiting sets a retry time instead of giving up", async () => {
    const { store, dir, brain, id } = setup("ratelimit");
    await draftPendingSpecs(store, brain, dir, quiet);
    const p = store.getProposal(id)!;
    expect(p.status).toBe("shortlisted");
    expect(p.specRetryAfter).not.toBeNull();
  });

  it("rate limiting stops retrying after the cap and shows the failure on the card", async () => {
    const { store, dir, brain, id } = setup("ratelimit");
    for (let n = 1; n <= MAX_SPEC_RATE_LIMIT_ATTEMPTS; n++) {
      await draftSpec(store, brain, store.getProposal(id)!, dir);
      const p = store.getProposal(id)!;
      expect(p.specAttempts).toBe(n);
      expect(p.specRetryAfter === null).toBe(n === MAX_SPEC_RATE_LIMIT_ATTEMPTS);
    }
    const p = store.getProposal(id)!;
    expect(p.status).toBe("shortlisted");
    expect(p.specError).toContain("gave up after 3 rate-limited attempts");
    expect(await draftPendingSpecs(store, brain, dir, quiet)).toBe(0);
    expect(store.brainRunsFor(id)).toHaveLength(MAX_SPEC_RATE_LIMIT_ATTEMPTS);
  });

  it("a timed-out draft is killed, fails with a distinct kind and is not retried", async () => {
    const { store, dir, brain, id } = setup("hang", resolveRouting({ spec: { timeoutMs: 300 } }));
    await draftPendingSpecs(store, brain, dir, quiet);
    const p = store.getProposal(id)!;
    expect(p.status).toBe("shortlisted");
    expect(p.specError).toContain("timed-out");
    expect(p.specRetryAfter).toBeNull();
    expect(store.brainRunsFor(id)).toMatchObject([{ exitStatus: "timed-out" }]);
    await draftPendingSpecs(store, brain, dir, quiet);
    expect(store.brainRunsFor(id)).toHaveLength(1);
  });

  it("a run that exits without a result is recorded and fails the draft", async () => {
    const { store, dir, brain, id } = setup("noresult");
    await draftPendingSpecs(store, brain, dir, quiet);
    expect(store.getProposal(id)!.specError).toContain("without a result");
    expect(store.brainRunsFor(id)).toMatchObject([{ exitStatus: "failed", totalCostUsd: 0 }]);
  });

  describe("spend is never lost or doubled", () => {
    it("records the run before any file write: a write failure keeps the cost and is not re-drafted", async () => {
      const { store, brain, id } = setup("success");
      const blocker = join(mkdtempSync(join(tmpdir(), "argus-spec-")), "file");
      writeFileSync(blocker, "x");
      await draftPendingSpecs(store, brain, blocker, quiet); // dataDir is a file: mkdir fails
      const p = store.getProposal(id)!;
      expect(p.status).toBe("shortlisted");
      expect(p.specError).toContain("after the run was recorded");
      expect(p.agentCostUsd).toBeCloseTo(0.0123);
      expect(store.brainRunsFor(id)).toMatchObject([{ exitStatus: "success", sessionId: "fake-session-1" }]);
      expect(await draftPendingSpecs(store, brain, blocker, quiet)).toBe(0);
      expect(store.brainRunsFor(id)).toHaveLength(1);
    });

    it("dismissed mid-run: records the run, no spec_error, no file, no transition", async () => {
      const { store, dir, brain, id } = setup("success");
      const dismissing = wrap(brain, async (go) => {
        const run = await go();
        store.transition(id, "dismissed", "operator", "not interesting");
        return run;
      });
      expect(await draftSpec(store, dismissing, store.getProposal(id)!, dir)).toBe(false);
      const p = store.getProposal(id)!;
      expect(p).toMatchObject({ status: "dismissed", specError: "", specPath: null });
      expect(existsSync(join(dir, "proposals", String(id), "spec.md"))).toBe(false);
      expect(store.brainRunsFor(id)).toMatchObject([{ exitStatus: "success", totalCostUsd: 0.0123 }]);
      expect(store.historyFor(id).map((h) => h.to)).toEqual(["new", "shortlisted", "dismissed"]);
    });

    it("dismissed mid-run with a failing run: records the failure spend, no spec_error", async () => {
      const { store, dir, brain, id } = setup("failure");
      const dismissing = wrap(brain, async (go) => {
        try {
          return await go();
        } finally {
          store.transition(id, "dismissed", "operator", "no");
        }
      });
      await draftSpec(store, dismissing, store.getProposal(id)!, dir);
      expect(store.getProposal(id)).toMatchObject({ status: "dismissed", specError: "", agentCostUsd: 0.004 });
    });

    it("an in-flight row exists while the child runs, and blocks re-drafting", async () => {
      const { store, dir, brain, id } = setup("success");
      let seen: unknown;
      let reentered: boolean | undefined;
      const spy = wrap(brain, async (go) => {
        seen = store.openBrainRun(id, "spec");
        reentered = await draftSpec(store, brain, store.getProposal(id)!, dir);
        return go();
      });
      expect(await draftSpec(store, spy, store.getProposal(id)!, dir)).toBe(true);
      expect(seen).toMatchObject({ exitStatus: "in-flight", model: "sonnet", backend: "claude-code" });
      expect(reentered).toBe(false);
      expect(store.brainRunsFor(id)).toHaveLength(1);
      expect(store.brainRunsFor(id)[0]!.exitStatus).toBe("success");
    });

    it("a stale in-flight row (crash) is not re-drafted, shows on the card, and is flagged at the next boot", async () => {
      const { store, dir, brain, id } = setup("success");
      store.startBrainRun({ proposalId: id, task: "spec", backend: "claude-code", model: "sonnet" }); // worker died here
      expect(store.getProposal(id)!.brainRunInFlightSince).not.toBeNull();
      expect(await draftPendingSpecs(store, brain, dir, quiet)).toBe(0);
      expect(store.brainRunsFor(id)).toHaveLength(1);

      expect(store.interruptStaleBrainRuns()).toBe(1);
      const p = store.getProposal(id)!;
      expect(p.brainRunInFlightSince).toBeNull();
      expect(p.status).toBe("shortlisted");
      expect(p.specError).toContain("interrupted");
      expect(store.brainRunsFor(id)[0]!.exitStatus).toBe("interrupted");
      expect(await draftPendingSpecs(store, brain, dir, quiet)).toBe(0);
      expect(store.brainRunsFor(id)).toHaveLength(1);
      expect(store.interruptStaleBrainRuns()).toBe(0);
    });

    it("--dry-run leaves no brain run behind", async () => {
      const { store, dir, id } = setup("success");
      const brain = new ClaudeCodeBrain({ command: FAKE_CLAUDE, dryRun: true, log: quiet });
      expect(await draftPendingSpecs(store, brain, dir, quiet)).toBe(0);
      expect(store.brainRunsFor(id)).toHaveLength(0);
      expect(store.getProposal(id)).toMatchObject({ status: "shortlisted", specError: "", brainRunInFlightSince: null });
    });
  });
});
