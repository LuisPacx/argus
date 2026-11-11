import { readFileSync } from "node:fs";
import type { MetasResponse } from "@argus/core";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { expect, it } from "vitest";
import { metaView, META_POLL_MS } from "../../app/utils/meta.ts";

/** The section's rendering: the real CurrentMeta.vue template, server-rendered over fixtures typed as the API's own response. */
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
const response = (metas: ApiRow[], computedAt: string | null = ago(12)): MetasResponse => ({ window: "24h", computedAt, note: "n", windowTokens: 1000, windowMigrations: 30, baseMigrationRate: 0.03, metas });

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
const sfc = parse(readFileSync(new URL("../../app/components/CurrentMeta.vue", import.meta.url), "utf8"));
const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: "CurrentMeta.vue", id: "meta" });
const render = new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as (ctx: unknown, cache: unknown[]) => unknown;

async function section(payload: MetasResponse | null, opts: { wide?: boolean } = {}): Promise<string> {
  const view = metaView(payload, NOW);
  const app = createSSRApp({ render: () => render({ view, wide: opts.wide ?? false }, []) as ReturnType<typeof h> });
  app.component("UrlLink", { props: ["href", "label"], render() { return h("a", { class: "url-link", href: this.href }, this.label); } });
  return renderToString(app);
}

it("the section is titled 'Current Meta (last 24h)' and shows the ni hao, GTA VI and DeepSeek rows with every number", async () => {
  const html = await section(response([NI_HAO, GTA, DEEPSEEK]));
  expect(html).toContain("<h3 class=\"section-title\">Current Meta (last 24h)</h3>");
  for (const n of [1, 2, 3]) expect(html).toContain(`data-test="meta-${n}"`);
  // ni hao
  for (const text of ["woohao", "312 tokens", "190 creators", "15 migrations (unfiltered)", "21 creates per migration", "140 of 312 in the last 6 h", "accelerating", "first seen 14 hours ago", "woohao ($woohao) $13M", "NIHAO ($NIHAO) $2.1M", "咪好 ($咪好)", "Chinese-cat &#39;ni hao&#39; theme around Ansem&#39;s pfp; many launches, few migrations"]) expect(html, text).toContain(text);
  // GTA VI: steady, a templated line shown as is
  for (const text of ["GTA VI", "153 tokens", "110 creators", "31 migrations (unfiltered)", "4.9 creates per migration", "30 of 153 in the last 6 h", "steady", "first seen 22 hours ago", "GATO ($GATO) $8.5M", "top: GATO $8.5M"]) expect(html, text).toContain(text);
  // DeepSeek: fading, no market cap shown
  for (const text of ["DeepSeek ($DEEPSEEK)", "11 tokens", "10 migrations (unfiltered)", "1.1 creates per migration", "1 of 11 in the last 6 h", "fading"]) expect(html, text).toContain(text);
  expect(html).not.toMatch(/undefined|NaN|null/);
  expect(html).toContain("ranking from 12 minutes ago");
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
  expect(await section(null)).toContain("No Meta ranking yet. The worker computes it every 15 minutes.");
  expect(await section(response([], null))).toContain("No Meta ranking yet.");
  const none = await section(response([]));
  expect(none).toContain("No Meta stands out in the last 24 hours yet.");
  expect(none).not.toContain("<li");
  const stale = await section(response([DEEPSEEK], ago(5 * 60)));
  expect(stale).toContain('class="note note-amber"');
  expect(stale).toContain("The Meta ranking is stale (computed 5 hours ago).");
  expect(stale).toContain('data-test="meta-3"');
  expect(await section(response([DEEPSEEK]))).not.toContain("stale");
});

it("takes the old section's grid cell: spans both columns when the research panel is absent", async () => {
  expect(await section(response([DEEPSEEK]), { wide: true })).toContain("lg:col-span-2");
  expect(await section(response([DEEPSEEK]), { wide: false })).not.toContain("lg:col-span-2");
});

it("the sources: Latest Signals is gone from the home page, the new section polls every 60 s, and no link is drawn by hand", () => {
  const page = readFileSync(new URL("../../app/pages/index.vue", import.meta.url), "utf8");
  const component = readFileSync(new URL("../../app/components/CurrentMeta.vue", import.meta.url), "utf8");
  expect(page).not.toMatch(/Latest Signals|api\/signals|refreshSignals|signals\b.*useFetch|useFetch.*signals\b/);
  expect(page).toContain('<CurrentMeta :view="metaSection" :wide="!research" />');
  expect(page).toContain('useFetch("/api/metas", { query: { window: "24h", limit: META_ROWS }');
  expect(page).toContain("setInterval(() => void refreshMetas(), META_POLL_MS)");
  expect(page).not.toMatch(/refreshMetas\(\)[^;]*\], 3000/); // not part of the 3 s poll
  expect(META_POLL_MS).toBe(60_000);
  expect(component).not.toContain("v-html");
  expect(component).not.toMatch(/<a[\s>]|\shref=/); // a link is the UrlLink component or nothing
  expect(component).toContain("<UrlLink");
});
