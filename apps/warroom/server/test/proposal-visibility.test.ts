import { readFileSync } from "node:fs";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import { HIDDEN_STATUSES, proposalVisibility, showHiddenFromQuery } from "../../app/utils/proposal-visibility.ts";
import { PROPOSAL_STATUSES } from "@argus/core";

/** War Room ticket 20: closed and dismissed Proposals are hidden by default, with a toggle. */
const p = (id: number, status: string) => ({ id, status });
const list = [p(1, "new"), p(2, "closed"), p(3, "dismissed"), p(4, "launched"), p(5, "closed")];

describe("proposalVisibility", () => {
  it("hides closed and dismissed by default and counts them", () => {
    const v = proposalVisibility(list, { status: "", showHidden: false });
    expect(v.shown.map((x) => x.id)).toEqual([1, 4]);
    expect(v.hiddenCount).toBe(3);
    expect(v.toggle).toBe(true);
  });

  it("shows everything when the toggle is on, and still offers the toggle back", () => {
    const v = proposalVisibility(list, { status: "", showHidden: true });
    expect(v.shown).toHaveLength(5);
    expect(v.hiddenCount).toBe(3);
    expect(v.toggle).toBe(true);
  });

  it("an explicit closed or dismissed status filter shows those rows and offers no toggle", () => {
    const v = proposalVisibility([p(2, "closed"), p(5, "closed")], { status: "closed", showHidden: false });
    expect(v.shown).toHaveLength(2);
    expect(v.hiddenCount).toBe(0);
    expect(v.toggle).toBe(false);
  });

  it("no toggle when nothing is closed or dismissed", () => {
    const v = proposalVisibility([p(1, "new")], { status: "", showHidden: false });
    expect(v).toMatchObject({ hiddenCount: 0, toggle: false });
  });

  it("the hidden statuses are real statuses", () => {
    for (const s of HIDDEN_STATUSES) expect(PROPOSAL_STATUSES).toContain(s);
  });

  it("reads the closed query", () => {
    expect(showHiddenFromQuery("1")).toBe(true);
    expect(showHiddenFromQuery(undefined)).toBe(false);
    expect(showHiddenFromQuery("0")).toBe(false);
  });
});

type Render = (ctx: unknown, cache: unknown[]) => unknown;
async function load(file: string): Promise<Render> {
  const sfc = parse(readFileSync(new URL(`../../app/components/${file}`, import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: file, id: file });
  return new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;
}
function draw(render: Render, ctx: Record<string, unknown>): Promise<string> {
  const app = createSSRApp({ render: () => render(ctx, []) as ReturnType<typeof h> });
  app.component("NuxtLink", { props: ["to"], render() { return h("a", { href: this.to }, this.$slots.default?.()); } });
  app.component("ShowClosedToggle", { props: ["count", "showing", "to"], render() { return h("a", { "data-test": "show-closed", href: this.to }, `${this.count}`); } });
  app.component("StatusPill", { props: ["status"], render() { return h("span", this.status); } });
  return renderToString(app);
}

describe("the toggle component and its users", () => {
  const read = (path: string) => readFileSync(new URL(`../../app/${path}`, import.meta.url), "utf8");

  it("renders a link with the hidden count, and the Hide text when on", async () => {
    const render = await load("ShowClosedToggle.vue");
    const off = await draw(render, { count: 3, showing: false, to: "/?closed=1" });
    expect(off).toContain('data-test="show-closed"');
    expect(off).toContain("Show closed and dismissed (3)");
    expect(off).toContain('href="/?closed=1"');
    expect(off).toContain('aria-pressed="false"');
    const on = await draw(render, { count: 3, showing: true, to: "/" });
    expect(on).toContain("Hide closed and dismissed (3)");
    expect(on).toContain('aria-pressed="true"');
  });

  it("the Narrative block keeps a toggle when every Proposal is hidden", async () => {
    const render = await load("NarrativeProposals.vue");
    const html = await draw(render, { proposals: [], hiddenCount: 2, showing: false, toggleTo: "/narratives/1?closed=1" });
    expect(html).toContain("narrative-proposals");
    expect(html).toContain("show-closed");
  });

  it("the home page and the Narrative page use the split", () => {
    const home = read("pages/index.vue");
    expect(home).toContain("proposalVisibility(");
    expect(home).toContain("<ShowClosedToggle");
    expect(read("pages/narratives/[id].vue")).toContain("proposalVisibility(");
  });
});
