import { readFileSync } from "node:fs";
import { IDEA_VERDICT_TAGS, MAX_IDEA_NOTE_CHARS } from "@argus/core";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import { IDEA_NOTE_MAX, IDEA_TAG_OPTIONS, ideaVerdictView, oneClickBody, whyBody, type IdeaVerdictPayload } from "../../app/utils/idea-verdict.ts";
import { submitVerdict, verdictPill } from "../../app/utils/verdict.ts";

/** War Room ticket 21: the real component templates (server-rendered) over fixtures typed as the API's own payload. */
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const HOSTILE = "<img src=x onerror=1> and <b>bold</b>";
const row = (id: number, verdict: string, over: Partial<IdeaVerdictPayload> = {}): IdeaVerdictPayload => ({ id, verdict, tags: [], note: "", playbookVersion: null, createdAt: ago(10), ...over });

type Render = (ctx: unknown, cache: unknown[]) => unknown;
async function load(file: string): Promise<Render> {
  const sfc = parse(readFileSync(new URL(`../../app/components/${file}`, import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: file, id: file });
  return new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;
}
const renderBlock = await load("IdeaVerdict.vue");
const renderPill = await load("VerdictPill.vue");

function draw(render: Render, ctx: Record<string, unknown>): Promise<string> {
  const app = createSSRApp({ render: () => render(ctx, []) as ReturnType<typeof h> });
  return renderToString(app);
}
const noop = () => undefined;
const block = (input: Partial<Parameters<typeof ideaVerdictView>[0]> = {}, extra: Record<string, unknown> = {}) =>
  draw(renderBlock, { view: ideaVerdictView({ history: [], tags: [], draft: "", nowMs: NOW, ...input }), busy: false, error: null, inputId: "idea-note-x", click: noop, toggleTag: noop, saveWhy: noop, close: noop, box: null, summaryEl: null, ...extra });

describe("the control", () => {
  it("with no verdict shows Good and Bad, 'No verdict yet' and no Add why", async () => {
    const html = await block();
    for (const t of ['data-test="idea-good"', 'data-test="idea-bad"', "No verdict yet.", "Good", "Bad"]) expect(html, t).toContain(t);
    expect(html).not.toContain("idea-why");
    expect(html).not.toContain("idea-verdict-history");
    expect(html).not.toMatch(/undefined|NaN|null/);
  });

  it("with a verdict shows it, marks its button pressed, and offers Add why with all ten tags and a 500-character counter", async () => {
    const html = await block({ history: [row(2, "bad", { tags: ["boring"], note: "meh" }), row(1, "good")] });
    const current = html.slice(html.indexOf('data-test="idea-verdict-current"'), html.indexOf('data-test="idea-why"'));
    for (const t of ["Bad", "Boring", "meh", "10 minutes ago"]) expect(current, t).toContain(t);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-test="idea-why-summary"');
    for (const tag of IDEA_VERDICT_TAGS) expect(html, tag).toContain(`data-test="idea-tag-${tag}"`);
    expect(html).toContain("0 / 500");
    expect(html.match(/data-test="idea-verdict-earlier"/g)).toHaveLength(1);
  });

  it("a note with markup shows as escaped text, never as an element, in the current verdict, the history and the textarea", async () => {
    const html = await block({ history: [row(2, "bad", { note: HOSTILE }), row(1, "good", { note: HOSTILE })], draft: HOSTILE });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>bold");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
  });

  it("a long note is cut in the view", async () => {
    const html = await block({ history: [row(1, "bad", { note: "w".repeat(500) })] });
    expect(html).not.toContain("w".repeat(400));
    expect(html).toContain("…");
  });

  it("shows the server's reason in an alert", async () => {
    expect(await block({}, { error: "The note is over 500 characters" })).toContain('role="alert"');
  });
});

describe("the view and the bodies", () => {
  it("Add why needs a current verdict and a note of at most 500 characters, and is off while busy", () => {
    const history = [row(1, "good")];
    expect(ideaVerdictView({ history: [], tags: [], draft: "", nowMs: NOW }).canSaveWhy).toBe(false);
    expect(ideaVerdictView({ history, tags: [], draft: "x".repeat(500), nowMs: NOW }).canSaveWhy).toBe(true);
    expect(ideaVerdictView({ history, tags: [], draft: "x".repeat(501), nowMs: NOW }).canSaveWhy).toBe(false);
    expect(ideaVerdictView({ history, tags: [], draft: "", nowMs: NOW, busy: true }).canSaveWhy).toBe(false);
    expect(ideaVerdictView({ history, tags: [], draft: "  twelve chars  ", nowMs: NOW }).counter).toBe("12 / 500");
  });

  it("a click sends the verdict alone; Add why sends the current verdict with tags and the note, and never a version or kind", () => {
    expect(oneClickBody("good")).toEqual({ verdict: "good" });
    expect(whyBody("bad", ["boring"], "n")).toEqual({ verdict: "bad", tags: ["boring"], note: "n" });
    for (const b of [oneClickBody("bad"), whyBody("bad", [], "")]) expect(Object.keys(b).some((k) => /playbook|kind/i.test(k))).toBe(false);
  });

  it("submitVerdict posts either body and reports the server's reason, without throwing", async () => {
    const sent: unknown[] = [];
    expect(await submitVerdict(async (b) => void sent.push(b), oneClickBody("good"))).toEqual({ ok: true });
    expect(sent).toEqual([{ verdict: "good" }]);
    const refused = await submitVerdict(async () => { throw Object.assign(new Error("x"), { statusMessage: "Only a meme idea gets an Idea verdict" }); }, oneClickBody("good"));
    expect(refused.ok).toBe(false);
  });
});

describe("the pill", () => {
  it("shows the current Idea verdict, and nothing when there is none", async () => {
    expect(await draw(renderPill, { pill: verdictPill("good", "Idea") })).toContain("Idea: Good");
    expect(await draw(renderPill, { pill: verdictPill("bad", "Idea") })).toContain('data-tone="bad"');
    expect(await draw(renderPill, { pill: verdictPill(null, "Idea") })).not.toContain("verdict-pill");
    expect(verdictPill("good")).toEqual({ label: "Verdict: Good", tone: "good" }); // the Narrative's pill is unchanged
  });
});

describe("the sources", () => {
  const read = (path: string) => readFileSync(new URL(`../../app/${path}`, import.meta.url), "utf8");

  it("the app's tag list and limit equal the server's (the app does not import core)", () => {
    expect(IDEA_TAG_OPTIONS.map((t) => t.value)).toEqual([...IDEA_VERDICT_TAGS]);
    expect(IDEA_NOTE_MAX).toBe(MAX_IDEA_NOTE_CHARS);
  });

  it("/proposals/<id> has the control for a meme idea and the pill; the list cards and the Narrative's links have the pill; no v-html in any of them", () => {
    const page = read("pages/proposals/[id].vue");
    expect(page).toMatch(/<IdeaVerdict v-if="isMeme"/);
    expect(page).toContain('<VerdictPill v-if="isMeme" label="Idea"');
    expect(read("pages/index.vue")).toContain('<VerdictPill v-if="p.kind === \'meme\'" label="Idea"');
    expect(read("components/NarrativeProposals.vue")).toContain('<VerdictPill v-if="p.kind === \'meme\'" label="Idea"');
    for (const f of ["pages/proposals/[id].vue", "pages/index.vue", "components/IdeaVerdict.vue", "components/VerdictPill.vue", "components/NarrativeProposals.vue", "utils/idea-verdict.ts", "utils/verdict.ts"]) {
      expect(read(f), f).not.toContain("v-html");
    }
    for (const f of ["components/IdeaVerdict.vue", "components/VerdictPill.vue", "utils/idea-verdict.ts"]) expect(read(f), f).not.toMatch(/href/i); // the only new files link nowhere (`pnpm lint` holds the rest)
  });
});
