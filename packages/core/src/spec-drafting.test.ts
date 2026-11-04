import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBrain } from "./brain.ts";
import { Datastore } from "./datastore.ts";
import { draftPendingSpecs } from "./spec-drafting.ts";
import { FAKE_CLAUDE } from "./testing/fake-claude.ts";

function setup(mode: string) {
  const store = Datastore.open(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "argus-spec-"));
  const brain = new ClaudeCodeBrain({
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
});
