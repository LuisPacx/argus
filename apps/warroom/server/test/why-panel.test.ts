import { readFileSync } from "node:fs";
import { Datastore } from "@argus/core";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import { safeHttpUrl } from "../../app/utils/safe-link.ts";
import { whyView } from "../../app/utils/why.ts";

/** The API shape (real route handler, Nitro globals stubbed) and the panel's rendering (the real WhyPanel.vue template, server-rendered). */
type Ev = { params: Record<string, string> };
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("getRouterParam", (e: Ev, k: string) => e.params[k]);
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);
vi.stubGlobal("useDataDir", () => "/argus/data");
vi.stubGlobal("useBuildRoot", () => "/builds/code");

type Api = {
  reason: string;
  interaction: string;
  signals: Array<{ title: string; sourceLabel: string; url: string; publishedAt: string }>;
  score: { scores: Record<string, number>; rationale: string; rubricVersion: number } | null;
  evidenceLinks: string[];
};
const get = (await import("../api/proposals/[id].get.ts")).default as unknown as (e: Ev) => Api;

const XSS = "<script>alert(1)</script>";
const dims = { momentum: 5, novelty: 6, buildability: 7, hook: 8, legitimacy: 9 };
const check = { status: "clear" as const, detail: "d", source: "s", checkedAt: "2026-06-14T10:00:00.000Z" };
const base = { narrativeSummary: "s", techOneLiner: "t", whyNow: "w", name: "Alpha", ticker: "ALP", description: "d", evidenceLinks: ["https://e.example/1", "https://e.example/2", "https://e.example/3"] };
const signal = (i: number, over: Partial<{ title: string; url: string }> = {}) => ({
  id: `s:${i}`,
  sourceId: "rss:a",
  sourceLabel: "Feed A",
  title: over.title ?? `Story ${i}`,
  summary: "",
  url: over.url ?? `https://a.example/${i}`,
  publishedAt: `2026-06-14T0${i}:00:00.000Z`,
});

/** A Narrative of 7 Signals (the first two unsafe), scored, with a Proposal carrying `extra`. */
function seed(extra: { reason?: string; interaction?: string }) {
  store = Datastore.open(":memory:");
  store.recordSignals([1, 2, 3, 4, 5, 6, 7].map((i) => signal(i, i === 7 ? { title: XSS, url: "javascript:alert(1)" } : {})));
  const [first, ...rest] = store.unclusteredSignals(10);
  const n = store.createNarrative(first!, [1, 0], new Date().toISOString(), { id: "e", dimension: 2 });
  for (const s of rest) store.joinNarrative(n, s, [1, 0], new Date().toISOString());
  const scoreId = store.recordScore({ narrativeId: n, rubricVersion: 3, scores: dims, total: 7, rationale: `why ${XSS}`, signalCount: 7, changedMateriallyAt: new Date().toISOString(), createdAt: new Date().toISOString() });
  return store.createResearchProposal({ ...base, ...extra, narrativeId: n, scoreId, collisions: { dex: check, github: check } });
}

beforeEach(() => {
  store = Datastore.open(":memory:");
});

it("GET /api/proposals/:id returns reason, interaction, at most 5 newest Signals, and the Score with rationale and Rubric version", () => {
  const p = seed({ reason: "Because Signal 1", interaction: "Click to vote" });
  const r = get({ params: { id: String(p.id) } });
  expect(r.reason).toBe("Because Signal 1");
  expect(r.interaction).toBe("Click to vote");
  expect(r.signals).toHaveLength(5);
  expect(r.signals[0]).toEqual({ title: XSS, sourceLabel: "Feed A", url: "javascript:alert(1)", publishedAt: "2026-06-14T07:00:00.000Z" });
  expect(r.signals.map((s) => s.title).slice(1)).toEqual(["Story 6", "Story 5", "Story 4", "Story 3"]);
  expect(r.score).toMatchObject({ scores: dims, rubricVersion: 3 });
  expect(r.score?.rationale).toContain("why");
  expect(r.evidenceLinks).toHaveLength(3);
});

it("GET /api/proposals/:id gives a hand-entered Proposal no Signals, and an old Proposal empty reason and interaction", () => {
  const hand = store.createProposal(base);
  const r = get({ params: { id: String(hand.id) } });
  expect(r.signals).toEqual([]);
  expect([r.reason, r.interaction]).toEqual(["", ""]);
  expect(get({ params: { id: String(seed({}).id) } }).reason).toBe("");
});

it("safeHttpUrl keeps http(s) and refuses everything else", () => {
  expect(safeHttpUrl("https://a.example/x")).toBe("https://a.example/x");
  expect(safeHttpUrl(" http://a.example ")).toBe("http://a.example/");
  for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "ftp://a.example", "//a.example", "not a url", "", "https://u:p@a.example/", null, 5]) expect(safeHttpUrl(bad)).toBeNull();
});

// Compile the real template (no build plugin in the test setup) and server-render it with ScoreBars stubbed.
const sfc = parse(readFileSync(new URL("../../app/components/WhyPanel.vue", import.meta.url), "utf8"));
const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: "WhyPanel.vue", id: "why" });
const render = new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as (ctx: unknown, cache: unknown[]) => unknown;

async function panel(p: ReturnType<typeof seed>): Promise<string> {
  const view = whyView(get({ params: { id: String(p.id) } }));
  const app = createSSRApp({ render: () => render({ view }, []) as ReturnType<typeof h> });
  app.component("ScoreBars", { props: ["scores"], render() { return h("div", { "data-test": "score-bars" }, Object.keys(this.scores).join(",")); } });
  return renderToString(app);
}

it("the panel shows reason, interaction, Signals with links, scores, rationale, Rubric version and evidence", async () => {
  const html = await panel(seed({ reason: "Because Signal 1", interaction: "Click to vote" }));
  expect(html).toContain("Why this Proposal");
  expect(html).toContain("Because Signal 1");
  expect(html).toContain("Click to vote");
  expect(html).toContain('href="https://a.example/6"');
  expect(html).toContain("Feed A");
  expect(html).toContain("Rubric version 3");
  expect(html).toContain("momentum,novelty,buildability,hook,legitimacy");
  expect(html).toContain('href="https://e.example/1"');
  expect(html).not.toContain("Not recorded");
});

it("old Proposals (reason and interaction empty) show them as absent, not blank", async () => {
  const html = await panel(seed({}));
  expect(html.match(/Not recorded for this Proposal/g)).toHaveLength(2);
});

it("untrusted text renders escaped, and a non-http(s) Signal link is not an anchor", async () => {
  const html = await panel(seed({ reason: XSS, interaction: XSS }));
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("<a href=\"javascript");
  expect(readFileSync(new URL("../../app/components/WhyPanel.vue", import.meta.url), "utf8")).not.toContain("v-html");
});
