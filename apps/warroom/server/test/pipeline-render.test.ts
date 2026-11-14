import { readFileSync } from "node:fs";
import { PIPELINE, resolvePipeline } from "@argus/core";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { expect, it } from "vitest";
import { type PipelinePayload, pipelineView } from "../../app/utils/pipeline-layout.ts";

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

it("no client code imports @argus/core, and no timer drives the animation", () => {
  for (const file of ["pages/pipeline.vue", "components/PipelineGraph.vue", "utils/pipeline-layout.ts"]) {
    const text = readFileSync(new URL(`../../app/${file}`, import.meta.url), "utf8");
    expect(text, file).not.toMatch(/@argus\/core/);
    expect(text, file).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
  }
});

it("the nav has the page as 'How it works' at /pipeline", () => {
  const app = readFileSync(new URL("../../app/app.vue", import.meta.url), "utf8");
  expect(app).toContain('{ to: "/pipeline", label: "How it works" }');
});
