import { existsSync } from "node:fs";
import { Datastore, type MetaSnapshot, type NewMemeTrio } from "@argus/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/proposals/:id/verdict and the reads that carry the Idea verdict (War Room ticket 21): the real route handlers over an in-memory
 * store, called with the exact body the page sends. Only Nitro's auto-imported globals are stubbed. The War Room writes the verdict row and
 * nothing else; every refusal leaves nothing stored.
 */
type Ev = { params?: Record<string, string>; body?: unknown; query?: Record<string, string> };
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("getRouterParam", (e: Ev, k: string) => e.params?.[k]);
vi.stubGlobal("readBody", async (e: Ev) => e.body);
vi.stubGlobal("getQuery", (e?: Ev) => e?.query ?? {});
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);
vi.stubGlobal("useDataDir", () => "/argus/data");
vi.stubGlobal("useBuildRoot", () => "/builds/code");

const post = (await import("../api/proposals/[id]/verdict.post.ts")).default as unknown as (e: Ev) => Promise<Record<string, unknown>>;
const list = (await import("../api/proposals/index.get.ts")).default as unknown as (e?: Ev) => Array<{ id: number; kind: string; ideaVerdict: string | null }>;
const one = (await import("../api/proposals/[id].get.ts")).default as unknown as (e: Ev) => { ideaVerdicts: Array<Record<string, unknown>> };
const narrativeOne = (await import("../api/narratives/[id].get.ts")).default as unknown as (e: Ev) => { proposals: Array<Record<string, unknown>> };

const NOW = Date.parse("2026-11-22T10:00:00.000Z");
const snapshot: MetaSnapshot = {
  version: 1,
  capturedAt: new Date(NOW).toISOString(),
  meta: { key: "jensen", label: "Jensen", rank: 2, firstSeenAt: new Date(NOW - 3_600_000).toISOString(), counts: { "6h": { tokens: 1, creators: 1, migrations: 0, migrationsAfter60s: 0 }, "24h": { tokens: 2, creators: 2, migrations: 0, migrationsAfter60s: 0 } }, topTokens: [] },
  run: { id: 1, computedAt: new Date(NOW).toISOString(), window: "24h", baseMigrationRate: 0.03, coverage: null },
  hot: { reason: "r", raisedAt: new Date(NOW).toISOString(), rank: 2, creators: 2 },
  roomLeft: { passed: true, text: "room" },
  tokens: [],
  news: [],
};
const trio = (): NewMemeTrio => ({
  metaKey: "jensen",
  metaLabel: "Jensen",
  snapshot,
  reason: "r",
  summary: "s",
  evidenceLinks: [],
  playbookVersion: "pb-3",
  ideas: ["Alpha", "Bravo", "Charlie"].map((n, i) => ({ name: `Idea ${n}`, ticker: ["AAA", "BBB", "CCC"][i]!, angle: `Angle ${n}`, difference: "d", description: "p", hook: "gm", imageIdea: "i", riskLabels: [] })),
});
let memeId: number;
let techId: number;
const send = (body: unknown, id: string = String(memeId)) => post({ params: { id }, body });
const status = async (p: Promise<unknown>) => ((await p.then(() => ({ statusCode: 200 }), (e: { statusCode: number }) => e)) as { statusCode: number }).statusCode;
const message = async (p: Promise<unknown>) => ((await p.then(() => ({ statusMessage: "" }), (e: { statusMessage: string }) => e)) as { statusMessage: string }).statusMessage;
const stored = () => [memeId, memeId + 1, memeId + 2, techId].flatMap((id) => store.proposalVerdictsFor(id));

beforeEach(() => {
  store = Datastore.open(":memory:");
  memeId = store.createMemeProposals(trio(), { now: new Date(NOW) })[0]!.id;
  techId = store.createProposal({ narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: "Cat", ticker: "CAT", description: "d", evidenceLinks: [] }).id;
});

