import { tempDir } from "./testing/temp.ts";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBrain, resolveRouting } from "./brain.ts";
import { Datastore, MAX_SPEC_RATE_LIMIT_ATTEMPTS } from "./datastore.ts";
import { applyPending as applyPendingCommands } from "./testing/apply.ts";
import { draftPendingSpecs } from "./spec-drafting.ts";
import { FAKE_CLAUDE } from "./testing/fake-claude.ts";

const quiet = () => {};
const brainIn = (mode: string, result?: string) =>
  new ClaudeCodeBrain({
    routing: resolveRouting(),
    command: FAKE_CLAUDE,
    env: { PATH: process.env.PATH, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_RESULT: result },
    passEnv: ["FAKE_CLAUDE_MODE", "FAKE_CLAUDE_RESULT"],
  });

function setup() {
  const store = Datastore.open(":memory:");
  const dir = tempDir("argus-retry-");
  const p = store.createProposal({ narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: "Cat Coin", ticker: "CAT", description: "d", evidenceLinks: [] });
  store.transition(p.id, "shortlisted", "operator");
  return { store, dir, id: p.id };
}

const retry = (store: Datastore, id: number) => {
  const c = store.enqueueCommand(id, "retry-spec");
  applyPendingCommands(store);
  return store.getCommand(c.id)!;
};

describe("Retry Spec", () => {
  it("after a failed draft: clears the error, drafts again on the next pass, and each attempt is its own brain run", async () => {
    const { store, dir, id } = setup();
    await draftPendingSpecs(store, brainIn("failure"), dir, quiet);
    expect(store.getProposal(id)!.specError).toMatch(/failed/);
    expect(await draftPendingSpecs(store, brainIn("success"), dir, quiet)).toBe(0); // no automatic retry

    expect(retry(store, id).status).toBe("applied");
    expect(store.getProposal(id)).toMatchObject({ specError: "", specAttempts: 0, specRetryAfter: null, status: "shortlisted" });

    expect(await draftPendingSpecs(store, brainIn("success"), dir, quiet)).toBe(1);
    const p = store.getProposal(id)!;
    expect(p.status).toBe("spec-drafted");
    const runs = store.brainRunsFor(id);
    expect(runs.map((r) => [r.exitStatus, r.totalCostUsd])).toEqual([["failed", 0.004], ["success", 0.0123]]);
    expect(p.agentCostUsd).toBeCloseTo(0.0163);
  });

  it("after invalid output", async () => {
    const { store, dir, id } = setup();
    await draftPendingSpecs(store, brainIn("success", "I can't do that"), dir, quiet);
    expect(store.getProposal(id)!.specError).toMatch(/invalid/);
    expect(retry(store, id).status).toBe("applied");
    await draftPendingSpecs(store, brainIn("success"), dir, quiet);
    expect(store.getProposal(id)!.status).toBe("spec-drafted");
    expect(store.brainRunsFor(id).map((r) => r.exitStatus)).toEqual(["invalid-output", "success"]);
  });

  it("after rate limiting gave up: attempts reset so it gets a fresh allowance", async () => {
    const { store, dir, id } = setup();
    for (let i = 0; i < MAX_SPEC_RATE_LIMIT_ATTEMPTS; i++) {
      store.failSpec(id, "limit", { rateLimited: true, backoffMs: 0 });
    }
    expect(store.getProposal(id)).toMatchObject({ specAttempts: MAX_SPEC_RATE_LIMIT_ATTEMPTS });
    expect(retry(store, id).status).toBe("applied");
    expect(store.getProposal(id)).toMatchObject({ specAttempts: 0, specError: "" });
    expect(await draftPendingSpecs(store, brainIn("success"), dir, quiet)).toBe(1);
  });

  it("repeated retries each add a brain run", async () => {
    const { store, dir, id } = setup();
    for (let i = 0; i < 3; i++) {
      await draftPendingSpecs(store, brainIn("failure"), dir, quiet);
      expect(retry(store, id).status).toBe("applied");
    }
    await draftPendingSpecs(store, brainIn("failure"), dir, quiet);
    expect(store.brainRunsFor(id)).toHaveLength(4);
    expect(store.getProposal(id)!.agentCostUsd).toBeCloseTo(0.016);
  });

  it("is refused while a brain run is in flight, and changes nothing", async () => {
    const { store, id } = setup();
    store.failSpec(id, "Spec draft failed: boom");
    const run = store.startBrainRun({ proposalId: id, task: "spec", backend: "claude-code", model: "sonnet" });
    const c = retry(store, id);
    expect(c).toMatchObject({ status: "rejected" });
    expect(c.error).toMatch(/in flight/i);
    expect(store.getProposal(id)!.specError).toBe("Spec draft failed: boom");
    store.finishBrainRun(run, { sessionId: null, totalCostUsd: 0, exitStatus: "failed" });
    expect(retry(store, id).status).toBe("applied"); // allowed again once it has finished
  });

  it("is refused when there is nothing to retry", async () => {
    const { store, id } = setup();
    expect(retry(store, id)).toMatchObject({ status: "rejected" });
    expect(retry(store, id).error).toMatch(/nothing to retry/i);
  });
});
