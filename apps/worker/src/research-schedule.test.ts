import { afterEach, describe, expect, it, vi } from "vitest";
import { BrainError, Datastore, DEFAULT_ROUTING, generateMemeIdeas, judgePendingNarratives, memeConfigFromEnv, proposePendingNarratives, type Brain, type NarrativeEmbedder } from "@argus/core";
import { startResearchSchedule } from "./research-schedule.ts";

const EMBEDDER: NarrativeEmbedder = { id: "sem-test", dimension: 2 };
const DAY_MS = 24 * 3_600_000;
const TICK_MS = 30 * 60_000;

/** A Brain that counts every call and always fails: any call in a day that should hold none is caught, and a failure is still counted when on. */
function countingBrain() {
  const calls: string[] = [];
  const brain: Brain = {
    routeFor: (task) => ({ backend: DEFAULT_ROUTING[task].backend, model: DEFAULT_ROUTING[task].model, maxBudgetUsd: DEFAULT_ROUTING[task].maxBudgetUsd }),
    async run(task) {
      calls.push(task);
      throw new BrainError("failed", "fake brain", { backend: "claude-code", model: "sonnet" });
    },
  };
  return { brain, calls };
}

/** A store with one two-Signal Narrative that the judge would pick up (a headline and a market Signal, ADR 0011). */
function storeWithNarrative(now: Date): Datastore {
  const store = Datastore.open(":memory:");
  const at = now.toISOString();
  store.recordSignals([
    { id: "s:1", sourceId: "pumpportal:events", sourceLabel: "Feed", title: "Story", summary: "Story summary", url: "https://a.example/1", publishedAt: at },
    { id: "s:2", sourceId: "rss:wire", sourceLabel: "Wire", title: "Story headline", summary: "", url: "https://a.example/2", publishedAt: at },
  ]);
  const first = store.unclusteredSignals(10).find((s) => s.id === "s:1")!;
  const nid = store.createNarrative(first, [1, 0], at, EMBEDDER);
  store.joinNarrative(nid, store.unclusteredSignals(10).find((s) => s.id === "s:2")!, [1, 0], at);
  return store;
}

afterEach(() => vi.useRealTimers());

describe("ADR 0017: the automatic research tick is a switch, off by default", () => {
  const day = async (enabled: boolean) => {
    vi.useFakeTimers();
    const start = new Date("2026-11-20T00:00:00.000Z");
    vi.setSystemTime(start);
    const store = storeWithNarrative(start);
    const { brain, calls } = countingBrain();
    const lines: string[] = [];
    const memeSettings = memeConfigFromEnv({});
    const run = async () => {
      await judgePendingNarratives(store, brain, EMBEDDER, { config: { minSignals: 1 }, log: () => {} });
      await proposePendingNarratives(store, brain, EMBEDDER, { log: () => {} });
      // The automatic Meta meme pass is its own switch (ARGUS_MEME_IDEAS), also off by default.
      await generateMemeIdeas(store, brain, { enabled: memeSettings.enabled, config: memeSettings.config });
    };
    const timer = startResearchSchedule({ enabled, intervalMs: TICK_MS, run, log: (l) => lines.push(l) });
    await vi.advanceTimersByTimeAsync(DAY_MS);
    clearInterval(timer);
    return { calls, lines, timer };
  };

  it("with the default switches a full simulated day makes no Brain call, no timer exists, and one line says so", async () => {
    const { calls, lines, timer } = await day(false);
    expect(calls).toEqual([]);
    expect(timer).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("research tick off");
    expect(lines[0]).toContain("ARGUS_RESEARCH_TICK=1");
  });

  it("switched on, it runs at start and every 30 minutes, and the judge runs again with its own caps", async () => {
    const { calls, lines } = await day(true);
    expect(lines).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls).toContain("judge");
  });
});
