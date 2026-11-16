import { describe, expect, it, vi } from "vitest";
import { Datastore, type NarrativeEmbedder } from "./datastore.ts";
import type { Brain } from "./brain.ts";
import { DEFAULT_JUDGE_CONFIG, judgePendingNarratives } from "./judge.ts";

const NOW = new Date("2026-06-14T12:00:00.000Z");
const CUR: NarrativeEmbedder = { id: "sem-test", dimension: 2 };
const SINCE = new Date(NOW.getTime() - 72 * 3_600_000).toISOString();

let n = 0;
function addNarrative(store: Datastore, title: string, sourceId: string): number {
  const id = `s:${++n}`;
  store.recordSignals([{ id, sourceId, sourceLabel: sourceId, title, summary: `${title} summary`, url: `https://a.example/${id}`, publishedAt: "2026-06-14T09:00:00.000Z" }]);
  const sig = store.unclusteredSignals(500).find((s) => s.id === id)!;
  return store.createNarrative(sig, [1, 0], NOW.toISOString(), CUR);
}
function addSignal(store: Datastore, narrativeId: number, sourceId: string): void {
  const id = `s:${++n}`;
  store.recordSignals([{ id, sourceId, sourceLabel: sourceId, title: `More ${id}`, summary: "", url: `https://a.example/${id}`, publishedAt: NOW.toISOString() }]);
  const sig = store.unclusteredSignals(500).find((s) => s.id === id)!;
  store.joinNarrative(narrativeId, sig, [1, 0], NOW.toISOString());
}
const score = (store: Datastore, narrativeId: number) =>
  store.recordScore({
    narrativeId,
    rubricVersion: 1,
    scores: { momentum: 7, novelty: 6, buildability: 9, hook: 5, legitimacy: 9 },
    total: 7,
    rationale: "r",
    signalCount: 2,
    changedMateriallyAt: store.getNarrative(narrativeId)!.changedMateriallyAt,
    createdAt: NOW.toISOString(),
  });
const judgeIds = (store: Datastore) => store.narrativesToJudge(CUR, SINCE, 50, Infinity, 1).map((x) => x.id).sort();
const proposeIds = (store: Datastore) => store.narrativesToPropose(CUR, SINCE, 0, 50).map((x) => x.narrative.id).sort();

/** One of each: news-only, Trends-only, GitHub-only, mixed (17 news + 1 market) and market-only. */
function fixture() {
  const store = Datastore.open(":memory:");
  const news = addNarrative(store, "News story", "rss:a");
  addSignal(store, news, "rss:b");
  const trends = addNarrative(store, "Trend", "trends:google");
  const gh = addNarrative(store, "Repo", "github:trending");
  const mixed = addNarrative(store, "Mixed story", "rss:a");
  for (let i = 0; i < 16; i++) addSignal(store, mixed, "rss:b");
  addSignal(store, mixed, "pumpportal:events");
  const market = addNarrative(store, "Market with a headline", "dexscreener:trending");
  addSignal(store, market, "rss:a"); // a market Signal alone is not eligible (ADR 0011 amendment of 2026-11-16)
  const marketOnly = addNarrative(store, "Market only", "dexscreener:trending");
  return { store, news, trends, gh, mixed, market, marketOnly };
}

describe("context-only Narratives are neither judged nor proposed (ticket 24)", () => {
  it("a judge pass over only context-only Narratives starts no run and uses no cap", async () => {
    const store = Datastore.open(":memory:");
    addNarrative(store, "News story", "rss:a");
    const calls: string[] = [];
    const brain: Brain = {
      routeFor: () => ({ backend: "claude-code", model: "m" }),
      run: async (task) => {
        calls.push(task);
        throw new Error("a context-only Narrative must not reach the brain");
      },
    };
    const out = await judgePendingNarratives(store, brain, CUR, { now: NOW, config: { minSignals: 1 }, log: () => {} });
    expect(out).toMatchObject({ judged: 0, refused: 0, failed: 0 });
    expect(calls).toEqual([]);
    expect(store.recentBrainRuns()).toEqual([]);
  });

  it("a failed world-context read does not fail the judge pass: it logs and judges without the block", async () => {
    const store = Datastore.open(":memory:");
    addSignal(store, addNarrative(store, "Market with a headline", "dexscreener:trending"), "rss:a");
    vi.spyOn(store, "contextNarratives").mockImplementation(() => {
      throw new Error("db locked");
    });
    const prompts: string[] = [];
    const brain: Brain = {
      routeFor: () => ({ backend: "claude-code", model: "m" }),
      run: async (_task, input) => {
        prompts.push((input as { prompt: string }).prompt);
        throw new Error("stop here");
      },
    };
    const lines: string[] = [];
    const out = await judgePendingNarratives(store, brain, CUR, { now: NOW, config: { minSignals: 1 }, log: (l) => lines.push(l) });
    expect(prompts).toHaveLength(1);
    expect(out.failed).toBe(1);
    expect(lines.some((l) => l.includes("world context not read") && l.includes("db locked"))).toBe(true);
  });

  it("a Narrative whose Signals are all context is not judged, nor one of market Signals only; a mixed one and a market one with a headline are", () => {
    const { store, mixed, market, marketOnly } = fixture();
    expect(judgeIds(store)).not.toContain(marketOnly);
    expect(judgeIds(store)).toEqual([mixed, market].sort());
  });

  it("the default judge minimum does not bring a context-only Narrative back", () => {
    const { store, mixed, market } = fixture();
    expect(store.narrativesToJudge(CUR, SINCE, 50, Infinity, DEFAULT_JUDGE_CONFIG.minSignals).map((x) => x.id).sort()).toEqual([mixed, market].sort());
  });

  it("propose excludes a scored context-only Narrative and includes the mixed one; old Scores stay", () => {
    const { store, news, mixed, market, marketOnly } = fixture();
    for (const id of [news, mixed, market]) score(store, id);
    score(store, marketOnly);
    expect(proposeIds(store)).toEqual([mixed, market].sort());
    expect(store.latestScore(news)).toBeDefined();
  });

  it("contextNarratives is unchanged by kind: it lists a context-only Narrative of either kind, and no Narrative that holds a market Signal", () => {
    const { store } = fixture();
    const id = `s:${++n}`;
    store.recordSignals([{ id, sourceId: "rss:a", sourceLabel: "rss:a", title: "Quiet launchpad", summary: "", url: `https://a.example/${id}`, publishedAt: NOW.toISOString() }]);
    const sig = store.unclusteredSignals(500).find((s) => s.id === id)!;
    store.createNarrative(sig, [], NOW.toISOString(), CUR, { title: "Quiet launchpad", keys: [] });
    const titles = store.contextNarratives(CUR, SINCE, 50).map((x) => x.title).sort();
    expect(titles).toEqual(["Quiet launchpad", "Repo", "News story", "Trend"].sort());
  });

  it("a context-only Narrative that gains a market Signal is selected on the next pass", () => {
    const { store, news } = fixture();
    expect(judgeIds(store)).not.toContain(news);
    addSignal(store, news, "pumpportal:events");
    expect(judgeIds(store)).toContain(news);
    score(store, news);
    expect(proposeIds(store)).toContain(news);
  });
});
