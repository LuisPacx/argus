import { readFileSync } from "node:fs";
import { createSSRApp, h, type Component } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import { bareUrl, fmtWhen, signalsLabel } from "../../app/utils/format.ts";
import { safeHttpUrl } from "../../app/utils/safe-link.ts";

/** War Room ticket 02: every link drawn from stored or fetched data goes through safeHttpUrl. The real templates, server-rendered with a hostile URL at each site. */
const BAD = ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "https://user:pw@evil.example/"];
const GOOD = "https://ok.example/story";

type Render = (ctx: unknown, cache: unknown[]) => unknown;
async function load(file: string): Promise<Render> {
  const sfc = parse(readFileSync(new URL(`../../app/${file}`, import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: file, id: file });
  return new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;
}

// UrlLink is the real template (its script only declares props and imports the helpers it exposes to the template).
const urlLinkRender = await load("components/UrlLink.vue");
const UrlLink: Component = { props: ["href", "label"], setup: () => ({ safeHttpUrl, bareUrl }), render: urlLinkRender as never };
const narrativePage = await load("pages/narratives/[id].vue");
const whyPanel = await load("components/WhyPanel.vue");
const pickList = await load("components/PickList.vue");
const researchBriefs = await load("components/ResearchBriefs.vue");
const stub = (name: string) => ({ name, render: () => h("div", { "data-stub": name }) });

async function draw(render: Render, ctx: Record<string, unknown>): Promise<string> {
  const app = createSSRApp({ render: () => render({ safeHttpUrl, bareUrl, fmtWhen, signalsLabel, ...ctx }, []) as ReturnType<typeof h> });
  app.component("UrlLink", UrlLink);
  for (const n of ["NuxtLink", "VerdictForm", "NarrativeProposals", "ScoreBars"]) app.component(n, stub(n));
  return renderToString(app);
}

/** No anchor carries a refused href, and the visible text is still there. */
function expectNoLink(html: string, text: string): void {
  expect(html).not.toMatch(/href="(javascript|data):/i);
  expect(html).not.toMatch(/href="[^"]*(evil\.example|user:pw)/);
  expect(html).toContain(text);
}

describe("UrlLink", () => {
  it("renders a normal https URL as a link with rel noopener noreferrer", async () => {
    const html = await renderToString(createSSRApp({ render: () => h(UrlLink, { href: GOOD, label: "Story" }) }));
    expect(html).toContain(`href="${GOOD}"`);
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it.each(BAD)("shows %s as text with no anchor", async (bad) => {
    for (const label of [undefined, "Label"]) {
      const html = await renderToString(createSSRApp({ render: () => h(UrlLink, { href: bad, label }) }));
      expect(html).not.toContain("<a");
      expect(html).not.toContain("href");
      expect(html).toContain(label ?? "<span");
      expect(html).not.toContain("title=");
    }
  });
});

describe("the Narrative page Signals list", () => {
  const signal = (id: number, url: string) => ({ id, sourceLabel: "Feed", title: `Story ${id}`, url, publishedAt: "2026-11-20T10:00:00.000Z" });
  const n = (urls: string[]) => ({ id: 1, title: "T", summary: "", signalCount: urls.length, createdAt: "2026-11-20T10:00:00.000Z", lastSignalAt: "2026-11-20T10:00:00.000Z", changedMateriallyAt: "2026-11-20T10:00:00.000Z", verdicts: [], proposals: [], scores: [], runs: [], signals: urls.map((u, i) => signal(i, u)) });
  const page = narrativePage;
  const ctx = { nowMs: 0, pct: () => 0, proposalView: { shown: [], hiddenCount: 0 }, showClosed: false, closedToggleTo: "/narratives/1?closed=1" };

  it("links a normal URL and keeps rel noopener noreferrer", async () => {
    const html = await draw(page, { ...ctx, n: n([GOOD]) });
    expect(html).toContain(`href="${GOOD}"`);
    expect(html).toContain("noopener noreferrer");
    expect(html).toContain("Story 0");
  });

  it.each(BAD)("does not link %s but still shows the title", async (bad) => {
    expectNoLink(await draw(page, { ...ctx, n: n([bad]) }), "Story 0");
  });
});

describe("the Why this Proposal panel", () => {
  const panel = whyPanel;
  const view = (href: string | null) => ({ reason: "", interaction: "", signals: [{ title: "Sig", source: "Feed", href, when: "now", whenIso: "2026-11-20T10:00:00.000Z" }], score: null, evidence: [{ text: "Evi", href }] });

  it("links a normal URL with rel noopener noreferrer", async () => {
    const html = await draw(panel, { view: view(GOOD) });
    expect(html.match(new RegExp(`href="${GOOD}"`, "g"))).toHaveLength(2);
    expect(html).toContain("noopener noreferrer");
  });

  it.each(BAD)("does not link %s in Signals or evidence", async (bad) => {
    const html = await draw(panel, { view: view(bad) });
    expectNoLink(html, "Sig");
    expect(html).toContain("Evi");
  });
});

describe("the Picks list and the Research briefs", () => {
  const picks = pickList;
  const briefs = researchBriefs;
  const pickView = (href: string | null) => ({ empty: "", summary: "s", rate: null, rows: [{ id: 1, title: "Coin", withdrawn: false, canWithdraw: false, bonded: false, bondedLabel: "b", topic: "", picked: "", facts: [], outcome: { label: "o", detail: "d", marks: [] }, reason: "", ca: "CA1", href }] });
  const briefView = (href: string | null) => ({ empty: "", rows: [{ id: 1, topic: "T", statusClass: "", status: "done", asked: "", cost: "", detail: "", brief: { story: "S", sources: [{ title: "Src", href, host: null }], coins: [{ title: "C", bondedClass: "", bonded: "", facts: "", note: "", ca: "CA2", href }], noCoins: "", freeNames: [], noFreeNames: "", xNote: "" }, ideas: null }] });

  it("link a normal URL", async () => {
    expect(await draw(picks, { view: pickView(GOOD) })).toContain(`href="${GOOD}"`);
    const html = await draw(briefs, { view: briefView(GOOD) });
    expect(html.match(new RegExp(`href="${GOOD}"`, "g"))).toHaveLength(2);
  });

  it.each(BAD)("do not link %s", async (bad) => {
    expectNoLink(await draw(picks, { view: pickView(bad) }), "CA1");
    const html = await draw(briefs, { view: briefView(bad) });
    expectNoLink(html, "Src");
    expect(html).toContain("CA2");
  });
});
