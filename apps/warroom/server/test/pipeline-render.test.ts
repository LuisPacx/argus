import { readFileSync } from "node:fs";
import { PIPELINE, resolvePipeline } from "@argus/core";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { expect, it } from "vitest";
import { compactCount, type PipelineLivePayload, type PipelinePayload, pipelineView, usd } from "../../app/utils/pipeline-layout.ts";

/** The page's rendering: the real PipelineGraph.vue template, server-rendered over the real graph and over hostile text. */
type Render = (ctx: unknown, cache: unknown[]) => unknown;
async function load(file: string): Promise<Render> {
  const sfc = parse(readFileSync(new URL(`../../app/components/${file}`, import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: file, id: file });
  return new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;
}
const renderGraph = await load("PipelineGraph.vue");
const draw = async (payload: PipelinePayload): Promise<string> => {
  const view = pipelineView(payload);
  return renderToString(createSSRApp({ render: () => renderGraph({ view, animate: false }, []) as ReturnType<typeof h> }));
};
const real = (): PipelinePayload => resolvePipeline(PIPELINE, { rubric: { version: 3, gateMinScore: 6 } });

it("draws the thirteen nodes in their columns, each with its status in words", async () => {
  const html = await draw(real());
  for (const id of ["sources", "signals", "narratives", "judge", "proposals", "shortlist", "spec", "approve", "build", "preview", "study", "meta", "beta"]) expect(html, id).toContain(`data-test="node-${id}"`);
  for (const label of ["Sources", "Signals", "Narratives", "Judge", "Proposals", "Shortlist", "Spec", "Approve", "Build", "Preview", "Study", "Meta", "Beta finder"]) expect(html, label).toContain(`>${label}</h3>`);
  expect(html.match(/data-test="node-status"/g)).toHaveLength(13);
});

it("tells off and context-only apart in words and in class, and the Sources node lists its five Sources", async () => {
  const html = await draw(real());
  const betaAt = html.indexOf('data-test="node-beta"');
  const beta = html.slice(html.lastIndexOf("<article", betaAt), betaAt + 600);
  expect(beta).toContain("is-off");
  expect(beta).toMatch(/>off<\/span>/);
  expect(html).toContain('title="A library and a backtest script only.');
  for (const [id, word] of [["rss:", "context only"], ["trends:google", "context only"], ["github:trending", "context only"], ["pumpportal:events", "market"], ["dexscreener:trending", "market"]] as const) {
    const chip = html.slice(html.indexOf(`data-test="chip-${id}"`), html.indexOf(`data-test="chip-${id}"`) + 400);
    expect(chip, id).toContain(`>${word}</span>`);
  }
  expect(html.match(/class="pipe-node is-on"/g)).toHaveLength(12);
});

it("draws every edge as a path with an arrow, and a gate marker only on the two gated edges, with the real rule in its title", async () => {
  const html = await draw(real());
  const payload = real();
  for (const e of payload.edges) expect(html, e.id).toContain(`data-test="edge-${e.id}"`);
  expect(html.match(/data-test="gate-/g)).toHaveLength(2);
  expect(html).toContain("<title>Needs a market Signal from: pumpportal:events, dexscreener:trending</title>");
  expect(html).toContain("<title>Buildability gate, minimum: 6 (Rubric v3)</title>");
  expect(html).toContain("is-dashed");
  expect(html).toContain('marker-end="url(#pipe-arrow)"');
});

it("lists every edge in words below the picture, gates included", async () => {
  const html = await draw(real());
  expect(html).toContain("Narratives to Judge: judge new or changed Narratives");
  expect(html).toContain("Buildability gate, minimum: 6 (Rubric v3)");
  expect(html).toContain("Beta finder to Proposals: Beta Proposals (not wired)");
  expect(html.match(/<li data-test="legend-[a-z-]+"/g)).toHaveLength(real().edges.length);
});

it("says why a node is off, in a visible line", async () => {
  const html = await draw(real());
  expect(html).toContain("<strong>Beta finder (off):</strong>");
  expect(html).toContain("slices 3 and 4 are paused");
});

it("no raw HTML: hostile labels, notes and gate text come out escaped, and nothing in the template can inject markup", async () => {
  const evil = `<img src=x onerror=alert(1)></script><script>alert(1)</script>`;
  const payload: PipelinePayload = {
    nodes: [
      { id: "a", label: evil, column: 0, row: 0, status: "off", statusNote: evil, sources: [{ id: "x", label: evil, status: "on" }] },
      { id: "b", label: "B", column: 1, row: 0, status: "on", sources: [] },
    ],
    edges: [{ id: "a-b", from: "a", to: "b", label: evil, dashed: false, gates: [{ label: evil, display: evil }] }],
    rubric: null,
  };
  const html = await draw(payload);
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  const source = readFileSync(new URL("../../app/components/PipelineGraph.vue", import.meta.url), "utf8");
  expect(source).not.toMatch(/v-html/);
  expect(readFileSync(new URL("../../app/pages/pipeline.vue", import.meta.url), "utf8")).not.toMatch(/v-html/);
});

it("no client code imports @argus/core, and no timer drives the animation (the page's only timer is the 10 s poll)", () => {
  for (const file of ["pages/pipeline.vue", "components/PipelineGraph.vue", "utils/pipeline-layout.ts"]) {
    const text = readFileSync(new URL(`../../app/${file}`, import.meta.url), "utf8");
    expect(text, file).not.toMatch(/@argus\/core/);
    expect(text, file).not.toMatch(/setTimeout|requestAnimationFrame/);
    if (file !== "pages/pipeline.vue") expect(text, file).not.toMatch(/setInterval/);
  }
  const page = readFileSync(new URL("../../app/pages/pipeline.vue", import.meta.url), "utf8");
  expect(page.match(/setInterval\(/g)).toHaveLength(1);
  expect(page).toMatch(/setInterval\(\(\) => void refreshLive\(\), 10_000\)/);
  expect(page).toContain("clearInterval(poll)");
});

it("the page keeps the static graph and says so when the live route fails, and shows no stale numbers", () => {
  const page = readFileSync(new URL("../../app/pages/pipeline.vue", import.meta.url), "utf8");
  expect(page).toContain('data-test="pipeline-live-error"');
  expect(page).toMatch(/liveError\.value \? null/); // an error drops the numbers: pipelineView(pipeline, null) is the static graph
});

const LIVE: PipelineLivePayload = {
  edges: {
    "sources-signals": { metric: "signals_ingested", count: 12_345 },
    "narratives-judge": { metric: "narratives_judged", count: 42, passedGate: 7 },
    "sources-study": { metric: "creates_seen", count: 1_204 },
    "proposals-shortlist": { metric: "shortlisted", count: 0 },
  },
  nodes: { judge: { runs: 3, spendUsd: 0.04, apiRuns: 1, apiUsd: 0.004 }, build: { runs: 1, spendUsd: 3.5, apiRuns: 0, apiUsd: 0 } },
  other: { tasks: ["study"], runs: 2, spendUsd: 1.5, apiRuns: 0, apiUsd: 0 },
};
const drawLive = async (live: PipelineLivePayload | null): Promise<string> => {
  const view = pipelineView(real(), live);
  return renderToString(createSSRApp({ render: () => renderGraph({ view, animate: false }, []) as ReturnType<typeof h> }));
};

it("overlays the last-24 h count on each edge that has one, and Claude spend on each node that has it", async () => {
  const html = await drawLive(LIVE);
  const at = (id: string) => {
    const i = html.indexOf(`data-test="${id}"`);
    return html.slice(html.lastIndexOf("<", i), i + 300);
  };
  expect(at("count-sources-signals")).toContain(">12k</span>");
  expect(at("count-sources-signals")).toContain('title="12,345 in the last 24 h"');
  expect(at("count-narratives-judge")).toContain('title="42 in the last 24 h, 7 passed the gate"');
  expect(at("count-sources-study")).toContain(">1.2k</span>"); // PumpPortal creates: their own edge, apart from the Signals
  expect(at("count-proposals-shortlist")).toContain(">0</span>");
  expect(html.match(/data-test="count-/g)).toHaveLength(4);
  expect(at("spend-judge")).toContain(">$0.040 est.</span>");
  expect(at("spend-judge")).toContain(">3 runs</span>");
  expect(at("spend-judge")).toContain(">API $0.004</span>"); // real dollars on their own line
  expect(at("spend-build")).toContain(">$3.50 est.</span>");
  expect(at("spend-build")).not.toContain(">API $"); // no API line when the API did not run
  expect(html.match(/data-test="spend-/g)).toHaveLength(2);
  expect(html).toContain("Other tasks (study): $1.50 est., 2 runs in the last 24 h");
  expect(html).toContain("<strong");
  expect(html).toContain("42 in the last 24 h, 7 passed the gate");
});

it("with no live numbers (the live route failed or has not answered) it draws the static graph: no badge, no spend line", async () => {
  const html = await drawLive(null);
  expect(html).not.toContain("data-test=\"count-");
  expect(html).not.toContain("data-test=\"spend-");
  expect(html).not.toContain("pipeline-other");
  expect(html).toContain('data-test="node-judge"');
  expect(html).toBe(await draw(real()));
});

it("live text is escaped like the rest: a hostile task name comes out as text", async () => {
  const html = await drawLive({ ...LIVE, other: { tasks: ["<script>alert(1)</script>"], runs: 1, spendUsd: 0, apiRuns: 0, apiUsd: 0 } });
  expect(html).not.toContain("<script>alert");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
});

it("compact counts and dollars", () => {
  expect([0, 999, 1000, 1234, 9999, 10_000, 12_345].map(compactCount)).toEqual(["0", "999", "1k", "1.2k", "10k", "10k", "12k"]);
  expect([0, 0.004, 0.0999, 0.1, 0.75, 3.5].map(usd)).toEqual(["$0", "$0.004", "$0.100", "$0.10", "$0.75", "$3.50"]);
});

it("the nav has the page as 'How it works' at /pipeline", () => {
  const app = readFileSync(new URL("../../app/app.vue", import.meta.url), "utf8");
  expect(app).toContain('{ to: "/pipeline", label: "How it works" }');
});
