import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApiBrain } from "./api-brain.ts";
import { apiSpentUsd, FallbackBrain } from "./api-fallback.ts";
import { ClaudeCodeBrain } from "./brain.ts";
import { Datastore, type NarrativeEmbedder } from "./datastore.ts";
import { judgePendingNarratives as judgePass } from "./judge.ts";
import { proposePendingNarratives } from "./propose.ts";
import type { DimensionScores } from "./rubric.ts";
import { messageBody, startFakeAnthropic, type FakeAnthropic, type FakeReply } from "./testing/fake-anthropic.ts";
import { FAKE_CLAUDE } from "./testing/fake-claude.ts";
import { tempDir } from "./testing/temp.ts";

/**
 * The fallback through the real judge and propose passes: the claude child is the fake in a rate-limit mode, the API is a fake on
 * loopback. What is checked is what the Operator relies on: each run is recorded under the backend that served it, its real dollars
 * land in the API figure and never in Est. usage, the model's answer still goes through the strict parsers, and the cap stops work.
 */
const KEY = "sk-ant-test-0123456789abcdef";
const SKILLS = join(import.meta.dirname, "../../../.claude/skills");
const NOW = new Date("2026-06-14T12:00:00.000Z");
/** These tests make one-Signal Narratives, so the judge's minimum Signal count is lowered to 1 here. */
const judgePendingNarratives = (...a: Parameters<typeof judgePass>) => judgePass(a[0], a[1], a[2], { config: { minSignals: 1 }, ...a[3] });
const CUR: NarrativeEmbedder = { id: "sem-test", dimension: 2 };
const SCORES: DimensionScores = { momentum: 7, novelty: 6, buildability: 8, hook: 5, legitimacy: 9 };
const JUDGE_ANSWER = JSON.stringify({ scores: SCORES, rationale: "clear and buildable" });
const PROPOSE_ANSWER = JSON.stringify({
  name: "Stock Paws",
  ticker: "PAWS",
  tech: "A page that pairs each tokenized stock with a cat verdict",
  whyNow: "Tokenized stocks went live in Europe this week",
  reason: "The Signals cover tokenized stocks; a verdict page gives a reason to return",
  description: "A playful tracker of tokenized stocks.",
  evidence: ["https://a.example/1", "https://b.example/2", "https://c.example/3"],
});
const USAGE = { input_tokens: 2000, output_tokens: 200 };
const REAL_COST = (2000 * 0.1 + 200 * 0.5) / 1e6;

let fake: FakeAnthropic | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function setup(replies: FakeReply[], over: { dailyCapUsd?: number } = {}) {
  fake = await startFakeAnthropic();
  fake.reply(...replies);
  const store = Datastore.open(":memory:");
  const dir = tempDir("argus-fallback-pass-");
  const lines: string[] = [];
  const primary = new ClaudeCodeBrain({
    command: FAKE_CLAUDE,
    cwd: dir,
    env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: KEY, FAKE_CLAUDE_MODE: "ratelimit" },
    passEnv: ["FAKE_CLAUDE_MODE"],
    killGraceMs: 200,
  });
  const api = new ApiBrain({ apiKey: KEY, baseUrl: fake.url, skillsDir: SKILLS, spentUsd: apiSpentUsd(store, () => NOW), dailyCapUsd: over.dailyCapUsd, log: (l) => lines.push(l) });
  const brain = new FallbackBrain({ primary, api, now: () => NOW, log: (l) => lines.push(l) });
  return { store, brain, lines, fake };
}

let n = 0;
function addNarrative(store: Datastore, title: string): number {
  const id = `s:${++n}`;
  store.recordSignals([{ id, sourceId: "rss:a", sourceLabel: "Feed", title, summary: `${title} summary`, url: `https://a.example/${id}`, publishedAt: "2026-06-14T09:00:00.000Z" }]);
  const sig = store.unclusteredSignals(500).find((s) => s.id === id)!;
  return store.createNarrative(sig, [1, 0], NOW.toISOString(), CUR);
}

function addScored(store: Datastore, title: string): number {
  const nid = addNarrative(store, title);
  store.recordScore({ narrativeId: nid, rubricVersion: 1, scores: SCORES, total: 7, rationale: "clear", signalCount: 1, changedMateriallyAt: NOW.toISOString(), createdAt: NOW.toISOString() });
  return nid;
}

const since = new Date(NOW.getTime() - 24 * 3_600_000).toISOString();

