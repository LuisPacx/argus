import { readFileSync } from "node:fs";
import { Datastore, type Proposal, type Score } from "@argus/core";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import { scoreNowLine } from "../../app/utils/score-now.ts";
import { whyView } from "../../app/utils/why.ts";

/** Proposal routing ticket 03: the card shows the Score the Proposal was created from, and "now: X" when the Narrative has a newer one. */
type Ev = { params?: Record<string, string>; query?: Record<string, string> };
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("getRouterParam", (e: Ev, k: string) => e.params?.[k]);
vi.stubGlobal("getQuery", (e?: Ev) => e?.query ?? {});
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);
vi.stubGlobal("useDataDir", () => "/argus/data");
vi.stubGlobal("useBuildRoot", () => "/builds/code");

type Row = Proposal & { score: Score | null; latestScore?: Score };
const list = (await import("../api/proposals/index.get.ts")).default as unknown as (e?: Ev) => Row[];
const one = (await import("../api/proposals/[id].get.ts")).default as unknown as (e: Ev) => Row;

const dims = (buildability: number) => ({ momentum: 6, novelty: 6, buildability, hook: 6, legitimacy: 8 });
const fields = (name: string) => ({ narrativeSummary: "s", techOneLiner: "t", whyNow: "w", name, ticker: "TKR", description: "d", evidenceLinks: ["https://e.example/1", "https://e.example/2", "https://e.example/3"] });
let seq = 0;
const narrative = () => {
  const id = `s:${++seq}`;
  store.recordSignals([{ id, sourceId: "rss:a", sourceLabel: "Feed A", title: `Story ${seq}`, summary: "", url: `https://a.example/${id}`, publishedAt: "2026-06-14T09:00:00.000Z" }]);
  return store.createNarrative(store.unclusteredSignals(10).find((s) => s.id === id)!, [1, 0], new Date().toISOString(), { id: "e", dimension: 2 });
};
const score = (narrativeId: number, buildability: number, total: number) =>
  store.recordScore({ narrativeId, rubricVersion: 1, scores: dims(buildability), total, rationale: `r${buildability}`, signalCount: 1, changedMateriallyAt: new Date().toISOString(), createdAt: new Date().toISOString() });

beforeEach(() => {
  store = Datastore.open(":memory:");
});

it("getScore reads a Score by id, and gives undefined for a null id and for an id with no row", () => {
  const nid = narrative();
  const sid = score(nid, 5, 6.1);
  expect(store.getScore(sid)).toMatchObject({ id: sid, narrativeId: nid, total: 6.1, scores: dims(5) });
  expect(store.getScore(null)).toBeUndefined();
  expect(store.getScore(sid + 100)).toBeUndefined();
});

it("no newer Score: score is the creation Score and there is no latestScore (list and detail)", () => {
  const nid = narrative();
  const sid = score(nid, 5, 6.1);
  const p = store.createResearchProposal({ ...fields("Same"), narrativeId: nid, scoreId: sid });
  expect(list()[0]).toMatchObject({ id: p.id, score: { id: sid } });
  expect(list()[0]).not.toHaveProperty("latestScore");
  expect(one({ params: { id: String(p.id) } })).not.toHaveProperty("latestScore");
});

it("reproduction of Proposal 155: created from buildability 5, judged again at 4; score is the 5, latestScore the 4", () => {
  const nid = narrative();
  score(nid, 1, 5.2);
  const gate = score(nid, 5, 6.3);
  const p = store.createResearchProposal({ ...fields("Proposal 155"), narrativeId: nid, scoreId: gate });
  const later = score(nid, 4, 6.1);
  for (const r of [list()[0]!, one({ params: { id: String(p.id) } })]) {
    expect(r).toMatchObject({ score: { id: gate, total: 6.3, scores: { buildability: 5 } }, latestScore: { id: later, total: 6.1, scores: { buildability: 4 } } });
    expect(r.score!.id).not.toBe(r.latestScore!.id);
    expect(scoreNowLine(r.score, r.latestScore)).toBe("now: 6.1/10, buildability 4");
  }
  // The Why panel reads the creation Score: what the Proposal was judged on.
  expect(whyView({ reason: "", interaction: "", evidenceLinks: [], signals: [], score: one({ params: { id: String(p.id) } }).score! }).score).toMatchObject({ scores: dims(5), rationale: "r5" });
});

