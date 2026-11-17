import { existsSync } from "node:fs";
import { Datastore } from "@argus/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/narratives/:id/verdict, GET /api/narrative-verdicts and the detail the page renders (War Room ticket 19): the real route handlers
 * over an in-memory store, called with the exact body the form sends. Only Nitro's auto-imported globals are stubbed. The War Room writes the
 * verdict row and nothing else.
 */
type Ev = { params?: Record<string, string>; body?: unknown };
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("getRouterParam", (e: Ev, k: string) => e.params?.[k]);
vi.stubGlobal("readBody", async (e: Ev) => e.body);
vi.stubGlobal("getQuery", (e?: { query?: Record<string, string> }) => e?.query ?? {});
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);

const post = (await import("../api/narratives/[id]/verdict.post.ts")).default as unknown as (e: Ev) => Promise<Record<string, unknown>>;
const listGet = (await import("../api/narratives/index.get.ts")).default;
const exportGet = (await import("../api/narrative-verdicts.get.ts")).default as unknown as () => Array<Record<string, unknown>>;
const detail = (await import("../api/narratives/[id].get.ts")).default as unknown as (e: Ev) => { verdicts: Array<Record<string, unknown>>; proposals: Array<Record<string, unknown>> };

const DIMS = { momentum: 7, novelty: 6, buildability: 8, hook: 5, legitimacy: 9 };
const send = (body: unknown, id = "1") => post({ params: { id }, body });
const status = async (p: Promise<unknown>) => ((await p.then(() => ({ statusCode: 200 }), (e: { statusCode: number }) => e)) as { statusCode: number }).statusCode;
const message = async (p: Promise<unknown>) => ((await p.then(() => ({ statusMessage: "" }), (e: { statusMessage: string }) => e)) as { statusMessage: string }).statusMessage;
let scoreId: number;

beforeEach(() => {
  store = Datastore.open(":memory:");
  store.recordSignals([{ id: "s:1", sourceId: "rss:a", sourceLabel: "Feed A", title: "One story", summary: "s", url: "https://a.example/1", publishedAt: "2026-11-17T09:00:00.000Z" }]);
  store.createNarrative(store.unclusteredSignals(5)[0]!, [1, 0], "2026-11-17T09:00:00.000Z", { id: "t", dimension: 2 });
  scoreId = store.recordScore({ narrativeId: 1, rubricVersion: 3, scores: DIMS, total: 7, rationale: "r", signalCount: 1, changedMateriallyAt: "2026-11-17T09:00:00.000Z", createdAt: "2026-11-17T09:30:00.000Z" });
});

const untouched = () => {
  expect(store.verdictsFor(1)).toEqual([]);
  expect(store.verdictExport()).toEqual([]);
};

describe("POST /api/narratives/:id/verdict", () => {
  it("a good body returns 200 and a row stored with the latest Score id and Rubric version", async () => {
    const r = await send({ verdict: "bad", tags: ["wrong-cluster", "score-too-high"], dimensions: ["momentum", "hook"], note: "  two stories in one  " });
    expect(r).toMatchObject({ id: 1, narrativeId: 1, verdict: "bad", tags: ["wrong-cluster", "score-too-high"], dimensions: ["momentum", "hook"], note: "two stories in one", scoreId, rubricVersion: 3 });
    expect(store.verdictsFor(1)).toHaveLength(1);
  });

  it("a bare verdict is enough; tags, dimensions and note default to empty", async () => {
    expect(await send({ verdict: "good" })).toMatchObject({ verdict: "good", tags: [], dimensions: [], note: "" });
  });

  it("a note of exactly 500 characters is accepted; a tag may go with good", async () => {
    expect(await send({ verdict: "good", tags: ["score-too-low"], dimensions: ["novelty"], note: "x".repeat(500) })).toMatchObject({ verdict: "good", tags: ["score-too-low"] });
  });

  it("a duplicated tag or dimension is stored once", async () => {
    expect(await send({ verdict: "bad", tags: ["duplicate", "duplicate", "score-too-low"], dimensions: ["hook", "hook"] })).toMatchObject({ tags: ["duplicate", "score-too-low"], dimensions: ["hook"] });
  });

  it("404 for an unknown or malformed Narrative, and nothing is stored", async () => {
    expect(await status(send({ verdict: "good" }, "99"))).toBe(404);
    expect(await status(send({ verdict: "good" }, "abc"))).toBe(404);
    untouched();
  });

  it.each([
    ["an unknown verdict", { verdict: "great" }],
    ["no verdict", { tags: [] }],
    ["a verdict that is not text", { verdict: 1 }],
    ["an unknown tag", { verdict: "bad", tags: ["boring"] }],
    ["tags that are not a list", { verdict: "bad", tags: "duplicate" }],
    ["a tag that is not text", { verdict: "bad", tags: [1] }],
    ["an unknown dimension", { verdict: "bad", tags: ["score-too-high"], dimensions: ["vibes"] }],
    ["dimensions that are not a list", { verdict: "bad", tags: ["score-too-high"], dimensions: "hook" }],
    ["dimensions without a score tag", { verdict: "bad", tags: ["duplicate"], dimensions: ["hook"] }],
    ["dimensions with no tag at all", { verdict: "bad", dimensions: ["hook"] }],
    ["a note that is not text", { verdict: "bad", note: 5 }],
    ["a 501-character note", { verdict: "bad", note: "x".repeat(501) }],
    ["an extra key", { verdict: "bad", extra: true }],
    ["a scoreId in the body", { verdict: "bad", scoreId: 99 }],
    ["an array", [{ verdict: "bad" }]],
    ["null", null],
    ["text that is not JSON", "{not json"],
    ["a number", 7],
  ])("400 for %s, and nothing is stored", async (_name, body) => {
    expect(await status(send(body))).toBe(400);
    untouched();
  });

  it("the 501-character message names the limit", async () => {
    expect(await message(send({ verdict: "bad", note: "x".repeat(501) }))).toBe("The note is over 500 characters");
  });

  it("a body that tries to set the Score or the Rubric version is refused, so it cannot have an effect", async () => {
    await status(send({ verdict: "bad", scoreId: 99, rubricVersion: 9 }));
    const r = await send({ verdict: "bad" });
    expect(r).toMatchObject({ scoreId, rubricVersion: 3 });
  });

  it("changes no Proposal, no Narrative and no command", async () => {
    const before = JSON.stringify([store.listProposals(), store.getNarrative(1), store.pendingCommands(), store.scoresFor(1)]);
    await send({ verdict: "bad", tags: ["duplicate"] });
    expect(JSON.stringify([store.listProposals(), store.getNarrative(1), store.pendingCommands(), store.scoresFor(1)])).toBe(before);
  });
});