describe("the judge pass on the API fallback", () => {
  it("scores the Narrative from the API's answer and records the run as an API run with its real dollars, none of it Est. usage", async () => {
    const { store, brain } = await setup([{ status: 200, body: messageBody(JUDGE_ANSWER, USAGE) }]);
    const id = addNarrative(store, "Tokenized stocks arrive");
    const out = await judgePendingNarratives(store, brain, CUR, { now: NOW, log: () => {} });
    expect(out).toMatchObject({ judged: 1, refused: 0, failed: 0 });
    expect(store.getNarrative(id)!.scores[0]).toMatchObject({ scores: SCORES, rationale: "clear and buildable" });
    const [run] = store.judgeRunsFor(id);
    expect(run).toMatchObject({ task: "judge", backend: "api", model: "claude-haiku-5-5", exitStatus: "success", sessionId: null });
    expect(run!.totalCostUsd).toBeCloseTo(REAL_COST, 10);
    expect(store.apiSpendSince(since).costUsd).toBeCloseTo(REAL_COST, 10);
    expect(store.judgeSpendSince(since)).toMatchObject({ runs: 1, costUsd: 0, chargedUsd: 0 });
  });

  it("the model's answer stays untrusted: prose, extra keys or wrong types are refused and not stored, and the dollars are still counted", async () => {
    const bad = ["Sure! " + JUDGE_ANSWER, JSON.stringify({ scores: SCORES, rationale: "r", extra: 1 }), JSON.stringify({ scores: { ...SCORES, hook: "ten" }, rationale: "r" })];
    const { store, brain } = await setup(bad.map((b) => ({ status: 200, body: messageBody(b, USAGE) }) as FakeReply));
    const ids = bad.map((_, i) => addNarrative(store, `Story ${i}`));
    const out = await judgePendingNarratives(store, brain, CUR, { now: NOW, log: () => {} });
    expect(out).toMatchObject({ judged: 0, refused: 3 });
    for (const id of ids) expect(store.getNarrative(id)!.scores).toHaveLength(0);
    expect(store.apiSpendSince(since).chargedUsd).toBeCloseTo(3 * REAL_COST, 10);
    expect(store.judgeRunsFor(ids[0]!)[0]).toMatchObject({ backend: "api", exitStatus: "invalid-output" });
  });

  it("stops the pass, with the Narrative left queued and nothing sent, once the daily cap is spent", async () => {
    // One answer reports a huge usage ($0.5 of input and output): the cap is then reached and the next Narrative is not sent.
    const huge = { input_tokens: 3_000_000, output_tokens: 400_000 };
    const { store, brain, fake, lines } = await setup([{ status: 200, body: messageBody(JUDGE_ANSWER, huge) }, { status: 200, body: messageBody(JUDGE_ANSWER, USAGE) }]);
    addNarrative(store, "A");
    addNarrative(store, "B");
    const out = await judgePendingNarratives(store, brain, CUR, { now: NOW, log: (l) => lines.push(l) });
    expect(out.stoppedBy).toBe("rate-limited");
    expect(out.judged).toBe(1);
    expect(fake.requests).toHaveLength(1);
    expect(store.apiSpendSince(since).chargedUsd).toBeGreaterThanOrEqual(0.5);
    // The second Narrative was not judged and is still eligible for the next pass.
    const left = store.narrativesToJudge(CUR, since, 10);
    expect(left).toHaveLength(1);
    expect(store.getNarrative(left[0]!.id)!.scores).toHaveLength(0);
    expect(lines.join("\n")).toMatch(/daily cap/);
  });

  it("a failed API call is on the books at its ceiling, in the API figure", async () => {
    const { store, brain } = await setup([{ status: 500, body: { type: "error", error: { type: "api_error", message: "x" } } }]);
    const id = addNarrative(store, "A");
    const out = await judgePendingNarratives(store, brain, CUR, { now: NOW, log: () => {} });
    expect(out).toMatchObject({ judged: 0, failed: 1 });
    const [run] = store.judgeRunsFor(id);
    expect(run).toMatchObject({ backend: "api", exitStatus: "failed" });
    expect(run!.totalCostUsd).toBeGreaterThan(0);
    expect(store.apiSpendSince(since).chargedUsd).toBeCloseTo(run!.totalCostUsd, 10);
  });

  it("nothing in the logs or the stored runs carries the key", async () => {
    const { store, brain, lines } = await setup([{ status: 401, body: { type: "error", error: { type: "authentication_error", message: `bad key ${KEY}` } } }]);
    const id = addNarrative(store, "A");
    const logged: string[] = [];
    await judgePendingNarratives(store, brain, CUR, { now: NOW, log: (l) => logged.push(l) });
    expect(JSON.stringify([logged, lines, store.judgeRunsFor(id)])).not.toContain(KEY);
  });
});

