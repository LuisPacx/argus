import { readFileSync } from "node:fs";
import type { MetasResponse } from "@argus/core";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { expect, it } from "vitest";
import { metaView, META_POLL_MS } from "../../app/utils/meta.ts";

/** The section's rendering: the real MetaList.vue template, server-rendered over fixtures typed as the API's own response. */
const NOW = Date.parse("2026-11-11T20:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const counts = (tokens: number, creators: number, migrations: number, migrationsAfter60s = 0) => ({ tokens, creators, migrations, migrationsAfter60s });

type ApiRow = MetasResponse["metas"][number];
const apiRow = (over: Partial<ApiRow> & Pick<ApiRow, "rank" | "label">): ApiRow => ({
  firstSeenAt: ago(14 * 60),
  counts: { "6h": counts(10, 8, 0), "24h": counts(40, 30, 2) },
  migrationRate: 0.05,
  createsPerMigration: 20,
  topTokens: [],
  summary: "A line",
  summarySource: "llm",
  ...over,
});
const response = (metas: ApiRow[], computedAt: string | null = ago(12), coverageNote: string | null = null): MetasResponse => ({ window: "24h", computedAt, note: "n", windowTokens: 1000, windowMigrations: 30, baseMigrationRate: 0.03, coverage: null, coverageNote, metas });

const NI_HAO = apiRow({
  rank: 1,
  label: "woohao",
  counts: { "6h": counts(140, 90, 4), "24h": counts(312, 190, 15, 6) },
  migrationRate: 15 / 312,
  createsPerMigration: 312 / 15,
  topTokens: [
    { mint: "Ma", name: "woohao", symbol: "woohao", marketCapUsd: 13_000_000, url: "https://dexscreener.com/solana/Ma" },
    { mint: "Mb", name: "NIHAO", symbol: "NIHAO", marketCapUsd: 2_100_000 },
    { mint: "Mc", name: "咪好", symbol: "咪好" },
  ],
  summary: "Chinese-cat 'ni hao' theme around Ansem's pfp; many launches, few migrations",
});
const GTA = apiRow({
  rank: 2,
  label: "GTA VI",
  counts: { "6h": counts(30, 25, 9), "24h": counts(153, 110, 31, 12) },
  createsPerMigration: 153 / 31,
  firstSeenAt: ago(22 * 60),
  topTokens: [{ mint: "Ga", name: "GATO", symbol: "GATO", marketCapUsd: 8_500_000 }],
  summary: "153 tokens from 110 creators in 24 h, 31 migrated (unfiltered); top: GATO $8.5M",
  summarySource: "template",
});
const DEEPSEEK = apiRow({ rank: 3, label: "DeepSeek", counts: { "6h": counts(1, 1, 1), "24h": counts(11, 9, 10, 8) }, createsPerMigration: 1.1, topTokens: [{ mint: "Da", name: "DeepSeek", symbol: "DEEPSEEK" }] });

// Compile the real template (no build plugin in the test setup) and server-render it with UrlLink stubbed to the anchor it draws.
type Render = (ctx: unknown, cache: unknown[]) => unknown;
async function load(file: string): Promise<Render> {
  const sfc = parse(readFileSync(new URL(`../../app/components/${file}`, import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: file, id: file });
  return new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;
}
const renderList = await load("MetaList.vue");

async function draw(render: Render, payload: MetasResponse | null, opts: { window?: "6h" | "24h"; rows?: number } = {}): Promise<string> {
  const view = metaView(payload, NOW, opts);
  const app = createSSRApp({ render: () => render({ view }, []) as ReturnType<typeof h> });
  app.component("UrlLink", { props: ["href", "label"], render() { return h("a", { class: "url-link", href: this.href }, this.label); } });
  app.component("NuxtLink", { props: ["to"], render() { return h("a", { class: "nuxt-link", href: this.to }, this.$slots.default?.()); } });
  return renderToString(app);
}
/** The /meta page body: every Meta of the run. */
const section = (payload: MetasResponse | null, opts: { window?: "6h" | "24h" } = {}) => draw(renderList, payload, { rows: 50, ...opts });

it("the /meta list shows the ni hao, GTA VI and DeepSeek rows with every number, each row id'd by its anchor", async () => {
  const html = await section(response([NI_HAO, GTA, DEEPSEEK]));
  for (const n of [1, 2, 3]) expect(html).toContain(`data-test="meta-${n}"`);
  for (const id of ["meta-woohao", "meta-gta-vi", "meta-deepseek"]) expect(html).toContain(`id="${id}"`);
  expect(html).toContain("6 after 60 s");
  // ni hao
  for (const text of ["woohao", "312 tokens", "190 creators", "15 migrations (unfiltered)", "21 creates per migration", "140 of 312 in the last 6 h", "accelerating", "first seen 14 hours ago", "woohao ($woohao) $13M", "NIHAO ($NIHAO) $2.1M", "咪好 ($咪好)"]) expect(html, text).toContain(text);
  // counts only: the stored summary lines belong to the Current Meta, not to the launch-theme list
  for (const text of ["Chinese-cat", "top: GATO", "meta-summary", "meta-ideas", "A line"]) expect(html, text).not.toContain(text);
  // GTA VI: steady, a templated line shown as is
  for (const text of ["GTA VI", "153 tokens", "110 creators", "31 migrations (unfiltered)", "4.9 creates per migration", "30 of 153 in the last 6 h", "steady", "first seen 22 hours ago", "GATO ($GATO) $8.5M"]) expect(html, text).toContain(text);
  // DeepSeek: fading, no market cap shown
  for (const text of ["DeepSeek ($DEEPSEEK)", "11 tokens", "10 migrations (unfiltered)", "1.1 creates per migration", "1 of 11 in the last 6 h", "fading"]) expect(html, text).toContain(text);
  expect(html).not.toMatch(/undefined|NaN|null/);
});

it("the /meta list shows the coverage note above the list when the API sends one, and nothing when it is null", async () => {
  const note = "Only 1 h of data in the last 24 h";
  const html = await section(response([NI_HAO], ago(12), note));
  expect(html).toContain('data-test="meta-coverage-note"');
  expect(html).toContain(note);
  expect(html.indexOf(note)).toBeLessThan(html.indexOf("woohao"));
  const quiet = await section(response([NI_HAO]));
  expect(quiet).not.toContain("meta-coverage-note");
  expect(quiet).toContain("woohao"); // the list still shows
  expect(await section(response([NI_HAO], ago(12), note), { window: "6h" })).toContain(note); // the note travels with the window the API answered for
});

it("a token links only where the API supplied a DexScreener URL, drawn by UrlLink", async () => {
  const html = await section(response([NI_HAO]));
  expect(html.match(/<a /g)).toHaveLength(1);
  expect(html).toContain('href="https://dexscreener.com/solana/Ma"');
});

it("a field missing from the payload is omitted, not shown", async () => {
  const bare = apiRow({ rank: 1, label: "Bare", createsPerMigration: null, topTokens: [], summary: "", firstSeenAt: "nonsense" });
  const html = await section(response([bare]));
  expect(html).toContain("Bare");
  expect(html).not.toMatch(/creates per migration|first seen|data-test="meta-tokens"|data-test="meta-summary"|undefined|NaN/);
});

it("hostile labels, token names, summaries and URLs render as clamped text, with no unsafe anchor and no raw HTML", async () => {
  const evil = `<img src=x onerror=alert(1)></script><script>alert(1)</script> javascript:alert(1) ${"A".repeat(10_000)}`;
  const row = apiRow({
    rank: 1,
    label: evil,
    summary: evil,
    topTokens: [
      { mint: "x", name: evil, symbol: evil, marketCapUsd: 1, url: "javascript:alert(1)" },
      { mint: "y", name: "ok", symbol: "OK", url: "data:text/html,<script>alert(1)</script>" },
      { mint: "z", name: "cred", symbol: "C", url: "https://user:pw@evil.example/" },
    ],
  });
  const html = await section(response([row]));
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(html).not.toMatch(/<a /);
  expect(html).not.toMatch(/href="(javascript|data):/);
  expect(html.length).toBeLessThan(6_000);
  expect(html).toContain("…");
});

it("shows its message before the first run, when a run has no Meta, and when the run is stale", async () => {
  expect(await section(null)).toContain("No launch-theme ranking yet. The worker computes it every 15 minutes.");
  expect(await section(response([], null))).toContain("No launch-theme ranking yet.");
  const none = await section(response([]));
  expect(none).toContain("No launch theme stands out in the last 24 hours yet.");
  expect(none).not.toContain("<li");
  const stale = await section(response([DEEPSEEK], ago(5 * 60)));
  expect(stale).toContain('class="note note-amber"');
  expect(stale).toContain("The launch-theme ranking is stale (computed 5 hours ago).");
  expect(stale).toContain('data-test="meta-3"');
  expect(await section(response([DEEPSEEK]))).not.toContain("stale");
});

it("the window toggle: the 6 h view's numbers come from the 6 h counts", async () => {
  const html = await section(response([NI_HAO]), { window: "6h" });
  expect(html).toContain("140 tokens");
  expect(html).toContain("90 creators");
  expect(html).not.toContain("312 tokens");
});

it("the sources: the home page has the Current Meta and no launch-theme list; /meta has it first, then the closed All launch themes; both poll every 60 s; no raw links or v-html", () => {
  const read = (p: string) => readFileSync(new URL(`../../app/${p}`, import.meta.url), "utf8");
  const home = read("pages/index.vue");
  const page = read("pages/meta.vue");
  expect(home).not.toMatch(/Latest Signals|api\/signals|refreshSignals|MetaStrip|MetaList|"\/api\/metas"/);
  expect(home).toContain('<CurrentMeta :view="metaSection" home />');
  expect(home).toContain('useFetch("/api/current-meta"');
  expect(home).toContain("setInterval(() => void refreshMetas(), META_POLL_MS)");
  expect(home).not.toMatch(/refreshMetas\(\)[^;]*\], 3000/); // not part of the 3 s poll
  expect(page).toContain("setInterval(() => void Promise.all([refreshMetas(), refreshCurrent(), refreshAngles()]), META_POLL_MS)"); // the angle requests ride the same 60 s poll (ticket 11)
  expect(page).toContain('"/api/metas"');
  expect(page).toContain('"/api/current-meta"');
  expect(page).toContain("<MetaList");
  expect(page).toMatch(/<details id="all-launch-themes"[^>]*>/);
  expect(page).not.toMatch(/<details[^>]*\sopen[\s>=]/); // closed by default
  expect(page.indexOf("<CurrentMeta")).toBeLessThan(page.indexOf("<details"));
  expect(page.indexOf("<details")).toBeLessThan(page.indexOf("<SegmentedLinks")); // the window toggle sits inside the list
  expect(read("app.vue")).toContain('{ to: "/meta", label: "Meta" }');
  expect(META_POLL_MS).toBe(60_000);
  for (const file of ["components/MetaList.vue", "components/CurrentMeta.vue", "components/AngleForm.vue", "pages/meta.vue"]) {
    const src = read(file);
    expect(src, file).not.toContain("v-html");
    expect(src, file).not.toMatch(/<a[\s>]|\shref=/); // an external link is UrlLink, an internal one NuxtLink
  }
  expect(read("components/MetaList.vue")).toContain("<UrlLink");
});