describe("POST /api/proposals/:id/verdict", () => {
  it("a one-click body returns the stored row, with kind and Playbook version from the store", async () => {
    const r = await send({ verdict: "good" });
    expect(r).toMatchObject({ id: 1, proposalId: memeId, verdict: "good", tags: [], note: "", kind: "meme", playbookVersion: "pb-3", idea: { name: "Idea Alpha", ticker: "AAA", angle: "Angle Alpha" } });
    expect(stored()).toHaveLength(1);
  });

  it("add why: a second row with tags and a trimmed note supersedes the first, and both are kept", async () => {
    await send({ verdict: "bad" });
    const second = await send({ verdict: "bad", tags: ["boring", "too-generic", "boring"], note: "  seen it  " });
    expect(second).toMatchObject({ id: 2, tags: ["boring", "too-generic"], note: "seen it" });
    expect(one({ params: { id: String(memeId) } }).ideaVerdicts.map((v) => [v.id, v.verdict])).toEqual([[2, "bad"], [1, "bad"]]);
  });

  it("a body playbookVersion or kind is ignored: the store's values are stored", async () => {
    const r = await send({ verdict: "good", playbookVersion: "evil-9", kind: "narrative" });
    expect(r).toMatchObject({ kind: "meme", playbookVersion: "pb-3" });
    expect(JSON.stringify(stored())).not.toContain("evil-9");
  });

  it("a note of exactly 500 characters is accepted", async () => {
    expect(await send({ verdict: "good", note: "x".repeat(500) })).toMatchObject({ verdict: "good" });
  });

  it("404 for an unknown or malformed Proposal, and nothing is stored", async () => {
    expect(await status(send({ verdict: "good" }, "999"))).toBe(404);
    expect(await status(send({ verdict: "good" }, "abc"))).toBe(404);
    expect(stored()).toEqual([]);
  });

  it("400 for a Narrative-kind Proposal, and nothing is stored", async () => {
    expect(await status(send({ verdict: "good" }, String(techId)))).toBe(400);
    expect(await message(send({ verdict: "good" }, String(techId)))).toBe("Only a meme idea gets an Idea verdict");
    expect(stored()).toEqual([]);
  });

  it.each([
    ["an unknown verdict", { verdict: "great" }],
    ["no verdict", { tags: [] }],
    ["a verdict that is not text", { verdict: 1 }],
    ["an unknown tag", { verdict: "bad", tags: ["wrong-cluster"] }],
    ["tags that are not a list", { verdict: "bad", tags: "boring" }],
    ["a tag that is not text", { verdict: "bad", tags: [1] }],
    ["a note that is not text", { verdict: "bad", note: 5 }],
    ["a 501-character note", { verdict: "bad", note: "x".repeat(501) }],
    ["an extra key", { verdict: "bad", extra: true }],
    ["dimensions", { verdict: "bad", dimensions: ["hook"] }],
    ["an array", [{ verdict: "bad" }]],
    ["null", null],
    ["text that is not JSON", "{not json"],
    ["a number", 7],
  ])("400 for %s, and nothing is stored", async (_name, body) => {
    expect(await status(send(body))).toBe(400);
    expect(stored()).toEqual([]);
    expect(store.currentProposalVerdicts()).toEqual({});
  });

  it("the 501-character message names the limit", async () => {
    expect(await message(send({ verdict: "bad", note: "x".repeat(501) }))).toBe("The note is over 500 characters");
  });

  it("changes no Proposal, no command and no status history", async () => {
    const before = JSON.stringify([store.listProposals(), store.pendingCommands(), store.historyFor(memeId)]);
    await send({ verdict: "bad", tags: ["risky"] });
    expect(JSON.stringify([store.listProposals(), store.pendingCommands(), store.historyFor(memeId)])).toBe(before);
  });

  it("is a POST-only file under the Proposal's id, with no edit or delete route beside it", () => {
    const dir = new URL("../api/proposals/[id]/", import.meta.url);
    expect(existsSync(new URL("verdict.post.ts", dir))).toBe(true);
    for (const other of ["verdict.get.ts", "verdict.put.ts", "verdict.patch.ts", "verdict.delete.ts", "verdict.ts"]) expect(existsSync(new URL(other, dir)), other).toBe(false);
  });
});

describe("the reads", () => {
  it("GET /api/proposals carries each Proposal's current Idea verdict (null for none, and for a Narrative Proposal)", async () => {
    expect(list().every((p) => p.ideaVerdict === null)).toBe(true);
    await send({ verdict: "bad" });
    await send({ verdict: "good" });
    await send({ verdict: "bad" }, String(memeId + 1));
    const byId = Object.fromEntries(list().map((p) => [p.id, p.ideaVerdict]));
    expect(byId).toEqual({ [memeId]: "good", [memeId + 1]: "bad", [memeId + 2]: null, [techId]: null });
  });

  it("GET /api/proposals/:id carries the history newest first; a Narrative Proposal has none", async () => {
    expect(one({ params: { id: String(memeId) } }).ideaVerdicts).toEqual([]);
    await send({ verdict: "bad" });
    await send({ verdict: "good", note: "better" });
    expect(one({ params: { id: String(memeId) } }).ideaVerdicts.map((v) => v.verdict)).toEqual(["good", "bad"]);
    expect(one({ params: { id: String(techId) } }).ideaVerdicts).toEqual([]);
  });

  it("GET /api/narratives/:id gives its meme ideas' current verdict for the link pill", async () => {
    store.recordSignals([{ id: "s:1", sourceId: "rss:a", sourceLabel: "Feed A", title: "One story", summary: "s", url: "https://a.example/1", publishedAt: "2026-11-22T09:00:00.000Z" }]);
    const narrativeId = store.createNarrative(store.unclusteredSignals(5)[0]!, [1, 0], "2026-11-22T09:00:00.000Z", { id: "t", dimension: 2 });
    const scoreId = store.recordScore({ narrativeId, rubricVersion: 1, scores: { momentum: 7, novelty: 6, buildability: 8, hook: 5, legitimacy: 9 }, total: 7, rationale: "r", signalCount: 1, changedMateriallyAt: "2026-11-22T09:00:00.000Z", createdAt: "2026-11-22T09:30:00.000Z" });
    const news = store.createMemeProposals({ ...trio(), metaKey: `narrative:${narrativeId}`, narrative: { id: narrativeId, scoreId } }, { now: new Date(NOW) });
    await send({ verdict: "good" }, String(news[0]!.id));
    const linked = narrativeOne({ params: { id: String(narrativeId) } }).proposals;
    expect(linked.map((p) => [p.id as number, p.ideaVerdict]).sort((a, b) => (a[0] as number) - (b[0] as number))).toEqual([[news[0]!.id, "good"], [news[1]!.id, null], [news[2]!.id, null]]);
  });
});
