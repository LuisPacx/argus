import { readFileSync } from "node:fs";
import { MAX_VERDICT_NOTE_CHARS, RUBRIC_KEYS, VERDICTS, VERDICT_TAGS, SCORE_TAGS } from "@argus/core";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import { DIMENSION_OPTIONS, SCORE_TAG_VALUES, TAG_OPTIONS, VERDICT_FILTER, VERDICT_NOTE_MAX, verdictBody, verdictFormView, type VerdictPayload } from "../../app/utils/verdict.ts";

/** War Room ticket 19: the real component templates (server-rendered) over fixtures typed as the API's own payload. */
const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const HOSTILE = "<img src=x onerror=1> and <b>bold</b>";
const row = (id: number, verdict: string, over: Partial<VerdictPayload> = {}): VerdictPayload => ({ id, verdict, tags: [], dimensions: [], note: "", scoreId: 4, rubricVersion: 2, createdAt: ago(10), ...over });

type Render = (ctx: unknown, cache: unknown[]) => unknown;
async function load(file: string): Promise<Render> {
  const sfc = parse(readFileSync(new URL(`../../app/components/${file}`, import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: file, id: file });
  return new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;
}
const renderForm = await load("VerdictForm.vue");
const renderPill = await load("VerdictPill.vue");
const renderProposals = await load("NarrativeProposals.vue");

function draw(render: Render, ctx: Record<string, unknown>): Promise<string> {
  const app = createSSRApp({ render: () => render(ctx, []) as ReturnType<typeof h> });
  app.component("NuxtLink", { props: ["to"], render() { return h("a", { class: "nuxt-link", href: this.to }, this.$slots.default?.()); } });
  app.component("StatusPill", { props: ["status"], render() { return h("span", { class: "pill", "data-test": "status" }, this.status); } });
  return renderToString(app);
}
const noop = () => undefined;
const form = (input: Partial<Parameters<typeof verdictFormView>[0]> = {}, extra: Record<string, unknown> = {}) =>
  draw(renderForm, { view: verdictFormView({ history: [], choice: null, tags: [], dimensions: [], draft: "", nowMs: NOW, ...input }), busy: false, error: null, inputId: "verdict-note-x", pick: noop, toggleTag: noop, toggleDimension: noop, submit: noop, close: noop, box: null, summaryEl: null, ...extra });

describe("the form", () => {
  it("shows the verdict buttons, the four tags, a 500-character counter and no dimensions while no score tag is on", async () => {
    const html = await form();
    for (const t of ['data-test="verdict-good"', 'data-test="verdict-bad"', 'data-test="tag-wrong-cluster"', 'data-test="tag-duplicate"', 'data-test="tag-score-too-high"', 'data-test="tag-score-too-low"', 'data-test="verdict-counter"', "0 / 500", "Record a verdict", "No verdict yet."]) expect(html, t).toContain(t);
    expect(html).not.toContain("verdict-dimensions");
    expect(html).not.toContain("dimension-hook");
    expect(html).not.toContain("verdict-history");
    expect(html).toContain("disabled"); // no choice yet: Save is off
    expect(html).not.toMatch(/undefined|NaN|null/);
  });

  it("a wrong-cluster or duplicate tag does not ask for dimensions; a score tag does, with all five Rubric dimensions", async () => {
    expect(await form({ tags: ["wrong-cluster", "duplicate"] })).not.toContain("verdict-dimensions");
    for (const tag of SCORE_TAGS) {
      const html = await form({ tags: [tag] });
      expect(html).toContain('data-test="verdict-dimensions"');
      for (const d of RUBRIC_KEYS) expect(html, d).toContain(`data-test="dimension-${d}"`);
    }
  });

  it("the counter counts the trimmed note; a chosen verdict enables Save, and an over-long note turns it off again", async () => {
    expect(await form({ choice: "bad", draft: "  twelve chars  " })).toContain("12 / 500");
    expect(verdictFormView({ history: [], choice: "bad", tags: [], dimensions: [], draft: "", nowMs: NOW }).canSubmit).toBe(true);
    expect(verdictFormView({ history: [], choice: null, tags: [], dimensions: [], draft: "", nowMs: NOW }).canSubmit).toBe(false);
    expect(verdictFormView({ history: [], choice: "good", tags: [], dimensions: [], draft: "x".repeat(501), nowMs: NOW }).canSubmit).toBe(false);
    expect(verdictFormView({ history: [], choice: "good", tags: [], dimensions: [], draft: "x".repeat(500), nowMs: NOW }).canSubmit).toBe(true);
    expect(verdictFormView({ history: [], choice: "good", tags: [], dimensions: [], draft: "", nowMs: NOW, busy: true }).canSubmit).toBe(false);
  });

  it("shows the current verdict and the history under it, newest first, each with the Rubric version it was made against", async () => {
    const html = await form({ history: [row(3, "good", { tags: ["score-too-low"], dimensions: ["hook"], note: "better now", createdAt: ago(5) }), row(2, "bad", { tags: ["duplicate"], rubricVersion: null, scoreId: null, createdAt: ago(120) }), row(1, "bad")] });
    expect(html).toContain('data-test="verdict-current"');
    expect(html).toContain("Change the verdict");
    const current = html.slice(html.indexOf('data-test="verdict-current"'), html.indexOf('data-test="verdict-form"'));
    for (const t of ["Good", "Score too low", "hook", "better now", "Rubric v2", "5 minutes ago"]) expect(current, t).toContain(t);
    const history = html.slice(html.indexOf('data-test="verdict-history"'));
    expect(history.match(/data-test="verdict-earlier"/g)).toHaveLength(2);
    expect(history.indexOf("Duplicate")).toBeLessThan(history.indexOf("Rubric v2"));
    expect(history).toContain("not scored");
  });

  it("a note with markup shows as escaped text, never as an element", async () => {
    const html = await form({ history: [row(1, "bad", { note: HOSTILE })], draft: HOSTILE });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>bold");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
  });

  it("a long note is cut in the view", async () => {
    const html = await form({ history: [row(1, "bad", { note: "w".repeat(500) })] });
    expect(html).not.toContain("w".repeat(400));
    expect(html).toContain("…");
  });

  it("shows the server's reason in an alert", async () => {
    expect(await form({}, { error: "The note is over 500 characters" })).toContain('role="alert"');
  });
});

describe("the body the form sends", () => {
  it("drops the dimensions while no score tag is on, keeps them with one, and never carries a Score or a Rubric version", () => {
    expect(verdictBody({ choice: "bad", tags: ["duplicate"], dimensions: ["hook"], draft: "n" })).toEqual({ verdict: "bad", tags: ["duplicate"], dimensions: [], note: "n" });
    expect(verdictBody({ choice: "good", tags: ["score-too-low"], dimensions: ["hook"], draft: "" })).toEqual({ verdict: "good", tags: ["score-too-low"], dimensions: ["hook"], note: "" });
  });
});

describe("the pill and the Proposal links", () => {
  it("the pill shows the current verdict, and nothing when there is none", async () => {
    expect(await draw(renderPill, { pill: { label: "Verdict: Good", tone: "good" } })).toContain("Verdict: Good");
    expect(await draw(renderPill, { pill: { label: "Verdict: Bad", tone: "bad" } })).toContain('data-tone="bad"');
    expect(await draw(renderPill, { pill: null })).not.toContain("verdict-pill");
  });

  it("the page lists its Proposals as links to /proposals/<id>; none: no block", async () => {
    const html = await draw(renderProposals, { proposals: [{ id: 7, name: "Story Tool", ticker: "STORY", kind: "narrative", status: "new" }, { id: 9, name: HOSTILE, ticker: "", kind: "meme", status: "shortlisted" }] });
    expect(html).toContain('href="/proposals/7"');
    expect(html).toContain('href="/proposals/9"');
    expect(html).toContain("$STORY");
    expect(html).toContain("meme idea");
    expect(html).not.toContain("<img");
    expect(await draw(renderProposals, { proposals: [] })).not.toContain("narrative-proposals");
  });
});

describe("the sources", () => {
  const read = (path: string) => readFileSync(new URL(`../../app/${path}`, import.meta.url), "utf8");

  it("the app's lists equal the server's (the app does not import core)", () => {
    expect(TAG_OPTIONS.map((t) => t.value)).toEqual([...VERDICT_TAGS]);
    expect([...DIMENSION_OPTIONS]).toEqual([...RUBRIC_KEYS]);
    expect(SCORE_TAG_VALUES).toEqual([...SCORE_TAGS]);
    expect(VERDICT_NOTE_MAX).toBe(MAX_VERDICT_NOTE_CHARS);
    expect(VERDICT_FILTER.map((o) => o.value)).toEqual(["", ...VERDICTS, "none"]);
  });

  it("/narratives has the Verdict filter and the pill; /narratives/<id> has the form and the Proposal links; no v-html in any of them", () => {
    const list = read("pages/narratives/index.vue");
    expect(list).toContain("VERDICT_FILTER");
    expect(list).toContain('label: "Verdict filter"');
    expect(list).toContain("<VerdictPill");
    const page = read("pages/narratives/[id].vue");
    expect(page).toContain("<VerdictForm");
    expect(page).toContain("<NarrativeProposals");
    for (const f of ["pages/narratives/index.vue", "pages/narratives/[id].vue", "components/VerdictForm.vue", "components/VerdictPill.vue", "components/NarrativeProposals.vue", "utils/verdict.ts"]) expect(read(f), f).not.toContain("v-html");
  });
});
