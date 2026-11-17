import { describe, expect, it } from "vitest";
import { runNextBuild } from "./build-runner.ts";
import { DEFAULT_RESEARCH_BUDGET_CONFIG } from "./research-budget.ts";
import { makeHarness, type Harness } from "./testing/build-harness.ts";

// Hardening ticket 11: the daily budget (rolling 24 h, ARGUS_DAILY_QUOTA_USD) gates the start of a Build. A used-up budget makes the
// Build wait (the Proposal stays approved, the refusal says why and when); it starts by itself once the window has room.

const QUOTA = DEFAULT_RESEARCH_BUDGET_CONFIG.dailyQuotaUsd;
const hours = (h: number) => h * 3_600_000;

/** A finished Build run of `cost` dollars that started `agoMs` before `now` (it counts in the daily figure from its start). */
function seedSpend(h: Harness, now: Date, agoMs: number, cost: number): void {
  const id = h.store.startBrainRun({ proposalId: 999, task: "build", backend: "claude-code", model: "sonnet" }, new Date(now.getTime() - agoMs));
  h.store.finishBrainRun(id, { sessionId: null, totalCostUsd: cost, exitStatus: "success" });
}

describe("the daily budget gates the start of a Build", { timeout: 60_000 }, () => {
  it("a used-up budget starts nothing and says why and when; the Build starts by itself when the window has room", async () => {
    const h = makeHarness();
    let now = new Date();
    h.options.budgetNow = () => now;
    // $12 started 20 h ago and $10 started 10 h ago: $22 of a $20 quota. The first ages out 4 h from now, leaving $10.
    seedSpend(h, now, hours(20), 12);
    seedSpend(h, now, hours(10), 10);
    const p = h.seedApproved("Cat Coin");

    expect(await runNextBuild(h.store, h.brain, h.options)).toBeUndefined();
    expect(h.store.getProposal(p.id)!.status).toBe("approved");
    expect(h.store.brainRunsFor(p.id)).toEqual([]);
    const refusal = h.store.buildRefusalFor(p.id)!;
    expect(refusal.code).toBe("daily-budget");
    const freeAt = new Date(now.getTime() + hours(4)).toISOString().slice(0, 16).replace("T", " ");
    expect(refusal.message).toContain("daily budget");
    expect(refusal.message).toContain(`$22.00 of $${QUOTA.toFixed(2)}`);
    expect(refusal.message).toContain(`${freeAt} UTC`);

    // Not yet: still waiting, not failed.
    now = new Date(now.getTime() + hours(3));
    expect(await runNextBuild(h.store, h.brain, h.options)).toBeUndefined();
    expect(h.store.getProposal(p.id)!.status).toBe("approved");

    // The $12 run has aged out of the rolling window: the Build starts by itself and the refusal is gone.
    now = new Date(now.getTime() + hours(1) + 60_000);
    expect((await runNextBuild(h.store, h.brain, h.options))?.result).toBe("built");
    expect(h.store.buildRefusalFor(p.id)).toBeNull();
  });

  it("a budget with room starts the Build as before", async () => {
    const h = makeHarness();
    const now = new Date();
    h.options.budgetNow = () => now;
    seedSpend(h, now, hours(1), QUOTA - 1);
    h.seedApproved("Cat Coin");
    expect((await runNextBuild(h.store, h.brain, h.options))?.result).toBe("built");
  });
});
