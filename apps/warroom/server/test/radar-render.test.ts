import { readFileSync } from "node:fs";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import { alertText, radarPageView, radarStripView, sourceLabel, TERM_CLAMP, type RadarPayload, type RadarPayloadSource, type RadarPayloadTrend } from "../../app/utils/radar.ts";

/** The Radar list: the real RadarPanel.vue and RadarStrip.vue templates, server-rendered over a payload typed as the API's own response. */
const NOW = Date.parse("2026-11-19T16:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const token = (name: string, cap: number | null = 90_000) => ({ name, symbol: name.slice(0, 5).toUpperCase(), url: "https://dexscreener.com/solana/abc", marketCapUsd: cap, liquidityUsd: 20_000 });
const trend = (over: Partial<RadarPayloadTrend> = {}): RadarPayloadTrend => ({
  id: 7,
  term: "alpha bear",
  firstSeen: ago(50),
  lastSeen: ago(5),
  score: 30,
  side: "untokenized",
  sideAt: ago(44),
  trafficText: "50000+",
  trafficMin: 50_000,
  newsTitle: "A bear walks into a bar",
  newsUrl: "https://news.example/bear",
  lastChecked: ago(44),
  localCreates: 12,
  localCreators: 9,
  traceAt: ago(44),
  liveCount: 0,
  biggest: null,
  lookalikes: [],
  lookalikeCount: 0,
  ...over,
});
const source = (over: Partial<RadarPayloadSource> = {}): RadarPayloadSource => ({ source: "radar:google:US", status: "ok", reason: "", lastOk: ago(5), since: ago(300), ...over });
const payload = (trends: RadarPayloadTrend[] = [trend()], over: Partial<RadarPayload> = {}): RadarPayload => ({
  enabled: true,
  trends,
  sources: [source()],
  alerts: [],
  lastGoodPollAt: ago(5),
  counts: { shown: trends.length, untokenized: trends.filter((t) => t.side === "untokenized").length },
  ...over,
});

type Render = (ctx: unknown, cache: unknown[]) => unknown;
async function load(file: string): Promise<Render> {
  const sfc = parse(readFileSync(new URL(`../../app/components/${file}`, import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: file, id: file });
  return new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;
}
const renderPanel = await load("RadarPanel.vue");
const renderStrip = await load("RadarStrip.vue");

function app(render: () => unknown) {
  const a = createSSRApp({ render: () => render() as ReturnType<typeof h> });
  a.component("UrlLink", { props: ["href", "label"], render() { return h("a", { class: "url-link", href: this.href }, this.label); } });
  a.component("NuxtLink", { props: ["to"], render() { return h("a", { href: this.to }, this.$slots.default?.()); } });
  return a;
}
async function draw(p: RadarPayload | null, nowMs = NOW): Promise<string> {
  const view = radarPageView(p, nowMs);
  return renderToString(app(() => renderPanel({ view }, [])));
}
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

describe("a Trend", () => {
  it("is one row with the term, the coin-side state, the traffic, the age, the creates line, the news headline as a link and the source", async () => {
    const html = await draw(payload());
    expect(html).toContain('data-test="trend-7"');
    for (const text of ["alpha bear", "Untokenized", "50000+ searches", "first seen 50 minutes ago", "No live token found.", "12 creates in 48 h by 9 creators; local creates are a partial view.", "checked 44 minutes ago", "A bear walks into a bar", "Google Trends (US)", "Data source: Google Trends", "1 Trend shown, 1 untokenized."]) expect(html, text).toContain(text);
    expect(hrefs(html)).toEqual(["https://news.example/bear"]);
    expect(html).not.toMatch(/undefined|NaN|null/);
  });

  it("shows the biggest live token with a link, and the lookalikes with their reasons", async () => {
    const t = trend({ side: "contested", liveCount: 2, biggest: token("Alpha Bear Coin", 45_000), lookalikes: [{ ...token("Boomazoom", 131_000), liquidityUsd: 4, reason: "pool $4, cap $131K: drained or fake" }], lookalikeCount: 3 });
    const html = await draw(payload([t]));
    expect(html).toContain("Contested");
    expect(html).toContain("Biggest live token: Alpha Bear Coin ($ALPHA) at $45K (2 live)");
    expect(html).toContain("Lookalike, not counted: Boomazoom ($BOOMA) at $131K: pool $4, cap $131K: drained or fake");
    expect(html).toContain("and 2 more lookalikes");
    expect(hrefs(html)).toEqual(["https://dexscreener.com/solana/abc", "https://news.example/bear"]);
  });

  it("a Trend that is not traced says so and shows its last good check", async () => {
    const html = await draw(payload([trend({ side: "not traced", biggest: token("Old coin", 12_000), liveCount: 1, traceAt: ago(130) })]));
    expect(html).toContain("Not traced");
    expect(html).toContain("As of the last good check, 2 hours ago.");
    expect(await draw(payload([trend({ side: "unchecked", lastChecked: null, traceAt: null, localCreates: null, localCreators: null })]))).toContain("Not checked yet");
    expect(await draw(payload([trend({ side: "unchecked", lastChecked: null, traceAt: null, localCreates: null, localCreators: null })]))).toContain("Local creates not read yet");
  });

  it("taken and tokenizing Trends are folded below the others", async () => {
    const html = await draw(payload([trend({ id: 1, term: "open one" }), trend({ id: 2, term: "taken one", side: "taken", liveCount: 1, biggest: token("Coin", 99_000) }), trend({ id: 3, term: "moving one", side: "tokenizing" })]));
    expect(html).toContain('data-test="radar-folded"');
    expect(html).toContain("Already has a coin or is being tokenized (2)");
    expect(html.indexOf("open one")).toBeLessThan(html.indexOf("Already has a coin"));
    expect(html.indexOf("Already has a coin")).toBeLessThan(html.indexOf("taken one"));
    expect(html).toMatch(/<details[^>]*data-test="radar-folded"/);
    expect(html).toContain("<summary");
    // nothing is folded when nothing has a coin
    expect(await draw(payload([trend()]))).not.toContain("radar-folded");
  });

  it("keeps the order the API gave: highest score first", async () => {
    const html = await draw(payload([trend({ id: 1, term: "first term" }), trend({ id: 2, term: "second term" })]));
    expect(html.indexOf("first term")).toBeLessThan(html.indexOf("second term"));
  });
});

describe("hostile text", () => {
  const EVIL = `<img src=x onerror=1>\n<script>alert(1)</script> javascript:alert(1) ‮${"A".repeat(100_000)}`;

  it("a term renders as one clamped line of escaped text", async () => {
    const html = await draw(payload([trend({ term: EVIL, newsTitle: EVIL })]));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("‮");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).not.toContain("A".repeat(300));
    expect(html.length).toBeLessThan(12_000);
    const shown = html.match(/data-test="trend-term">([^<]*)</)![1]!;
    expect(shown).not.toContain("\n");
    expect([...shown].length).toBeLessThanOrEqual(TERM_CLAMP + 40);
    expect(radarPageView(payload([trend({ term: EVIL })]), NOW).groups[0]!.rows[0]!.term.length).toBeLessThanOrEqual(TERM_CLAMP + 1);
  });

  it("a token name, a reason and a source reason are text too", async () => {
    const t = trend({ side: "contested", liveCount: 1, biggest: token(EVIL), lookalikes: [{ ...token(EVIL), reason: EVIL }], lookalikeCount: 1 });
    const html = await draw(payload([t], { sources: [source({ status: "down", reason: EVIL, since: ago(10) })] }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html.length).toBeLessThan(20_000);
  });

  it.each([
    ["a javascript: address", "javascript:alert(1)"],
    ["a data: address", "data:text/html,<script>alert(1)</script>"],
    ["a file: address", "file:///etc/passwd"],
    ["credentials", "https://user:pw@news.example/a"],
    ["not a URL", "not a url"],
    ["empty", ""],
    ["not text", 5 as unknown as string],
  ])("a news link that is %s is never an anchor", async (_name, newsUrl) => {
    const html = await draw(payload([trend({ newsUrl })]));
    expect(html).not.toMatch(/<a[\s>]|href=/);
    expect(html).toContain("A bear walks into a bar"); // the headline still shows, as text
  });

  it("a token link that is not http(s) is never an anchor either", async () => {
    const html = await draw(payload([trend({ side: "contested", liveCount: 1, biggest: { ...token("Coin"), url: "javascript:alert(1)" }, newsUrl: "" })]));
    expect(html).not.toMatch(/<a[\s>]|href=/);
    expect(html).toContain("Biggest live token: Coin");
  });

  it("accepts an http or https address and nothing else", async () => {
    expect(hrefs(await draw(payload([trend({ newsUrl: "http://news.example/a?x=1" })])))).toEqual(["http://news.example/a?x=1"]);
  });
});

describe("the empty and source-down states say why", () => {
  const nothing = (over: Partial<RadarPayload> = {}) => payload([], over);
  const say = async (p: RadarPayload | null) => {
    const html = await draw(p);
    expect(html).toContain('data-test="radar-empty"');
    return html;
  };

  it("off", async () => {
    expect(await say(nothing({ enabled: false, sources: [], lastGoodPollAt: null }))).toContain("The trend radar is off");
  });
  it("on, no poll yet", async () => {
    expect(await say(nothing({ sources: [], lastGoodPollAt: null }))).toContain("No poll yet");
  });
  it("source down: an empty answer is never read as no trends", async () => {
    const html = await say(nothing({ sources: [source({ status: "format changed", reason: "the answer is not the feed or has no items", since: ago(20) })] }));
    expect(html).toContain("a source is not answering");
    expect(html).toContain("An empty answer is never read as no trends");
    expect(html).toContain("Google Trends (US):</span> format changed since 20 minutes ago (the answer is not the feed or has no items); last good poll 5 minutes ago");
    expect(html).not.toContain("No new rising term");
  });
  it("polling fine, nothing new", async () => {
    expect(await say(nothing())).toContain("No new rising term in the last 24 hours");
  });
  it("the list could not be loaded at all", async () => {
    expect(await say(null)).toContain("The Radar list could not be loaded.");
  });
  it("a source that was never good says so", async () => {
    expect(await draw(nothing({ sources: [source({ status: "backing off", reason: "HTTP 429", lastOk: null, since: ago(5) })] }))).toContain("last good poll none yet");
  });
});

describe("the source banner", () => {
  const alert = { source: "radar:google:US", status: "backing off" as const, reason: "HTTP 429", since: ago(125), lastOk: ago(130) };

  it("shows for a source down over an hour, with its state and its last good poll, and not otherwise", async () => {
    const html = await draw(payload([trend()], { alerts: [alert], sources: [source({ status: "backing off", reason: "HTTP 429", since: ago(125), lastOk: ago(130) })] }));
    expect(html).toContain('data-test="radar-alert"');
    expect(html).toContain("Google Trends (US) is backing off since 2 hours ago (HTTP 429). Last good poll: 2 hours ago.");
    expect(await draw(payload())).not.toContain("radar-alert");
  });

  it("a source that was never good says so", () => {
    expect(alertText({ ...alert, status: "format changed", lastOk: null }, NOW)).toContain("Last good poll: none yet.");
  });

  it("names a source it does not know as cleaned text", () => {
    expect(sourceLabel("radar:google:US")).toBe("Google Trends (US)");
    expect(sourceLabel("<b>x</b>\nradar")).not.toContain("\n");
  });
});

describe("the strip on the home page", () => {
  const strip = (over = {}) => ({ enabled: true, shown: 5, untokenized: 3, alerts: [], ...over });
  const drawStrip = (p: Parameters<typeof radarStripView>[0], nowMs = NOW) => renderToString(app(() => renderStrip({ view: radarStripView(p, nowMs) }, [])));

  it("is one line that says N Trends shown and M untokenized, and links to /radar", async () => {
    const html = await drawStrip(strip());
    expect(html).toContain("Radar: 5 Trends shown, 3 untokenized.");
    expect(hrefs(html)).toEqual(["/radar"]);
    expect(await drawStrip(strip({ shown: 1, untokenized: 0 }))).toContain("Radar: 1 Trend shown, 0 untokenized.");
  });

  it("carries the source banner above the line", async () => {
    const html = await drawStrip(strip({ alerts: [{ source: "radar:google:US", status: "down", reason: "HTTP 503", since: ago(90), lastOk: ago(95) }] }));
    expect(html).toContain("Google Trends (US) is down since 1 hour ago (HTTP 503). Last good poll: 1 hour ago.");
    expect(html.indexOf("radar-alert")).toBeLessThan(html.indexOf("radar-strip-link"));
  });

  it("says nothing while the radar is off and has nothing", async () => {
    expect(radarStripView(strip({ enabled: false, shown: 0, untokenized: 0 }), NOW)).toBeNull();
    expect(radarStripView(null, NOW)).toBeNull();
    expect(await drawStrip(strip({ enabled: false, shown: 0, untokenized: 0 }))).not.toContain("radar-strip");
    // but off with stored Trends still shows them
    expect(radarStripView(strip({ enabled: false }), NOW)).not.toBeNull();
  });
});

describe("the page before mount (the clock is 0)", () => {
  it("shows absolute UTC times and no relative ones, so the server and the first client render agree", async () => {
    const html = await draw(payload(), 0);
    expect(html).toContain("UTC");
    expect(html).not.toMatch(/ago/);
  });
});

describe("no raw HTML", () => {
  it.each(["components/RadarPanel.vue", "components/RadarStrip.vue", "pages/radar.vue"])("%s has no v-html and no raw anchor", (file) => {
    const src = readFileSync(new URL(`../../app/${file}`, import.meta.url), "utf8");
    expect(src).not.toContain("v-html");
    expect(src).not.toMatch(/<a[\s>]|\shref=/);
  });
  it("the panel's only external links are UrlLink, and the page reads with one GET", () => {
    expect(readFileSync(new URL("../../app/components/RadarPanel.vue", import.meta.url), "utf8")).toContain("<UrlLink");
    expect(readFileSync(new URL("../../app/pages/radar.vue", import.meta.url), "utf8")).toContain('useFetch("/api/radar"');
  });
});
