import { readFileSync } from "node:fs";
import type { CurrentMetaApiRow, CurrentMetaResponse } from "@argus/core";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { expect, it } from "vitest";
import { currentMetaView } from "../../app/utils/meta.ts";

/** The Current Meta section: the real CurrentMeta.vue template, server-rendered over fixtures typed as the API's own response. */
const NOW = Date.parse("2026-11-15T20:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const counts = (tokens: number, creators: number) => ({ "6h": { tokens: Math.floor(tokens / 3), creators: Math.floor(creators / 3), migrations: 0, migrationsAfter60s: 0 }, "24h": { tokens, creators, migrations: 2, migrationsAfter60s: 1 } });

const subject = (label: string, symbol: string, cap: number, over: Partial<CurrentMetaApiRow> = {}): CurrentMetaApiRow => ({
  key: label.toLowerCase(),
  label,
  leader: { mint: "M1", name: label, symbol, marketCapUsd: cap, stale: false, url: `https://dexscreener.com/solana/${symbol}` },
  holding: false,
  enteredAt: ago(3 * 60),
  counts: counts(60, 45),
  topTokens: [{ mint: "T1", name: "Sidekick", symbol: "SIDE", marketCapUsd: 90_000 }],
  summary: `${label} is the story today`,
  summarySource: "llm",
  ...over,
});
const response = (metas: CurrentMetaApiRow[], watching: CurrentMetaApiRow[], computedAt: string | null = ago(8), coverageNote: string | null = null): CurrentMetaResponse => ({ computedAt, coverageNote, metas, watching });

const JENSEN = subject("Jensen Huang", "JENSEN", 2_400_000, { ideas: [{ id: 5, name: "Empty Chair", ticker: "CHAIR", angle: "The joke", status: "new", riskLabels: ["real person"], createdAt: ago(10), expiresAt: new Date(NOW + 5 * 3_600_000).toISOString() }] });
const GTA = subject("GTA 6", "GTA", 1_100_000, { holding: true });
const W1 = subject("Lucia From GTA 6", "LUCIA", 400_000);
const W2 = subject("Jensen Huang", "JENSEN", 90_000, { counts: counts(0, 0) });
const W3 = subject("Nyajira", "NYA", 60_000, { leader: { mint: "M3", name: "Nyajira", symbol: "NYA", marketCapUsd: 60_000, stale: true } });

type Render = (ctx: unknown, cache: unknown[]) => unknown;
async function load(file: string): Promise<Render> {
  const sfc = parse(readFileSync(new URL(`../../app/components/${file}`, import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: file, id: file });
  return new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;
}
const renderCurrent = await load("CurrentMeta.vue");

async function draw(payload: CurrentMetaResponse | null, home = false, nowMs = NOW): Promise<string> {
  const ctx = { view: currentMetaView(payload, nowMs), home };
  const app = createSSRApp({ render: () => renderCurrent(ctx, []) as ReturnType<typeof h> });
  app.component("UrlLink", { props: ["href", "label"], render() { return h("a", { class: "url-link", href: this.href }, this.label); } });
  app.component("NuxtLink", { props: ["to"], render() { return h("a", { class: "nuxt-link", href: this.to }, this.$slots.default?.()); } });
  return renderToString(app);
}

it("2 Metas and 3 Watching: each Meta shows its leader, cap, copies, since, summary, tokens and ideas; each Watching row says it is not a Meta and has no ideas", async () => {
  const html = await draw(response([JENSEN, GTA], [W1, W2, W3]));
  expect(html).toContain('data-test="current-meta-1"');
  expect(html).toContain('data-test="current-meta-2"');
  expect(html).not.toContain('data-test="current-meta-3"');
  for (const text of ["Jensen Huang", "Jensen Huang ($JENSEN)", "$2.4M", "45 creators copying in 24 h", "Meta since 3 hours ago", "Jensen Huang is the story today", "Sidekick ($SIDE) $90K", "Empty Chair", "Meme ideas", "computed 8 minutes ago"]) expect(html, text).toContain(text);
  expect(html).toContain('href="https://dexscreener.com/solana/JENSEN"');
  expect(html).not.toContain('data-test="meta-empty"');
  expect(html.match(/data-test="watching-\d"/g)).toHaveLength(3);
  expect(html.match(/Watching, not a Meta/g)).toHaveLength(3);
  expect(html).toContain("Not a Meta: a token is up but has not reached the entry market cap.");
  expect(html).toContain("Watching since 3 hours ago");
  expect(html).toContain("no copies launched in 24 h"); // W2
  expect(html.slice(html.indexOf('data-test="watching"'))).not.toContain("Meme ideas");
  expect(html).not.toMatch(/undefined|NaN|null/);
});

it("no Meta and 2 Watching: 'No Meta right now' stays and the Watching list shows", async () => {
  const html = await draw(response([], [W1, W3]));
  expect(html).toContain('data-test="meta-empty"');
  expect(html).toContain("No Meta right now");
  expect(html).not.toContain('data-test="metas"');
  expect(html.match(/data-test="watching-\d"/g)).toHaveLength(2);
  expect(html.indexOf("No Meta right now")).toBeLessThan(html.indexOf("Lucia From GTA 6"));
});

it("a run with nothing at all says 'No Meta right now' and no Watching block", async () => {
  const html = await draw(response([], []));
  expect(html).toContain("No Meta right now");
  expect(html).not.toContain('data-test="watching"');
});

it("before the first run (waiting) it shows one line and neither Metas, Watching nor 'No Meta right now'", async () => {
  for (const payload of [null, response([], [], null)]) {
    const html = await draw(payload);
    expect(html).toContain("No Meta run yet. The worker computes it every 15 minutes.");
    expect(html).not.toMatch(/No Meta right now|data-test="metas"|data-test="watching"/);
  }
});

it("a stale run (older than 2 h) says so and still shows its rows", async () => {
  const html = await draw(response([JENSEN], [W1], ago(5 * 60)));
  expect(html).toContain('class="note note-amber"');
  expect(html).toContain("The Meta run is stale (computed 5 hours ago).");
  expect(html).toContain('data-test="current-meta-1"');
  expect(await draw(response([JENSEN], []))).not.toContain("stale");
});

it("a holding Meta carries the cooling pill and says why; a stale leader cap says it is from the last answer; a normal Meta has neither", async () => {
  const cooling = await draw(response([GTA], []));
  expect(cooling).toContain('data-test="current-cooling"');
  expect(cooling).toContain(">cooling<");
  expect(cooling).toContain("Cooling: its leading token is below the market cap that makes a Meta, but still above the one that keeps it.");
  const old = await draw(response([subject("Old", "OLD", 3_000_000, { leader: { mint: "M", name: "Old", symbol: "OLD", marketCapUsd: 3_000_000, stale: true } })], []));
  expect(old).toContain("(cap as of the last answer)");
  const plain = await draw(response([JENSEN], [W3]));
  expect(plain).not.toContain("current-cooling");
  expect(plain.match(/cap as of the last answer/g)).toHaveLength(1); // only W3's leader is stale
});

it("the coverage note shows when the API sends one", async () => {
  expect(await draw(response([JENSEN], [], ago(8), "Only 1 h of data in the last 24 h"))).toContain("Only 1 h of data in the last 24 h");
  expect(await draw(response([JENSEN], []))).not.toContain("meta-coverage-note");
});

it("the home variant links to /meta and to /meta#all-launch-themes; /meta itself has no such links; no launch-theme list on either", async () => {
  const home = await draw(response([JENSEN], []), true);
  expect(home).toContain('href="/meta"');
  expect(home).toContain('href="/meta#all-launch-themes"');
  expect(home).not.toContain('data-test="meta-list"');
  const page = await draw(response([JENSEN], []));
  expect(page).not.toContain('href="/meta"');
});

it("hostile labels, ticker, leader name, summary and URLs are cut and shown as text, never as markup or a link", async () => {
  const evil = `<img src=x onerror=alert(1)></script><script>alert(1)</script> javascript:alert(1) ‮${"A".repeat(5_000)}`;
  const bad = subject(evil, evil, 3_000_000, {
    leader: { mint: "x", name: evil, symbol: evil, marketCapUsd: 3_000_000, stale: false, url: "javascript:alert(1)" },
    summary: evil,
    topTokens: [{ mint: "y", name: evil, symbol: evil, marketCapUsd: 1, url: "data:text/html,<script>alert(1)</script>" }, { mint: "z", name: "cred", symbol: "C", url: "https://user:pw@evil.example/" }],
    ideas: [{ id: 9, name: evil, ticker: evil, angle: evil, status: "new", riskLabels: [evil], createdAt: ago(1), expiresAt: null as never }],
  });
  const html = await draw(response([bad], [{ ...bad, ideas: undefined }]));
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("‮");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(html).not.toMatch(/href="(javascript|data):/);
  expect(html).not.toContain("evil.example");
  expect([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(["/proposals/9"]); // the only link: the idea's own card
  expect(html).toContain("…");
  expect(html.length).toBeLessThan(12_000);
  expect(html).not.toContain("A".repeat(300)); // every field is cut (the longest, an idea's angle, at 300)
});

it("the template has no raw HTML directive and no raw anchor; every external link is UrlLink", () => {
  const src = readFileSync(new URL("../../app/components/CurrentMeta.vue", import.meta.url), "utf8");
  expect(src).not.toContain("v-html");
  expect(src).not.toMatch(/<a[\s>]|\shref=/);
  expect(src).toContain("<UrlLink");
});
