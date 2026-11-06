import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBrain, resolveRouting } from "./brain.ts";
import { Datastore, type NarrativeEmbedder, type Proposal } from "./datastore.ts";
import { expireStaleProposals } from "./expiry.ts";
import { proposePendingNarratives, type ProposeConfig } from "./propose.ts";
import type { ResearchBudgetConfig } from "./research-budget.ts";
import type { DimensionScores } from "./rubric.ts";
import { FAKE_CLAUDE } from "./testing/fake-claude.ts";
import { tempDir } from "./testing/temp.ts";

const NOW = new Date("2026-06-14T12:00:00.000Z");
const CUR: NarrativeEmbedder = { id: "sem-test", dimension: 2 };
const SCORES: DimensionScores = { momentum: 7, novelty: 6, buildability: 8, hook: 5, legitimacy: 9 };
const ANSWER = JSON.stringify({
  name: "Stock Paws",
  ticker: "PAWS",
  tech: "A page that pairs each tokenized stock with a cat verdict",
  whyNow: "Tokenized stocks went live in Europe this week",
  description: "A playful tracker of tokenized stocks.",
  evidence: ["https://a.example/1", "https://b.example/2", "https://c.example/3"],
});
const minutes = (m: number) => new Date(NOW.getTime() + m * 60_000);
const hours = (h: number) => minutes(h * 60);

function setup(env: Record<string, string> = {}, brainOpts: ConstructorParameters<typeof ClaudeCodeBrain>[0] = {}) {
  const store = Datastore.open(":memory:");
  const dir = tempDir("argus-propose-");
  const log = join(dir, "calls.jsonl");
  const passEnv = ["FAKE_CLAUDE_MODE", "FAKE_CLAUDE_RESULT", "FAKE_CLAUDE_LOG", "FAKE_CLAUDE_SEQUENCE"];
  const brain = new ClaudeCodeBrain({
    killGraceMs: 200,
    command: FAKE_CLAUDE,
    env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "sk-must-not-leak", FAKE_CLAUDE_MODE: "success", FAKE_CLAUDE_RESULT: ANSWER, FAKE_CLAUDE_LOG: log, ...env },
    passEnv,
    ...brainOpts,
  });
  const lines: string[] = [];
  const created: Proposal[] = [];
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> }) : []);
  const pass = (
    config: Partial<ProposeConfig> = {},
    over: { now?: Date; signal?: AbortSignal; research?: ResearchBudgetConfig; onCreated?: (p: Proposal) => void; embedder?: NarrativeEmbedder } = {},
  ) =>
    proposePendingNarratives(store, brain, over.embedder ?? CUR, {
      now: over.now ?? NOW,
      config,
      log: (l) => lines.push(l),
      signal: over.signal,
      research: over.research,
      onCreated: over.onCreated ?? ((p) => created.push(p)),
    });
  return { store, brain, pass, calls, lines, created };
}

let n = 0;
/** A scored Narrative of the current embedder, last changed at `at`. Returns its id. */
function addScored(store: Datastore, title: string, opts: { scores?: Partial<DimensionScores>; at?: Date; scoredAt?: Date; embedder?: NarrativeEmbedder } = {}): number {
  const id = `s:${++n}`;
  store.recordSignals([
    { id, sourceId: "rss:a", sourceLabel: "Feed", title, summary: `${title} summary`, url: `https://a.example/${id}`, publishedAt: "2026-06-14T09:00:00.000Z" },
  ]);
  const sig = store.unclusteredSignals(500).find((s) => s.id === id)!;
  const nid = store.createNarrative(sig, [1, 0], (opts.at ?? NOW).toISOString(), opts.embedder ?? CUR);
  rescore(store, nid, opts.scores, opts.scoredAt ?? NOW);
  return nid;
}

function rescore(store: Datastore, nid: number, over: Partial<DimensionScores> = {}, at = NOW): number {
  const scores = { ...SCORES, ...over };
  const total = Object.values(scores).reduce((a, b) => a + b, 0) / 5;
  return store.recordScore({ narrativeId: nid, rubricVersion: 1, scores, total, rationale: "clear", signalCount: 1, changedMateriallyAt: NOW.toISOString(), createdAt: at.toISOString() });
}

