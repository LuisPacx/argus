import { readFileSync } from "node:fs";
import type { HotNowResponse, MetasResponse } from "@argus/core";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { expect, it } from "vitest";
import { hotView, HOT_POLL_MS } from "../../app/utils/hot.ts";
import { metaView } from "../../app/utils/meta.ts";

/** The Hot now panel's rendering: the real HotNow.vue and MetaList.vue templates, server-rendered over fixtures typed as the API's own responses. */
const NOW = Date.parse("2026-11-12T15:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const counts = (tokens: number, creators: number, migrations: number, migrationsAfter60s = 0) => ({ tokens, creators, migrations, migrationsAfter60s });

type Item = HotNowResponse["items"][number];
const item = (over: Partial<Item> = {}, meta: Partial<Item["meta"]> = {}): Item => ({
  reason: "entered top 5",
  raisedAt: ago(12),
  meta: {
    rank: 2,
    label: "jensen",
    firstSeenAt: ago(600),
    counts: { "6h": counts(90, 60, 4, 2), "24h": counts(256, 141, 12, 5) },
    migrationRate: 12 / 256,
    createsPerMigration: 256 / 12,
    topTokens: [
      { mint: "Ja", name: "JENSEN", symbol: "JENSEN", marketCapUsd: 1_200_000, url: "https://dexscreener.com/solana/Ja" },
      { mint: "Jb", name: "Leather Jacket", symbol: "JACKET" },
    ],
    summary: "A viral concert-jumbotron clip and the Nvidia CEO story",
    summarySource: "llm",
    ...meta,
  },
  news: [
    { title: "Nvidia CEO Jensen Huang takes the stage", sourceLabel: "Wired", url: "https://example.com/jensen", publishedAt: ago(180) },
    { title: "Jensen at the keynote", sourceLabel: "Trends", url: "", publishedAt: ago(60) },
  ],
  ...over,
});
const payload = (items: Item[]): HotNowResponse => ({ computedAt: ago(5), items });

type Render = (ctx: unknown, cache: unknown[]) => unknown;
async function load(file: string): Promise<Render> {
  const sfc = parse(readFileSync(new URL(`../../app/components/${file}`, import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: file, id: file });
  return new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;
}
const renderHot = await load("HotNow.vue");
const renderList = await load("MetaList.vue");

async function draw(render: Render, view: unknown): Promise<string> {
  const app = createSSRApp({ render: () => render({ view }, []) as ReturnType<typeof h> });
  app.component("UrlLink", { props: ["href", "label"], render() { return h("a", { class: "url-link", href: this.href }, this.label); } });
  app.component("NuxtLink", { props: ["to"], render() { return h("a", { class: "nuxt-link", href: this.to }, this.$slots.default?.()); } });
  return renderToString(app);
}
const panel = (p: HotNowResponse | null) => draw(renderHot, hotView(p, NOW));

it("shows the Meta label and summary, the reason, the matching news, the top tokens and the migrations", async () => {
  const html = await panel(payload([item()]));
  for (const text of ["Hot now", "jensen", "entered top 5", "raised 12 minutes ago", "A viral concert-jumbotron clip and the Nvidia CEO story", "141 creators", "256 tokens", "12 migrations (unfiltered)", "5 after 60 s", "JENSEN ($JENSEN) $1.2M", "Leather Jacket ($JACKET)", "In the news (context)", "Nvidia CEO Jensen Huang takes the stage", "Wired, 3 hours ago", "Jensen at the keynote", "Trends, 1 hour ago"]) expect(html, text).toContain(text);
  expect(html).toContain('href="/meta#meta-jensen"');
  expect(html).not.toMatch(/undefined|NaN|null/);
});

it("links only http(s) URLs: a token and a headline with a URL link, a headline without one is text", async () => {
  const html = await panel(payload([item()]));
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  expect(hrefs).toEqual(["/meta#meta-jensen", "https://dexscreener.com/solana/Ja", "https://example.com/jensen"]);
});

it("renders nothing for no live event, before the first run and for a payload without items", async () => {
  expect(await panel(payload([]))).not.toContain("data-test=\"hot-now\"");
  expect(await panel(null)).not.toContain("hot-now");
  expect(await panel({ computedAt: null, items: [] })).not.toContain("hot-now");
});

it("a news-less event shows no news section, and a field missing from the payload is omitted", async () => {
  const bare = item({ news: [], reason: "" }, { summary: "", topTokens: [], counts: { "6h": counts(1, 1, 0), "24h": {} as never } });
  const html = await panel(payload([bare]));
  expect(html).toContain("jensen");
  expect(html).not.toMatch(/In the news|data-test="hot-summary"|data-test="hot-tokens"|data-test="hot-reason"|undefined|NaN/);
});

it("hostile labels, token names, headlines, summaries and URLs render as clamped text, with no unsafe anchor and no raw HTML", async () => {
  const evil = `<img src=x onerror=alert(1)></script><script>alert(1)</script> javascript:alert(1) ${"A".repeat(10_000)}`;
  const html = await panel(
    payload([
      item(
        {
          reason: evil,
          news: [
            { title: evil, sourceLabel: evil, url: "javascript:alert(1)", publishedAt: ago(5) },
            { title: "ok", sourceLabel: "x", url: "data:text/html,<script>alert(1)</script>", publishedAt: ago(5) },
            { title: "cred", sourceLabel: "x", url: "https://user:pw@evil.example/", publishedAt: ago(5) },
          ],
        },
        {
          label: evil,
          summary: evil,
          topTokens: [
            { mint: "x", name: evil, symbol: evil, marketCapUsd: 1, url: "javascript:alert(1)" },
            { mint: "y", name: "ok", symbol: "OK", url: "data:text/html,<script>alert(1)</script>" },
          ],
        },
      ),
    ]),
  );
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(html).not.toMatch(/href="(javascript|data):/);
  expect(html).not.toContain("user:pw");
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
  for (const href of hrefs) expect(href).toMatch(/^\/meta#[\p{L}\p{N}-]+$/u);
  expect(html.length).toBeLessThan(6_000);
  expect(html).toContain("…");
});

it("shows at most five headlines and five events' worth of rows as the API sent them", async () => {
  const news = Array.from({ length: 9 }, (_, i) => ({ title: `Headline ${i}`, sourceLabel: "S", url: "", publishedAt: ago(i + 1) }));
  const html = await panel(payload([item({ news })]));
  expect(html.match(/Headline \d/g)).toHaveLength(5);
});

it("/meta marks a Meta hot while its event is live, with the reason and when", async () => {
  const row: MetasResponse["metas"][number] = { ...item().meta, hot: { reason: "creators 70 to 148 in 1 h", raisedAt: ago(30) } };
  const quiet: MetasResponse["metas"][number] = { ...item().meta, rank: 3, label: "calm" };
  const view = metaView({ window: "24h", computedAt: ago(5), note: "n", windowTokens: 1, windowMigrations: 0, baseMigrationRate: 0, coverage: null, coverageNote: null, metas: [row, quiet] }, NOW, { rows: 50 });
  const html = await draw(renderList, view);
  expect(html).toContain('data-test="meta-hot"');
  expect(html).toContain("Hot now: creators 70 to 148 in 1 h, 30 minutes ago");
  expect(html.match(/data-test="meta-hot"/g)).toHaveLength(1);
});

it("the sources: the home page and /meta draw the panel from /api/hot-metas and poll it; no raw links or v-html", () => {
  const read = (p: string) => readFileSync(new URL(`../../app/${p}`, import.meta.url), "utf8");
  const home = read("pages/index.vue");
  const page = read("pages/meta.vue");
  expect(home).toContain('<HotNow :view="hotSection" />');
  expect(home).toContain('useFetch("/api/hot-metas"');
  expect(home).toContain("setInterval(() => void refreshHot(), HOT_POLL_MS)");
  expect(page).toContain('<HotNow :view="hotSection" />');
  expect(page).toContain('useFetch("/api/hot-metas"');
  expect(HOT_POLL_MS).toBe(60_000);
  const src = read("components/HotNow.vue");
  expect(src).not.toContain("v-html");
  expect(src).not.toMatch(/<a[\s>]|\shref=/);
  expect(src).toContain("<UrlLink");
});