describe("the run that hits the rate limit is booked as an API run before its request goes out", () => {
  it("while the request is in flight its row is an API row charged at its worst case, and a crash then leaves that charge standing", async () => {
    const { store, brain, fake } = await setup([{ status: 200, body: messageBody(JUDGE_ANSWER, USAGE), delayMs: 1200 }]);
    const id = addNarrative(store, "A story");
    const pass = judgePendingNarratives(store, brain, CUR, { now: NOW, log: () => {} });
    for (let i = 0; i < 400 && fake.requests.length < 1; i++) await new Promise((r) => setTimeout(r, 25));
    expect(fake.requests).toHaveLength(1);
    expect(store.judgeRunsFor(id)).toMatchObject([{ backend: "api", model: "claude-haiku-5-5", exitStatus: "in-flight", totalCostUsd: 0 }]);
    expect(store.apiSpendSince(since, { judge: 0.01, propose: 0.02 }).chargedUsd).toBe(0.01);
    // The worker dies here: the sweep finds the row, which is interrupted with no cost known and is still charged at its cap.
    expect(store.interruptStaleBrainRuns(() => 0, new Date(NOW.getTime() + 3_600_000))).toBe(1);
    expect(store.judgeRunsFor(id)).toMatchObject([{ backend: "api", exitStatus: "interrupted", totalCostUsd: 0 }]);
    expect(store.apiSpendSince(since, { judge: 0.01, propose: 0.02 }).chargedUsd).toBe(0.01);
    await pass;
  });

  it("two passes that overlap cannot together pass the cap: the second sees the first's in-flight run", async () => {
    // $0.025 is left of the $0.5 cap: room for one call (its row at $0.01 or $0.02 plus its ceiling) but not for two.
    const { store, brain, fake } = await setup([{ status: 200, body: messageBody(JUDGE_ANSWER, USAGE), delayMs: 1000 }]);
    const preload = store.startBrainRun({ proposalId: 0, task: "judge", backend: "api", model: "claude-haiku-5-5" }, NOW);
    store.finishBrainRun(preload, { sessionId: null, totalCostUsd: 0.475, exitStatus: "success" });
    addNarrative(store, "To judge");
    addScored(store, "To propose");
    const [judged, proposed] = await Promise.all([
      judgePendingNarratives(store, brain, CUR, { now: NOW, log: () => {} }),
      proposePendingNarratives(store, brain, CUR, { now: NOW, log: () => {} }),
    ]);
    expect(fake.requests).toHaveLength(1);
    expect([judged.stoppedBy, proposed.stoppedBy].filter((s) => s === "rate-limited")).toHaveLength(1);
    expect(store.apiSpendSince(since, { judge: 0.01, propose: 0.02 }).chargedUsd).toBeLessThanOrEqual(0.5);
  });
});

describe("the propose pass on the API fallback", () => {
  it("creates the Proposal from the API's answer; its dollars are the Proposal's API spend, not its Est. usage", async () => {
    const { store, brain } = await setup([{ status: 200, body: messageBody(PROPOSE_ANSWER, USAGE) }]);
    const nid = addScored(store, "Tokenized stocks arrive");
    const created: number[] = [];
    const out = await proposePendingNarratives(store, brain, CUR, { now: NOW, log: () => {}, onCreated: (p) => void created.push(p.id) });
    expect(out).toMatchObject({ proposed: 1, refused: 0, failed: 0 });
    const p = store.getProposal(created[0]!)!;
    expect(p).toMatchObject({ name: "Stock Paws", ticker: "PAWS", narrativeId: nid, agentCostUsd: 0 });
    expect(p.apiCostUsd).toBeCloseTo(REAL_COST, 10);
    expect(store.brainRunsFor(p.id)).toMatchObject([{ task: "propose", backend: "api", model: "claude-haiku-5-5", exitStatus: "success" }]);
    expect(store.researchSpendSince(since)).toMatchObject({ costUsd: 0, chargedUsd: 0 });
  });

  it("the strict propose parser still refuses what does not fit: a bad ticker, a missing link, extra keys", async () => {
    const answers = [
      { ...JSON.parse(PROPOSE_ANSWER), ticker: "not a ticker" },
      { ...JSON.parse(PROPOSE_ANSWER), evidence: ["https://a.example/1"] },
      { ...JSON.parse(PROPOSE_ANSWER), price: "$1" },
    ];
    const { store, brain } = await setup(answers.map((a) => ({ status: 200, body: messageBody(JSON.stringify(a), USAGE) }) as FakeReply));
    for (let i = 0; i < 3; i++) addScored(store, `Story ${i}`);
    const out = await proposePendingNarratives(store, brain, CUR, { now: NOW, log: () => {}, config: { maxPerPass: 5 } });
    expect(out).toMatchObject({ proposed: 0, refused: 3 });
    expect(store.listProposals()).toHaveLength(0);
  });
});