it("a null scoreId and a hand-entered Proposal fall back to today's behaviour", () => {
  const nid = narrative();
  const sid = score(nid, 5, 6.1);
  const later = score(nid, 4, 6.1);
  const orphan = store.createResearchProposal({ ...fields("NoScoreId"), narrativeId: nid, scoreId: null as unknown as number });
  const dangling = store.createResearchProposal({ ...fields("Dangling"), narrativeId: narrative(), scoreId: sid + 500 });
  const hand = store.createProposal(fields("Hand"));
  const rows = list();
  expect(rows.find((r) => r.id === orphan.id)).toMatchObject({ score: { id: later } });
  expect(rows.find((r) => r.id === orphan.id)).not.toHaveProperty("latestScore");
  expect(rows.find((r) => r.id === dangling.id)).toMatchObject({ score: null });
  expect(rows.find((r) => r.id === hand.id)).toMatchObject({ score: null });
  expect(rows.find((r) => r.id === hand.id)).not.toHaveProperty("latestScore");
});

it("sort=score orders by the Score each card shows (the creation Score): a later, higher Score does not move the Proposal up", () => {
  const n1 = narrative();
  const n2 = narrative();
  const s1 = score(n1, 5, 5);
  const s2 = score(n2, 5, 7);
  const a = store.createResearchProposal({ ...fields("A"), narrativeId: n1, scoreId: s1 });
  const b = store.createResearchProposal({ ...fields("B"), narrativeId: n2, scoreId: s2 });
  score(n1, 5, 9);
  expect(list({ query: { sort: "score" } }).map((r) => [r.id, r.score!.total])).toEqual([[b.id, 7], [a.id, 5]]);
});

it("scoreNowLine: names the changed total and dimensions only, nothing when they match", () => {
  const a = { total: 6.3, scores: dims(5) };
  expect(scoreNowLine(a, undefined)).toBeNull();
  expect(scoreNowLine(a, { total: 6.3, scores: dims(5) })).toBeNull();
  expect(scoreNowLine(a, { total: 6.3, scores: dims(4) })).toBe("now: buildability 4");
  expect(scoreNowLine(a, { total: 6.1, scores: { ...dims(4), hook: 7 } })).toBe("now: 6.1/10, buildability 4, hook 7");
});

async function renderNow(created: unknown, latest: unknown): Promise<string> {
  const sfc = parse(readFileSync(new URL("../../app/components/ScoreNow.vue", import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: "ScoreNow.vue", id: "sn" });
  const render = new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as (ctx: unknown, cache: unknown[]) => unknown;
  const line = scoreNowLine(created as never, latest as never);
  return renderToString(createSSRApp({ render: () => render({ line }, []) as ReturnType<typeof h> }));
}

it("the muted line renders 'now: ...' only when the latest Score differs", async () => {
  const created = { total: 6.3, scores: dims(5) };
  expect(await renderNow(created, { total: 6.1, scores: dims(4) })).toContain("now: 6.1/10, buildability 4");
  expect(await renderNow(created, undefined)).not.toContain("now:");
  expect(await renderNow(created, created)).not.toContain("now:");
});

it("both pages mount ScoreNow with the creation Score and the latest", () => {
  const read = (p: string) => readFileSync(new URL(`../../app/${p}`, import.meta.url), "utf8");
  for (const page of ["pages/index.vue", "pages/proposals/[id].vue"]) expect(read(page)).toContain(`<ScoreNow`);
  for (const page of ["pages/index.vue", "pages/proposals/[id].vue"]) expect(read(page)).toContain(`:created="p.score" :latest="p.latestScore"`);
});
