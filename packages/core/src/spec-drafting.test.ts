import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBrain, STALE_RUN_GRACE_MS, resolveRouting, type Brain } from "./brain.ts";
import { Datastore, MAX_SPEC_RATE_LIMIT_ATTEMPTS } from "./datastore.ts";
import { draftPendingSpecs, draftSpec, draftable, specProblem } from "./spec-drafting.ts";
import { FAKE_CLAUDE } from "./testing/fake-claude.ts";

function setup(mode: string, routing = resolveRouting(), result?: string) {
  const store = Datastore.open(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "argus-spec-"));
  const brain = new ClaudeCodeBrain({
    routing,
    killGraceMs: 200,
    command: FAKE_CLAUDE,
    env: { PATH: process.env.PATH, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_RESULT: result },
    passEnv: ["FAKE_CLAUDE_MODE", "FAKE_CLAUDE_RESULT"],
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

const SPEC = "# Cat Coin\n\nA cat page.\n\n## Goal\n\nSee cats.\n\n## Scope\n\n- Cats.\n\n## Acceptance criteria\n\n- [ ] Cats show.\n";

function addShortlisted(store: Datastore, name: string): number {
  const p = store.createProposal({ narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name, ticker: name.slice(0, 3).toUpperCase(), description: "d", evidenceLinks: [] });
  store.transition(p.id, "shortlisted", "operator");
  return p.id;
}

describe("Spec validity (the spec skill's output contract)", () => {
  it("accepts a full Spec and the Needs human form", () => {
    expect(specProblem(SPEC)).toBeNull();
    expect(specProblem("## Needs human\n\nThe Tech needs an on-chain program, which is out of scope.\n")).toBeNull();
  });

  it("rejects a refusal or other prose that is not a Spec", () => {
    expect(specProblem("I don't have a tool to read files, so I can't write this Spec.")).toContain("does not start with");
    expect(specProblem("Sure! Here is the Spec:\n\n" + SPEC)).toContain("does not start with");
    expect(specProblem("```markdown\n" + SPEC + "```")).toContain("does not start with");
  });

  it("rejects a Spec missing a required section, and names it", () => {
    expect(specProblem("# X\n\n## Goal\n\ng\n\n## Scope\n\ns\n")).toBe("missing required section(s): ## Acceptance criteria");
    expect(specProblem("# X\n\nGoal and Scope and Acceptance criteria in prose.")).toContain("## Goal, ## Scope, ## Acceptance criteria");
  });

  it("rejects an empty Needs human, or one with other sections", () => {
    expect(specProblem("## Needs human")).toContain("no explanation");
    expect(specProblem("## Needs human\n\nwhy\n\n## Goal\n\nmore")).toContain("only section");
  });
});

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

  it("a refusal returned as a successful run fails the draft: spec_error, no spec.md, spend kept, not re-drafted", async () => {
    const { store, dir, brain, id } = setup("success", resolveRouting(), "I don't have a tool to read that, sorry.");
    expect(await draftPendingSpecs(store, brain, dir, quiet)).toBe(0);
    const p = store.getProposal(id)!;
    expect(p).toMatchObject({ status: "shortlisted", specPath: null, specRetryAfter: null });
    expect(p.specError).toContain("Spec draft invalid");
    expect(p.specError).toContain("does not start with");
    expect(p.specError).toContain("I don't have a tool");
    expect(existsSync(join(dir, "proposals", String(id), "spec.md"))).toBe(false);
    expect(store.brainRunsFor(id)).toMatchObject([{ exitStatus: "invalid-output", totalCostUsd: 0.0123 }]);
    expect(await draftPendingSpecs(store, brain, dir, quiet)).toBe(0);
    expect(store.brainRunsFor(id)).toHaveLength(1);
  });

  it("a Needs human Spec is saved like any other valid Spec", async () => {
    const { store, dir, brain, id } = setup("success", resolveRouting(), "## Needs human\n\nNeeds a wallet that signs.\n");
    expect(await draftPendingSpecs(store, brain, dir, quiet)).toBe(1);
    expect(store.getProposal(id)!.status).toBe("spec-drafted");
  });

  describe("shutdown", () => {
    it("an aborted signal stops the loop before any draft: nothing is spawned or recorded", async () => {
      const { store, dir, brain, id } = setup("success");
      const second = addShortlisted(store, "Dog Coin");
      expect(await draftPendingSpecs(store, brain, dir, quiet, AbortSignal.abort())).toBe(0);
      expect(await draftSpec(store, brain, store.getProposal(id)!, dir, AbortSignal.abort())).toBe(false);
      expect(store.brainRunsFor(id)).toHaveLength(0);
      expect(store.brainRunsFor(second)).toHaveLength(0);
    });

    it("stopping during the first draft leaves the second undrafted, and the first is interrupted and drafted next boot", async () => {
      const { store, dir, brain, id } = setup("hang", resolveRouting({ spec: { timeoutMs: 60_000 } }));
      const second = addShortlisted(store, "Dog Coin");
      const ac = new AbortController();
      let runs = 0;
      const hung = wrap(brain, (go) => {
        runs++;
        setTimeout(() => ac.abort(), 150);
        return go();
      });
      expect(await draftPendingSpecs(store, hung, dir, quiet, ac.signal)).toBe(0);
      expect(runs).toBe(1);
      const both = [id, second];
      expect(both.map((i) => store.brainRunsFor(i).length).sort()).toEqual([0, 1]);
      for (const i of both) {
        expect(store.getProposal(i)).toMatchObject({ status: "shortlisted", specError: "", specRetryAfter: null, brainRunInFlightSince: null });
        for (const r of store.brainRunsFor(i)) expect(r).toMatchObject({ exitStatus: "interrupted", totalCostUsd: 0 });
      }

      // Next boot: both are still draftable.
      const next = new ClaudeCodeBrain({ command: FAKE_CLAUDE, env: { PATH: process.env.PATH }, killGraceMs: 200 });
      expect(await draftPendingSpecs(store, next, dir, quiet)).toBe(2);
      expect(store.getProposal(id)!.status).toBe("spec-drafted");
    });

    it("records the spend a killed run reports", async () => {
      const { store, dir, brain, id } = setup("hang-report", resolveRouting({ spec: { timeoutMs: 60_000 } }));
      const ac = new AbortController();
      const hung = wrap(brain, (go) => {
        setTimeout(() => ac.abort(), 150);
        return go();
      });
      await draftSpec(store, hung, store.getProposal(id)!, dir, ac.signal);
      expect(store.brainRunsFor(id)).toMatchObject([{ exitStatus: "interrupted", totalCostUsd: 0.004, sessionId: "fake-session-1" }]);
      expect(store.getProposal(id)).toMatchObject({ status: "shortlisted", specError: "", agentCostUsd: 0.004 });
    });
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

      expect(store.interruptStaleBrainRuns(() => 0, new Date(Date.now() + 1))).toBe(1);
      const p = store.getProposal(id)!;
      expect(p.brainRunInFlightSince).toBeNull();
      expect(p.status).toBe("shortlisted");
      expect(p.specError).toContain("interrupted");
      expect(store.brainRunsFor(id)[0]!.exitStatus).toBe("interrupted");
      expect(await draftPendingSpecs(store, brain, dir, quiet)).toBe(0);
      expect(store.brainRunsFor(id)).toHaveLength(1);
      expect(store.interruptStaleBrainRuns(() => 0, new Date(Date.now() + 1))).toBe(0);
    });

    it("a crash-left spec row older than timeout + grace is swept on a later tick with no restart; a younger one is not", async () => {
      const { store, dir, brain, id } = setup("success");
      store.startBrainRun({ proposalId: id, task: "spec", backend: "claude-code", model: "sonnet" });
      const staleAfter = brain.staleAfterMs("spec");
      expect(staleAfter).toBe(10 * 60_000 + STALE_RUN_GRACE_MS);
      const sweep = (at: number) => store.interruptStaleBrainRuns((t) => brain.staleAfterMs(t), new Date(Date.now() + at));
      expect(sweep(staleAfter - 60_000)).toBe(0); // younger: left alone
      expect(store.getProposal(id)).toMatchObject({ specError: "" });
      expect(store.getProposal(id)!.brainRunInFlightSince).not.toBeNull();
      expect(sweep(staleAfter + 1_000)).toBe(1);
      expect(store.brainRunsFor(id)[0]!.exitStatus).toBe("interrupted");
      expect(store.getProposal(id)!.brainRunInFlightSince).toBeNull();
    });

    it("the sweep makes the Proposal draftable again, marked interrupted", () => {
      const { store, brain, id } = setup("success");
      store.startBrainRun({ proposalId: id, task: "spec", backend: "claude-code", model: "sonnet" });
      expect(draftable(store).map((p) => p.id)).not.toContain(id);
      store.interruptStaleBrainRuns((t) => brain.staleAfterMs(t), new Date(Date.now() + 16 * 60_000));
      expect(store.brainRunsFor(id)[0]!.exitStatus).toBe("interrupted");
      expect(store.getProposal(id)!.brainRunInFlightSince).toBeNull();
      expect(store.getProposal(id)!.specError).toContain("interrupted");
    });

    it("a live run is never swept: it is killed at its timeout, before the row goes stale", async () => {
      const { store, dir, brain, id } = setup("hang", resolveRouting({ spec: { timeoutMs: 300 } }));
      let swept = -1;
      const spy = wrap(brain, async (go) => {
        // Mid-run, and even at the last instant the row can exist (its timeout), the row is not stale.
        const t0 = Date.now();
        swept = store.interruptStaleBrainRuns((t) => brain.staleAfterMs(t), new Date(t0 + 300));
        return go();
      });
      await draftSpec(store, spy, store.getProposal(id)!, dir);
      expect(swept).toBe(0);
      expect(store.brainRunsFor(id)[0]!.exitStatus).not.toBe("interrupted");
      expect(store.brainRunsFor(id)[0]!.exitStatus).not.toBe("in-flight");
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
