import { describe, expect, it } from "vitest";
import { Datastore } from "./datastore.ts";
import { DEFAULT_RESEARCH_BUDGET_CONFIG, researchBudgetUsd, researchConfigFromEnv, researchUsage } from "./research-budget.ts";

const NOW = new Date("2026-06-14T12:00:00.000Z");
const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

describe("the research budget: one rolling-24 h Est. usage figure shared by judge and propose", () => {
  it("is 30% of an assumed daily quota of $20, i.e. $6, by default", () => {
    expect(DEFAULT_RESEARCH_BUDGET_CONFIG).toEqual({ dailyQuotaUsd: 20, share: 0.3 });
    expect(researchBudgetUsd(DEFAULT_RESEARCH_BUDGET_CONFIG)).toBeCloseTo(6, 10);
  });

  it("reads ARGUS_DAILY_QUOTA_USD and ARGUS_RESEARCH_SHARE", () => {
    const c = researchConfigFromEnv({ ARGUS_DAILY_QUOTA_USD: "50", ARGUS_RESEARCH_SHARE: "0.2" });
    expect(c).toEqual({ dailyQuotaUsd: 50, share: 0.2 });
    expect(researchBudgetUsd(c)).toBeCloseTo(10, 10);
    expect(researchConfigFromEnv({})).toEqual(DEFAULT_RESEARCH_BUDGET_CONFIG);
    expect(researchConfigFromEnv({ ARGUS_DAILY_QUOTA_USD: "", ARGUS_RESEARCH_SHARE: "" })).toEqual(DEFAULT_RESEARCH_BUDGET_CONFIG);
  });

  it("validates after parsing: a quota that is not a positive number, or a share outside (0, 1], is an error, not a fallback", () => {
    for (const bad of ["0", "-5", "abc", "NaN", "Infinity", "1e999"]) {
      expect(() => researchConfigFromEnv({ ARGUS_DAILY_QUOTA_USD: bad }), bad).toThrow(/ARGUS_DAILY_QUOTA_USD/);
    }
    for (const bad of ["0", "-0.1", "1.5", "30", "abc", "NaN"]) {
      expect(() => researchConfigFromEnv({ ARGUS_RESEARCH_SHARE: bad }), bad).toThrow(/ARGUS_RESEARCH_SHARE/);
    }
    expect(researchConfigFromEnv({ ARGUS_RESEARCH_SHARE: "1" }).share).toBe(1);
  });

  it("reports usage over the last 24 hours, judge and propose together, against the budget", () => {
    const store = Datastore.open(":memory:");
    const add = (task: string, cost: number, at: Date) => {
      const id = store.startBrainRun({ proposalId: 0, task, backend: "claude-code", model: "m" }, at);
      store.finishBrainRun(id, { sessionId: null, totalCostUsd: cost, exitStatus: "success" });
    };
    add("judge", 1.5, hours(-1));
    add("propose", 2.5, hours(-3));
    add("judge", 100, hours(-25)); // aged out
    add("spec", 100, hours(-1)); // not research
    const u = researchUsage(store, NOW, DEFAULT_RESEARCH_BUDGET_CONFIG);
    expect(u).toMatchObject({ runs: 2, usedUsd: 4, quotaUsd: 20, share: 0.3, exhausted: false });
    expect(u.budgetUsd).toBeCloseTo(6, 10);
    expect(u.usedShareOfQuota).toBeCloseTo(0.2, 10);
    add("propose", 2, hours(-1));
    expect(researchUsage(store, NOW, DEFAULT_RESEARCH_BUDGET_CONFIG)).toMatchObject({ usedUsd: 6, exhausted: true });
  });
});