const wide = { maxPerPass: 50, maxRunsPerDay: 500 };

describe("the propose pass", () => {
  it("turns a Narrative that passes the gate into a `new` Proposal made by the system, linked to its Narrative and Score", async () => {
    const { store, pass, created } = setup();
    const nid = addScored(store, "Tokenized stocks arrive", { at: hours(-3) });
    const out = await pass();
    expect(out).toMatchObject({ proposed: 1, refused: 0, failed: 0 });
    const p = store.listProposals()[0]!;
    expect(p).toMatchObject({
      status: "new",
      name: "Stock Paws",
      ticker: "PAWS",
      techOneLiner: "A page that pairs each tokenized stock with a cat verdict",
      whyNow: "Tokenized stocks went live in Europe this week",
      description: "A playful tracker of tokenized stocks.",
      evidenceLinks: ["https://a.example/1", "https://b.example/2", "https://c.example/3"],
      narrativeSummary: "Tokenized stocks arrive\nTokenized stocks arrive summary",
      narrativeId: nid,
      scoreId: store.latestScore(nid)!.id,
      narrativeCreatedAt: hours(-3).toISOString(),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(store.historyFor(p.id)).toMatchObject([{ from: null, to: "new", actor: "system" }]);
    expect(created.map((c) => c.id)).toEqual([p.id]);
  });

  it("records the run first and its usage after, against the Proposal it produced", async () => {
    const { store, pass } = setup();
    addScored(store, "A story");
    await pass();
    const p = store.listProposals()[0]!;
    expect(store.brainRunsFor(p.id)).toMatchObject([{ proposalId: p.id, narrativeId: 1, task: "propose", backend: "claude-code", model: "sonnet", exitStatus: "success", totalCostUsd: 0.0123 }]);
    expect(p.agentCostUsd).toBe(0.0123);
    expect(p.brainRunInFlightSince).toBeNull();
  });

  it("runs on sonnet with the web tools, isolation flags, a $1 budget, on the subscription, and the propose skill resolves", async () => {
    const { store, pass, calls } = setup({}, { skillsDir: join(import.meta.dirname, "../../../.claude/skills") });
    addScored(store, "A story");
    await pass();
    const [{ argv, env }] = calls() as [{ argv: string[]; env: Record<string, string> }];
    expect(argv[1]).toMatch(/^\/propose\n\nPropose one token/);
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("WebSearch,WebFetch");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("WebSearch,WebFetch");
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("1");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("project");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
  });

  it("an expiry clock that counts from updated_at closes the Proposal 48 hours after it was made", async () => {
    const { store, pass } = setup();
    addScored(store, "A story");
    await pass();
    const p = store.listProposals()[0]!;
    expect(p.expiresAt).toBe(hours(48).toISOString());
    expect(expireStaleProposals(store, hours(47))).toBe(0);
    expect(expireStaleProposals(store, hours(49))).toBe(1);
    expect(store.getProposal(p.id)!.status).toBe("closed");
  });

  it("proposes the best-scored Narratives first", async () => {
    const { store, pass, calls } = setup();
    addScored(store, "Middling story", { scores: { momentum: 5 } });
    addScored(store, "Great story", { scores: { momentum: 10, novelty: 10 } });
    await pass({ maxPerPass: 1 });
    expect(calls()[0]!.argv[1]).toContain("Great story");
  });
});

describe("the buildability gate", () => {
  it("never proposes a Narrative below the Rubric's gate, and spawns nothing for it", async () => {
    const { store, pass, calls } = setup();
    addScored(store, "Needs a wallet", { scores: { buildability: 4, momentum: 10, novelty: 10, hook: 10, legitimacy: 10 } });
    expect(await pass()).toMatchObject({ proposed: 0 });
    expect(calls()).toHaveLength(0);
    expect(store.listProposals()).toEqual([]);
  });

  it("takes the gate from the Rubric as it is now: the default 5 passes at exactly 5, an edited 6 does not", async () => {
    const { store, pass, calls } = setup();
    addScored(store, "Borderline", { scores: { buildability: 5 } });
    const r = store.getRubric();
    store.saveRubric({ baseVersion: r.version, gateMinScore: 6, dimensions: r.dimensions });
    expect(await pass()).toMatchObject({ proposed: 0 });
    expect(calls()).toHaveLength(0);
    const r2 = store.getRubric();
    store.saveRubric({ baseVersion: r2.version, gateMinScore: 5, dimensions: r2.dimensions });
    expect(await pass({}, { now: minutes(30) })).toMatchObject({ proposed: 1 });
  });

  it("a Narrative re-scored below the gate while the model ran gets no Proposal", async () => {
    const { store, brain, pass } = setup();
    const nid = addScored(store, "A story");
    const run = brain.run.bind(brain);
    brain.run = (async (...args: Parameters<typeof run>) => {
      const out = await run(...args);
      rescore(store, nid, { buildability: 1 }, minutes(1));
      return out;
    }) as typeof brain.run;
    expect(await pass({}, { now: minutes(2) })).toMatchObject({ proposed: 0, withdrawn: 1 });
    expect(store.listProposals()).toEqual([]);
    expect(store.brainRunsFor(0)).toMatchObject([{ task: "propose", exitStatus: "success" }]); // the spend stays recorded
  });
});

describe("each Narrative at most once", () => {
  it("does not propose a Narrative again on the next pass", async () => {
    const { store, pass, calls } = setup();
    addScored(store, "A story");
    await pass();
    await pass({}, { now: minutes(30) });
    await pass({}, { now: hours(30) });
    expect(calls()).toHaveLength(1);
    expect(store.listProposals()).toHaveLength(1);
  });

  it("not even after the Operator dismissed its Proposal, or after the Narrative is re-scored", async () => {
    const { store, pass, calls } = setup();
    const nid = addScored(store, "A story");
    await pass();
    store.transition(store.listProposals()[0]!.id, "dismissed", "operator", "no thanks");
    rescore(store, nid, {}, minutes(10));
    await pass({}, { now: minutes(40) });
    expect(calls()).toHaveLength(1);
    expect(store.listProposals()).toHaveLength(1);
  });
});

describe("the daily cap of 10 new Proposals", () => {
  it("stops at 10 in a rolling day without spawning for the 11th, and resumes when the day has passed", async () => {
    const { store, pass, calls, lines } = setup();
    for (let i = 0; i < 12; i++) addScored(store, `Story ${i}`);
    expect(await pass(wide)).toMatchObject({ proposed: 10, stoppedBy: "proposal-cap" });
    expect(calls()).toHaveLength(10);
    expect(store.listProposals()).toHaveLength(10);
    expect(lines.join("\n")).toMatch(/daily cap of 10 new Proposals/);
    expect(await pass(wide, { now: hours(5) })).toMatchObject({ proposed: 0, stoppedBy: "proposal-cap" });
    expect(calls()).toHaveLength(10);
    expect(await pass(wide, { now: hours(25) })).toMatchObject({ proposed: 2 });
    expect(store.listProposals()).toHaveLength(12);
  });

  it("config can lower the cap but not raise it above 10", async () => {
    const low = setup();
    for (let i = 0; i < 4; i++) addScored(low.store, `Story ${i}`);
    expect(await low.pass({ ...wide, maxNewPerDay: 2 })).toMatchObject({ proposed: 2, stoppedBy: "proposal-cap" });
    const high = setup();
    for (let i = 0; i < 12; i++) addScored(high.store, `Story ${i}`);
    expect(await high.pass({ ...wide, maxNewPerDay: 500 })).toMatchObject({ proposed: 10, stoppedBy: "proposal-cap" });
    expect(high.store.listProposals()).toHaveLength(10);
  });

  it("hand-entered Proposals do not use up the research cap", async () => {
    const { store, pass } = setup();
    for (let i = 0; i < 10; i++) store.createProposal({ narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: `Hand ${i}`, ticker: "HAND", description: "d", evidenceLinks: [] });
    addScored(store, "A story");
    expect(await pass()).toMatchObject({ proposed: 1 });
  });
});

describe("untrusted output: refused, logged, never coerced", () => {
  const bad: Array<[string, string]> = [
    ["prose", "Sure! I propose Stock Paws."],
    ["a code fence", "```json\n" + ANSWER + "\n```"],
    ["a string where text belongs", JSON.stringify({ ...JSON.parse(ANSWER), name: 7 })],
    ["a lower-case ticker", JSON.stringify({ ...JSON.parse(ANSWER), ticker: "paws" })],
    ["too few links", JSON.stringify({ ...JSON.parse(ANSWER), evidence: ["https://a.example/1"] })],
    ["a javascript: link", JSON.stringify({ ...JSON.parse(ANSWER), evidence: ["https://a.example/1", "https://b.example/2", "javascript:alert(1)"] })],
    ["an extra key", JSON.stringify({ ...JSON.parse(ANSWER), status: "approved" })],
  ];

  for (const [label, answer] of bad) {
    it(`refuses ${label}: no Proposal, the run is recorded as invalid-output with its cost`, async () => {
      const { store, pass, lines } = setup({ FAKE_CLAUDE_RESULT: answer });
      addScored(store, "A story");
      const out = await pass();
      expect(out).toMatchObject({ proposed: 0, refused: 1 });
      expect(store.listProposals()).toEqual([]);
      expect(store.brainRunsFor(0)).toMatchObject([{ task: "propose", exitStatus: "invalid-output", totalCostUsd: 0.0123 }]);
      expect(lines.join("\n")).toMatch(/narrative \d+ refused: .*Output not stored/);
    });
  }

  it("does not try a refused Narrative again until it is scored again", async () => {
    const { store, pass, calls } = setup({ FAKE_CLAUDE_RESULT: "nope" });
    const nid = addScored(store, "A story");
    await pass();
    await pass({}, { now: minutes(30) });
    expect(calls()).toHaveLength(1);
    rescore(store, nid, {}, minutes(40));
    await pass({}, { now: minutes(60) });
    expect(calls()).toHaveLength(2);
  });

  it("a refused answer is not a transient failure: five refusals in a row do not end the pass", async () => {
    const { store, pass, calls } = setup({ FAKE_CLAUDE_RESULT: "garbage" });
    for (let i = 0; i < 5; i++) addScored(store, `Story ${i}`);
    const out = await pass(wide);
    expect(out).toMatchObject({ refused: 5, failed: 0 });
    expect(out.stoppedBy).toBeUndefined();
    expect(calls()).toHaveLength(5);
  });
});

describe("failures", () => {
  it("a run over its budget is recorded with its cost and parked until the Narrative is scored again", async () => {
    const { store, pass, calls } = setup({ FAKE_CLAUDE_MODE: "budget" });
    addScored(store, "A story");
    expect(await pass()).toMatchObject({ proposed: 0, failed: 1 });
    await pass({}, { now: minutes(30) });
    expect(calls()).toHaveLength(1);
    expect(store.brainRunsFor(0)).toMatchObject([{ exitStatus: "budget-exceeded" }]);
    expect(store.brainRunsFor(0)[0]!.totalCostUsd).toBeGreaterThan(0);
  });

  it("a transient failure leaves the Narrative eligible; it recovers once claude does", async () => {
    const { store, pass } = setup({ FAKE_CLAUDE_SEQUENCE: JSON.stringify([{ FAKE_CLAUDE_MODE: "failure" }, {}]) });
    addScored(store, "A story");
    expect(await pass()).toMatchObject({ proposed: 0, failed: 1 });
    expect(await pass({}, { now: minutes(30) })).toMatchObject({ proposed: 1, failed: 0 });
  });

  it("a claude that cannot be started at all is transient too", async () => {
    const { store, pass } = setup({}, { command: join(tempDir("argus-nobin-"), "no-such-claude") });
    addScored(store, "A story");
    expect(await pass()).toMatchObject({ proposed: 0, failed: 1 });
    expect(store.brainRunsFor(0)).toMatchObject([{ exitStatus: "failed" }]);
  });

  it("consecutive transient failures end the pass early, logged once", async () => {
    const { store, pass, calls, lines } = setup({ FAKE_CLAUDE_MODE: "failure" });
    for (let i = 0; i < 6; i++) addScored(store, `Story ${i}`);
    expect(await pass(wide)).toMatchObject({ proposed: 0, failed: 3, stoppedBy: "backoff" });
    expect(calls()).toHaveLength(3);
    expect(lines.filter((l) => l.includes("consecutive failures"))).toHaveLength(1);
  });

  it("a rate-limited run stops the pass at once", async () => {
    const { store, pass, calls } = setup({ FAKE_CLAUDE_MODE: "ratelimit" });
    addScored(store, "One");
    addScored(store, "Two");
    expect(await pass()).toMatchObject({ proposed: 0, stoppedBy: "rate-limited" });
    expect(calls()).toHaveLength(1);
  });

  it("an aborted pass spawns nothing", async () => {
    const { store, pass, calls } = setup();
    addScored(store, "A story");
    const ac = new AbortController();
    ac.abort();
    expect(await pass({}, { signal: ac.signal })).toMatchObject({ proposed: 0, stoppedBy: "interrupted" });
    expect(calls()).toHaveLength(0);
    expect(store.brainRunsFor(0)).toEqual([]);
  });

  it("skips a Narrative that already has a propose run in flight", async () => {
    const { store, pass, calls } = setup();
    const nid = addScored(store, "A story");
    store.startBrainRun({ proposalId: 0, narrativeId: nid, task: "propose", backend: "claude-code", model: "sonnet" });
    await pass();
    expect(calls()).toHaveLength(0);
  });
});

describe("caps", () => {
  it("proposes at most maxPerPass Narratives per pass and the rest on the next", async () => {
    const { store, pass } = setup();
    for (let i = 0; i < 5; i++) addScored(store, `Story ${i}`);
    expect((await pass({ maxPerPass: 2 })).proposed).toBe(2);
    expect((await pass({ maxPerPass: 2 }, { now: minutes(30) })).proposed).toBe(2);
    expect((await pass({ maxPerPass: 2 }, { now: minutes(60) })).proposed).toBe(1);
  });

  it("stops at the daily run count, refused and failed runs included", async () => {
    const { store, pass, calls } = setup({ FAKE_CLAUDE_RESULT: "garbage" });
    for (let i = 0; i < 5; i++) addScored(store, `Story ${i}`);
    expect(await pass({ maxPerPass: 50, maxRunsPerDay: 2 })).toMatchObject({ refused: 2, stoppedBy: "daily-cap" });
    expect(calls()).toHaveLength(2);
  });

  it("a timed-out run prints no cost but is charged at the propose route's cap, which then stops the pass", async () => {
    const { store, pass, calls } = setup({ FAKE_CLAUDE_MODE: "hang" }, { routing: resolveRouting({ propose: { timeoutMs: 300, maxBudgetUsd: 0.5 } }) });
    for (let i = 0; i < 4; i++) addScored(store, `Story ${i}`);
    expect(await pass(wide, { research: { dailyQuotaUsd: 1, share: 0.5 } })).toMatchObject({ proposed: 0, failed: 1, stoppedBy: "research-cap" });
    expect(calls()).toHaveLength(1);
    expect(store.brainRunsFor(0)).toMatchObject([{ exitStatus: "timed-out", totalCostUsd: 0 }]); // the reported cost stays 0
    expect(await pass(wide, { now: minutes(30), research: { dailyQuotaUsd: 1, share: 0.5 } })).toMatchObject({ stoppedBy: "research-cap" });
    expect(calls()).toHaveLength(1);
  });

  it("stops when the shared research budget is used up, counting judge spend, and waits for the next day", async () => {
    const { store, pass, calls, lines } = setup();
    for (let i = 0; i < 4; i++) addScored(store, `Story ${i}`);
    const judge = store.startBrainRun({ proposalId: 0, narrativeId: 1, task: "judge", backend: "claude-code", model: "haiku" }, minutes(-30));
    store.finishBrainRun(judge, { sessionId: null, totalCostUsd: 0.03, exitStatus: "success" });
    const budget: ResearchBudgetConfig = { dailyQuotaUsd: 0.1, share: 0.5 }; // $0.05
    // one propose run (0.0123) brings the day to 0.0423; a second to 0.0546, over the budget
    expect(await pass(wide, { research: budget })).toMatchObject({ proposed: 2, stoppedBy: "research-cap" });
    expect(calls()).toHaveLength(2);
    expect(lines.join("\n")).toMatch(/research budget reached/);
    expect(await pass(wide, { now: minutes(30), research: budget })).toMatchObject({ proposed: 0, stoppedBy: "research-cap" });
    expect(calls()).toHaveLength(2);
    expect(await pass(wide, { now: hours(25), research: budget })).toMatchObject({ proposed: 2 });
  });
});

describe("the Proposal-created hook", () => {
  it("is called once per new Proposal, after it exists, with the stored Proposal", async () => {
    const { store, pass } = setup();
    addScored(store, "One");
    addScored(store, "Two");
    const seen: Array<{ id: number; stored: boolean }> = [];
    await pass(wide, { onCreated: (p) => seen.push({ id: p.id, stored: store.getProposal(p.id)?.status === "new" }) });
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.stored)).toBe(true);
  });

  it("a hook that returns a rejecting promise is logged, never an unhandled rejection, and never undoes the Proposal", async () => {
    const { store, pass, lines } = setup();
    addScored(store, "One");
    addScored(store, "Two");
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const out = await pass(wide, { onCreated: async () => Promise.reject(new Error("telegram is slow and down")) });
      await new Promise((r) => setTimeout(r, 50));
      expect(out).toMatchObject({ proposed: 2 });
      expect(store.listProposals()).toHaveLength(2);
      expect(lines.filter((l) => l.includes("new-Proposal hook failed: telegram is slow and down"))).toHaveLength(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("an async hook is not awaited: a slow notifier does not hold the pass up", async () => {
    const { store, pass } = setup();
    addScored(store, "One");
    let finished = false;
    const out = await pass(wide, { onCreated: () => new Promise<void>((r) => setTimeout(() => ((finished = true), r()), 300)) });
    expect(out.proposed).toBe(1);
    expect(finished).toBe(false);
  });

  it("a hook that throws never undoes the Proposal or stops the pass", async () => {
    const { store, pass, lines } = setup();
    addScored(store, "One");
    addScored(store, "Two");
    const out = await pass(wide, {
      onCreated: () => {
        throw new Error("telegram is down");
      },
    });
    expect(out).toMatchObject({ proposed: 2 });
    expect(store.listProposals()).toHaveLength(2);
    expect(lines.join("\n")).toMatch(/new-Proposal hook failed: telegram is down/);
  });
});

describe("dry run", () => {
  it("logs the command, spawns nothing, and leaves no run row or Proposal", async () => {
    const { store, pass, calls, lines } = setup({}, { dryRun: true, log: () => {} });
    addScored(store, "A story");
    addScored(store, "Another story");
    expect(await pass()).toMatchObject({ proposed: 0, stoppedBy: "dry-run" });
    expect(calls()).toHaveLength(0);
    expect(store.brainRunsFor(0)).toEqual([]);
    expect(store.listProposals()).toEqual([]);
    expect(lines.join("\n")).toContain("dry-run");
  });
});

describe("only the current embedder's recent Narratives", () => {
  it("ignores another embedder's Narratives and those with no Signal in the window", async () => {
    const { store, pass, calls } = setup();
    addScored(store, "Lexical", { embedder: { id: "hashing-v1", dimension: 2 } });
    addScored(store, "Old", { at: hours(-100) });
    expect(await pass()).toMatchObject({ proposed: 0 });
    expect(calls()).toHaveLength(0);
  });
});