describe("GET /api/narrative-verdicts", () => {
  it("is an empty array with no verdicts", () => {
    expect(exportGet()).toEqual([]);
  });

  it("lists every verdict with the Score at the time, the latest Score and scoreChanged; reading writes nothing", async () => {
    await send({ verdict: "bad", tags: ["score-too-high"], dimensions: ["hook"], note: "n" });
    const newer = store.recordScore({ narrativeId: 1, rubricVersion: 4, scores: DIMS, total: 5, rationale: "later", signalCount: 1, changedMateriallyAt: "2026-11-17T09:00:00.000Z", createdAt: "2026-11-17T10:00:00.000Z" });
    const before = JSON.stringify(store.verdictExport());
    const out = exportGet();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ narrativeId: 1, title: "One story", verdict: "bad", tags: ["score-too-high"], dimensions: ["hook"], note: "n", score: { id: scoreId, rubricVersion: 3, total: 7, rationale: "r", scores: DIMS }, latestScore: { id: newer, rubricVersion: 4, total: 5 }, scoreChanged: true });
    expect(JSON.stringify(store.verdictExport())).toBe(before);
    expect(store.verdictsFor(1)).toHaveLength(1);
  });

  it("is a GET-only file, so a POST to it is 405 (Nitro answers 405 for a route with no handler for the method)", () => {
    const dir = new URL("../api/", import.meta.url);
    expect(existsSync(new URL("narrative-verdicts.get.ts", dir))).toBe(true);
    for (const other of ["narrative-verdicts.post.ts", "narrative-verdicts.put.ts", "narrative-verdicts.delete.ts", "narrative-verdicts.ts"]) expect(existsSync(new URL(other, dir)), other).toBe(false);
  });
});

describe("GET /api/narratives?verdict=", () => {
  const list = (query: Record<string, string>) => (listGet as unknown as (e: { query: Record<string, string> }) => Array<{ id: number; verdict: string | null }>)({ query });

  it("filters Good, Bad and None, and every row carries its current verdict", async () => {
    store.recordSignals([{ id: "s:2", sourceId: "rss:a", sourceLabel: "Feed A", title: "Two", summary: "s", url: "https://a.example/2", publishedAt: "2026-11-17T09:00:00.000Z" }]);
    store.createNarrative(store.unclusteredSignals(5)[0]!, [0, 1], "2026-11-17T09:00:00.000Z", { id: "t", dimension: 2 });
    await send({ verdict: "bad" });
    await send({ verdict: "good" });
    expect(list({ verdict: "good" }).map((n) => n.id)).toEqual([1]);
    expect(list({ verdict: "bad" })).toEqual([]);
    expect(list({ verdict: "none" }).map((n) => n.id)).toEqual([2]);
    expect(list({ verdict: "" }).map((n) => [n.id, n.verdict]).sort()).toEqual([[1, "good"], [2, null]]);
    expect(() => list({ verdict: "maybe" })).toThrow("Invalid verdict filter");
  });
});

describe("GET /api/narratives/:id", () => {
  it("carries the verdict history newest first, and the Proposals made from the Narrative", async () => {
    expect(detail({ params: { id: "1" } })).toMatchObject({ verdicts: [], proposals: [] });
    await send({ verdict: "bad" });
    await send({ verdict: "good", note: "better" });
    store.createResearchProposal(
      { narrativeId: 1, scoreId, name: "Story Tool", ticker: "STORY", narrativeSummary: "n", techOneLiner: "t", whyNow: "w", description: "d", evidenceLinks: [] },
      { now: new Date("2026-11-17T11:00:00.000Z") },
    );
    const out = detail({ params: { id: "1" } });
    expect(out.verdicts.map((v) => v.verdict)).toEqual(["good", "bad"]);
    expect(out.proposals).toEqual([{ id: 1, name: "Story Tool", ticker: "STORY", kind: "narrative", status: "new" }]);
  });
});
