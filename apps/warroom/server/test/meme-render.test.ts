import { readFileSync } from "node:fs";
import { Datastore, memeIdeasByKey, META_RULE, recomputeMetas as recomputeWithRule, type MetaSnapshot, type MetasResponse, type NewMemeTrio, type Proposal } from "@argus/core";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ideaViews, memeRowView, memeView, type MemeProposalPayload } from "../../app/utils/meme.ts";
import { currentMetaView, type CurrentMetaPayload } from "../../app/utils/meta.ts";
import { researchBar } from "../../app/utils/research-bar.ts";

/**
 * Meme Proposals in the War Room (ADR 0013, missed ideas ticket 06): the real route handlers (Nitro globals stubbed, a real in-memory
 * store) and the real component templates (server-rendered), over a seeded Meta with a trio of ideas and over hostile text.
 */
type Ev = { params: Record<string, string>; query: Record<string, string>; body: unknown };
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("getRouterParam", (e: Ev, k: string) => e.params[k]);
vi.stubGlobal("getQuery", (e: Ev) => e.query);
vi.stubGlobal("readBody", async (e: Ev) => e.body);
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);
vi.stubGlobal("useDataDir", () => "/argus/data");
vi.stubGlobal("useBuildRoot", () => "/builds/code");

type Handler<T = unknown> = (e: Partial<Ev>) => T;
const list = (await import("../api/proposals/index.get.ts")).default as unknown as Handler<Array<Proposal & { score: unknown }>>;
const one = (await import("../api/proposals/[id].get.ts")).default as unknown as Handler<Proposal & { score: unknown }>;
const commands = (await import("../api/proposals/[id]/commands.post.ts")).default as unknown as Handler<Promise<{ status: string }>>;
const metas = (await import("../api/metas.get.ts")).default as unknown as Handler<MetasResponse>;
const research = (await import("../api/research.get.ts")).default as unknown as () => Record<string, unknown>;

const recomputeMetas = (s: Datastore, now: Date) => recomputeWithRule(s, { now, config: { ...META_RULE, minTokens: 2, minCreators: 1 } });
const NOW = Date.parse("2026-11-12T20:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let seq = 0;
const mintOf = () => `${B58[++seq % B58.length]}${B58[Math.floor(seq / B58.length) % B58.length]}`.padStart(40, "K") + "pump";

const snapshot = (label: string, over: Partial<MetaSnapshot["meta"]> = {}, news: MetaSnapshot["news"] = []): MetaSnapshot => ({
  version: 1,
  capturedAt: ago(0),
  meta: { key: "jensen", label, rank: 2, firstSeenAt: ago(600), counts: { "6h": { tokens: 100, creators: 70, migrations: 3, migrationsAfter60s: 1 }, "24h": { tokens: 256, creators: 141, migrations: 9, migrationsAfter60s: 4 } }, topTokens: [{ mint: "Mint1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", name: "Jensen", symbol: "JENSEN", marketCapUsd: 1_300_000 }], ...over },
  run: { id: 7, computedAt: ago(12), window: "24h", baseMigrationRate: 0.03, coverage: null },
  hot: { reason: "creators 70 to 148 in 1 h", raisedAt: ago(30), rank: 2, creators: 141 },
  roomLeft: { passed: true, text: "still has room (number 1 of 3 by the room-left ranking): lift 4.1x base" },
  tokens: [],
  news,
});

const trio = (key = "jensen", over: Partial<NewMemeTrio> = {}): NewMemeTrio => ({
  metaKey: key,
  metaLabel: "Jensen",
  snapshot: snapshot("Jensen", {}, [
    { title: "Jensen Huang resigns as Nvidia CEO", sourceLabel: "Wired", url: "https://example.com/resigns", publishedAt: ago(120) },
    { title: "Congress calls Jensen", sourceLabel: "The Verge", url: "javascript:alert(1)", publishedAt: ago(60) },
  ]),
  reason: "Hot now: creators 70 to 148 in 1 h",
  summary: "Meta Jensen: 141 creators, 256 tokens in 24 h, rank 2. Hot now: creators 70 to 148 in 1 h.",
  evidenceLinks: ["https://dexscreener.com/solana/Mint1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "https://example.com/resigns"],
  ideas: ["Alpha", "Bravo", "Charlie"].map((n, i) => ({ name: `Idea ${n}`, ticker: ["AAA", "BBB", "CCC"][i]!, angle: `Angle ${n}: the joke and why now.`, difference: "Not the leader.", description: "A pitch.", hook: "gm, news of the day", imageIdea: "A chair.", riskLabels: ["real person"] })),
  ...over,
});

beforeEach(() => {
  store = Datastore.open(":memory:");
});

describe("the routes", () => {
  it("GET /api/proposals?kind=meme returns only meme Proposals with their idea fields and Meta snapshot; kind=narrative the others; a bad kind is a 400", () => {
    const n = store.createProposal({ narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: "Cat", ticker: "CAT", description: "d", evidenceLinks: [] });
    const made = store.createMemeProposals(trio(), { now: new Date(NOW) });
    const memes = list({ query: { kind: "meme" } });
    expect(memes.map((p) => p.id).sort()).toEqual(made.map((p) => p.id).sort());
    expect(memes[0]).toMatchObject({ kind: "meme", narrativeId: null, score: null, metaLabel: "Jensen", meme: { riskLabels: ["real person"] } });
    expect(memes[0]!.metaSnapshot!.meta.counts["24h"].creators).toBe(141);
    expect(list({ query: { kind: "narrative" } }).map((p) => p.id)).toEqual([n.id]);
    expect(list({ query: {} })).toHaveLength(4);
    expect(() => list({ query: { kind: "beta" } })).toThrow(/Invalid kind/);
  });

  it("the default Score sort lists the meme Proposals after the scored ones, newest first", () => {
    store.recordSignals([{ id: "s:1", sourceId: "rss:a", sourceLabel: "Feed", title: "Story", summary: "", url: "https://a.example/1", publishedAt: new Date(NOW).toISOString() }]);
    const narrativeId = store.createNarrative(store.unclusteredSignals(5)[0]!, [1, 0], ago(0), { id: "e", dimension: 2 });
    const scoreId = store.recordScore({ narrativeId, rubricVersion: 1, scores: { momentum: 7, novelty: 6, buildability: 8, hook: 5, legitimacy: 9 }, total: 7, rationale: "r", signalCount: 1, changedMateriallyAt: ago(0), createdAt: ago(0) });
    const scored = store.createResearchProposal({ narrativeSummary: "s", techOneLiner: "t", whyNow: "w", name: "Scored", ticker: "SC", description: "d", evidenceLinks: ["https://e.example/1", "https://e.example/2", "https://e.example/3"], narrativeId, scoreId }, { now: new Date(NOW - 3_600_000) });
    const first = store.createMemeProposals(trio("one"), { now: new Date(NOW - 1_800_000) });
    const second = store.createMemeProposals(trio("two"), { now: new Date(NOW) });
    const ids = list({ query: { sort: "score" } }).map((p) => p.id);
    expect(ids[0]).toBe(scored.id);
    expect(ids.slice(1)).toEqual([...second, ...first].map((p) => p.id).sort((a, b) => b - a));
  });

  it("GET /api/proposals/:id carries the snapshot, the idea fields and the stored reason", () => {
    const [p] = store.createMemeProposals(trio(), { now: new Date(NOW) });
    const r = one({ params: { id: String(p!.id) } });
    expect(r).toMatchObject({ kind: "meme", reason: "Hot now: creators 70 to 148 in 1 h", whyNow: "Angle Alpha: the joke and why now.", evidenceLinks: expect.arrayContaining(["https://example.com/resigns"]) });
    expect(r.metaSnapshot!.news.map((x) => x.title)).toContain("Jensen Huang resigns as Nvidia CEO");
    const wire = JSON.parse(JSON.stringify(r)) as typeof r; // what the page receives: it survives JSON with the snapshot's numbers intact
    expect(wire.metaSnapshot!.meta.counts["24h"].creators).toBe(141);
    expect(wire.meme).toEqual({ difference: "Not the leader.", hook: "gm, news of the day", imageIdea: "A chair.", riskLabels: ["real person"] });
  });

  it("the command route accepts Shortlist, Undo and Dismiss with a reason for a meme, and refuses Approve, Revise, Retry Spec, Re-queue, Mark launched and Clean up with a clear 409", async () => {
    const [p] = store.createMemeProposals(trio(), { now: new Date(NOW) });
    const post = (body: unknown) => commands({ params: { id: String(p!.id) }, body });
    expect((await post({ type: "shortlist", reason: "" })).status).toBe("pending");
    for (const type of ["approve", "revise", "retry-spec", "requeue", "mark-launched", "cleanup-build"]) {
      await expect(post({ type, reason: type === "revise" ? "more" : type === "mark-launched" ? "So11111111111111111111111111111111111111112" : "" }), type).rejects.toMatchObject({ statusCode: 409, statusMessage: expect.stringMatching(/no Spec, Approve or Build/) });
    }
    await expect(post({ type: "dismiss", reason: " " })).rejects.toMatchObject({ statusCode: 400, statusMessage: "Dismissal needs a reason" });
    expect((await post({ type: "dismiss", reason: "a bad joke" })).status).toBe("pending");
    expect(store.pendingCommands().map((c) => c.type)).toEqual(["shortlist", "dismiss"]);
  });

  it("GET /api/metas (All launch themes) lists no ideas even for a theme with live ones, and the count in the research bar includes the task", async () => {
    for (let i = 0; i < 4; i++) store.study.recordTokenEvent({ kind: "create", mint: mintOf(), receivedAt: ago(30), signature: "", name: "Jensen", symbol: "JENSEN", creator: `C${i}`.padEnd(44, "x"), uri: "https://ipfs.io/ipfs/x", pool: "pump" });
    await recomputeMetas(store, new Date(NOW));
    const row = store.latestMetas("24h", 5)!.rows[0]!;
    store.createMemeProposals(trio(row.key), { now: new Date(NOW) });
    expect(metas({ query: {} }).metas[0]).not.toHaveProperty("ideas"); // the ideas are listed under the Current Meta (GET /api/current-meta)
    // The runs of the task are in the research figures and the bar says so.
    const id = store.startBrainRun({ proposalId: 0, task: "meme-ideas", backend: "claude-code", model: "sonnet" });
    store.finishBrainRun(id, { sessionId: null, totalCostUsd: 0.1, exitStatus: "success" });
    const r = research() as never as Parameters<typeof researchBar>[0];
    expect(r).toMatchObject({ runs: 1, memeIdeas: { enabled: false, runs: 1, cap: 8 } });
    expect(researchBar(r).details.join(" ")).toContain("Meme ideas: 1 of 8 runs in the last 24 h (counted in the budget above); off until ARGUS_MEME_IDEAS=1.");
  });
});

// The real templates, compiled and server-rendered with the link components stubbed to the anchors they draw.
type Render = (ctx: unknown, cache: unknown[]) => unknown;
async function load(file: string): Promise<Render> {
  const sfc = parse(readFileSync(new URL(`../../app/components/${file}`, import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: file, id: file });
  return new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;
}
const renderCard = await load("MemeCard.vue");
const renderCurrent = await load("CurrentMeta.vue");
async function draw(render: Render, ctx: Record<string, unknown>): Promise<string> {
  const app = createSSRApp({ render: () => render(ctx, []) as ReturnType<typeof h> });
  app.component("UrlLink", { props: ["href", "label"], render() { return h("a", { class: "url-link", href: this.href }, this.label); } });
  app.component("NuxtLink", { props: ["to"], render() { return h("a", { class: "nuxt-link", href: this.to }, this.$slots.default?.()); } });
  return renderToString(app);
}

const proposalPayload = (over: Partial<MemeProposalPayload> = {}): MemeProposalPayload => ({
  kind: "meme",
  status: "new",
  name: "Empty Leather Chair",
  ticker: "CHAIR",
  whyNow: "The CEO left the chair and the market made it a token.",
  description: "A chair, but make it a coin.",
  reason: "Hot now: creators 70 to 148 in 1 h",
  narrativeSummary: "Meta Jensen: 141 creators, 256 tokens in 24 h, rank 2.",
  evidenceLinks: ["https://dexscreener.com/solana/Mint1", "https://example.com/resigns"],
  metaLabel: "Jensen",
  metaSnapshot: snapshot("Jensen", { topTokens: [{ mint: "Mint1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".replace("Mint1", "KMint"), name: "Jensen", symbol: "JENSEN", marketCapUsd: 1_300_000 }] }, [
    { title: "Jensen Huang resigns as Nvidia CEO", sourceLabel: "Wired", url: "https://example.com/resigns", publishedAt: ago(120) },
    { title: "Congress calls Jensen to testify", sourceLabel: "The Verge", url: "https://example.com/congress", publishedAt: ago(60) },
  ]),
  meme: { difference: "It jokes about the story, not the logo.", hook: "gm. the chair is empty.", imageIdea: "A leather chair in a spotlight.", riskLabels: ["real person", "political"] },
  ...over,
});

describe("the Proposal page's meme card", () => {
  it("shows the idea fields, the Meta numbers from the snapshot, the news and the evidence links", async () => {
    const html = await draw(renderCard, { view: memeView(proposalPayload(), NOW) });
    for (const text of ["The CEO left the chair and the market made it a token.", "It jokes about the story, not the logo.", "A chair, but make it a coin.", "gm. the chair is empty.", "A leather chair in a spotlight.", "real person", "political"]) expect(html, text).toContain(text);
    for (const text of ["rank 2 in the 24 h ranking", "141 creators", "256 tokens", "9 migrations (unfiltered)", "4 after 60 s", "Hot now: creators 70 to 148 in 1 h, raised 30 minutes ago", "ranking from 12 minutes ago", "still has room (number 1 of 3 by the room-left ranking)", "Jensen ($JENSEN) $1.3M"]) expect(html, text).toContain(text);
    for (const text of ["Jensen Huang resigns as Nvidia CEO", "Wired, 2 hours ago", "Congress calls Jensen to testify"]) expect(html, text).toContain(text);
    expect(html).toContain('href="https://example.com/resigns"');
    expect(html).toContain('href="https://dexscreener.com/solana/Mint1"');
    expect(html).toContain('href="https://dexscreener.com/solana/KMint');
    expect(html.match(/data-test="meme-risk-label"/g)).toHaveLength(2);
    expect(html).not.toMatch(/undefined|NaN|null/);
    for (const section of ["meme-idea", "meme-meta", "meme-why", "meme-hook", "meme-image", "meme-news", "meme-evidence"]) expect(html, section).toContain(`data-test="${section}"`);
  });

  it("a version 1 idea made by Hot now still reads as it did (rank, Hot now wording), and a version 2 idea made by a new Meta or a refresh says New Meta or Meta refresh and names the leader", async () => {
    const v1 = await draw(renderCard, { view: memeView(proposalPayload(), NOW) });
    expect(v1).toContain("rank 2 in the 24 h ranking");
    expect(v1).toContain("Hot now: creators 70 to 148 in 1 h, raised 30 minutes ago");
    const v2snap = (kind: "new-meta" | "refresh") => ({
      version: 2,
      capturedAt: ago(0),
      meta: { label: "Jensen", counts: { "6h": { tokens: 12, creators: 6, migrations: 1, migrationsAfter60s: 0 }, "24h": { tokens: 40, creators: 14, migrations: 8, migrationsAfter60s: 3 } }, topTokens: [] },
      leader: { mint: "KMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", name: "Jensen Huang", symbol: "JENSEN", marketCapUsd: 2_400_000 },
      trigger: { kind, reason: "$JENSEN at $2.4M, 14 creators in 24 h", at: ago(30) },
      run: { computedAt: ago(12) },
      roomLeft: { passed: true, text: "still has room" },
      news: [],
    });
    const fresh = await draw(renderCard, { view: memeView(proposalPayload({ reason: "New Meta: $JENSEN at $2.4M, 14 creators in 24 h", metaSnapshot: v2snap("new-meta") }), NOW) });
    for (const text of ["led by Jensen Huang ($JENSEN) $2.4M", "14 creators", "40 tokens", "New Meta: $JENSEN at $2.4M, 14 creators in 24 h, raised 30 minutes ago", "ranking from 12 minutes ago", "New Meta: $JENSEN at $2.4M, 14 creators in 24 h"]) expect(fresh, text).toContain(text);
    expect(fresh).not.toMatch(/Hot now|rank \d in the 24 h ranking|undefined|NaN|null/);
    const again = await draw(renderCard, { view: memeView(proposalPayload({ reason: "Meta refresh: $JENSEN at $2.4M, 14 creators in 24 h", metaSnapshot: v2snap("refresh") }), NOW) });
    expect(again).toContain("Meta refresh: $JENSEN at $2.4M, 14 creators in 24 h, refreshed 30 minutes ago");
    expect(again).not.toContain("Hot now");
  });

  it("says so, in words, where a field is missing (an old row, a snapshot that could not be read)", async () => {
    const html = await draw(renderCard, { view: memeView(proposalPayload({ metaSnapshot: null, meme: null, reason: "", evidenceLinks: [], description: "" }), NOW) });
    expect(html).toContain("None named.");
    expect(html).toContain("Not recorded for this idea.");
    expect(html).toContain("No matching headline was stored.");
    expect(html).toContain("No evidence links.");
    expect(html).not.toContain('data-test="meme-meta-numbers"');
    expect(html).not.toMatch(/undefined|NaN|null/);
  });

  it("renders every field as text: markup is escaped, and javascript:, data: and credentialled URLs are never links", async () => {
    const evil = `<img src=x onerror=alert(1)></script><script>alert(1)</script> javascript:alert(1) ${"A".repeat(10_000)}`;
    const view = memeView(
      proposalPayload({
        name: evil,
        ticker: evil,
        whyNow: evil,
        description: evil,
        reason: evil,
        metaLabel: evil,
        evidenceLinks: ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "https://user:pw@evil.example/", "ftp://example.com/x", "https://ok.example/page"],
        meme: { difference: evil, hook: evil, imageIdea: evil, riskLabels: [evil, "<b>x</b>"] },
        metaSnapshot: snapshot(evil, { summary: evil, topTokens: [{ mint: "x", name: evil, symbol: evil, marketCapUsd: 1 }] }, [{ title: evil, sourceLabel: evil, url: "javascript:alert(1)", publishedAt: "nonsense" }, { title: "ok", sourceLabel: "S", url: "https://user:pw@evil.example/", publishedAt: ago(5) }]),
      }),
      NOW,
    );
    const html = await draw(renderCard, { view });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
    expect(hrefs).toEqual(["https://ok.example/page"]); // the only safe link
    expect(html).not.toMatch(/href="(javascript|data|ftp):/);
    expect(html.length).toBeLessThan(20_000);
    expect(html).toContain("…");
  });

  it("a pure-text view: no field of the view carries markup the template could be tempted to inject, and the template has no raw HTML or raw anchors", () => {
    const src = readFileSync(new URL("../../app/components/MemeCard.vue", import.meta.url), "utf8");
    expect(src).not.toContain("v-html");
    expect(src).not.toMatch(/<a[\s>]|\shref=/);
    expect(src).toContain("<UrlLink");
  });
});

describe("a news meme (proposal-routing ticket 04)", () => {
  const storySnap = (over: Record<string, unknown> = {}) => ({
    version: 3,
    kind: "narrative",
    capturedAt: ago(0),
    narrative: { id: 12, title: "Chipmaker beats the quarter", summary: "Revenue is up and the guidance is higher.", signalCount: 3, createdAt: ago(300), lastSignalAt: ago(30) },
    score: { id: 40, rubricVersion: 3, total: 5.2, scores: { buildability: 3, legitimacy: 6, hook: 8, momentum: 9, novelty: 6 }, rationale: "Funny and moving, but there is no small app in it.", gateMin: 5, createdAt: ago(20) },
    trigger: { kind: "news-meme", reason: "buildability 3 under the gate of 5; legitimacy 6, hook 8, momentum 9", at: ago(20) },
    news: [{ title: "Chipmaker beats the quarter", sourceLabel: "Wire", url: "https://wire.example/story", publishedAt: ago(30) }],
    ...over,
  });
  const newsPayload = (over: Partial<MemeProposalPayload> = {}): MemeProposalPayload =>
    proposalPayload({
      reason: "News meme: buildability 3 under the gate of 5; legitimacy 6, hook 8, momentum 9",
      narrativeSummary: "From news: Chipmaker beats the quarter. Buildability 3 under the gate of 5, so no Tech.",
      metaLabel: "Chipmaker beats the quarter",
      narrativeId: 12,
      evidenceLinks: ["https://wire.example/story"],
      metaSnapshot: storySnap() as MemeProposalPayload["metaSnapshot"],
      ...over,
    });

  it("shows the from-news line, a link to the Narrative, the failing Score with its reasons, the story's numbers and its news, under the same card", async () => {
    const view = memeView(newsPayload(), NOW);
    expect(view).toMatchObject({ source: "news", fromNews: { headline: "Chipmaker beats the quarter", href: "/narratives/12", linkText: "Narrative 12" } });
    const html = await draw(renderCard, { view });
    for (const text of [
      "From news: Chipmaker beats the quarter",
      "Narrative 12",
      "Score 5.2 of 10: buildability 3 (under the gate of 5), legitimacy 6, hook 8, momentum 9, novelty 6",
      "The judge&#39;s reasons: Funny and moving, but there is no small app in it.",
      "The story when the idea was made",
      "Revenue is up and the guidance is higher.",
      "3 Signals",
      "newest 30 minutes ago",
      "News meme: buildability 3 under the gate of 5; legitimacy 6, hook 8, momentum 9, scored 20 minutes ago",
      "How it differs from the tokens already riding the story",
      "Wire, 30 minutes ago",
    ]) expect(html, text).toContain(text);
    expect(html).toContain('href="/narratives/12"');
    expect(html).toContain('href="https://wire.example/story"');
    expect(html).not.toMatch(/undefined|NaN|null|Hot now|Room left|The Meta when/);
    expect(html).not.toContain('data-test="meme-meta-label"');
    for (const section of ["meme-from-news", "meme-idea", "meme-meta", "meme-why", "meme-hook", "meme-news", "meme-evidence"]) expect(html, section).toContain(`data-test="${section}"`);
  });

  it("a Meta's idea (version 1 or 2) draws no from-news block and keeps its words", async () => {
    const v1 = memeView(proposalPayload(), NOW);
    expect(v1).toMatchObject({ source: "meta", fromNews: null });
    const html = await draw(renderCard, { view: v1 });
    expect(html).not.toContain("meme-from-news");
    expect(html).toContain("The Meta when the idea was made");
    expect(html).toContain("How it differs from the leader");
  });

  it("renders hostile text as text, links the Narrative by its numeric id only, and never links a javascript: headline URL", async () => {
    const evil = `<img src=x onerror=alert(1)></script><script>alert(1)</script> javascript:alert(1) ${"A".repeat(10_000)}`;
    const snap = storySnap({
      narrative: { id: "12/../x", title: evil, summary: evil, signalCount: "many", createdAt: "nonsense", lastSignalAt: "nonsense" },
      score: { id: 40, total: "high", scores: { buildability: "<b>3</b>", hook: 8 }, rationale: evil, gateMin: "five" },
      trigger: { kind: "news-meme", reason: evil, at: "nonsense" },
      news: [{ title: evil, sourceLabel: evil, url: "javascript:alert(1)", publishedAt: "nonsense" }],
    });
    const view = memeView(newsPayload({ narrativeId: "12/../x" as unknown as number, metaLabel: evil, reason: evil, metaSnapshot: snap as MemeProposalPayload["metaSnapshot"] }), NOW);
    expect(view.fromNews!.href).toBeNull();
    const html = await draw(renderCard, { view });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>3</b>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(["https://wire.example/story"]); // only the evidence link
    expect(html).not.toMatch(/href="(javascript|data|ftp|\/narratives)/);
    expect(html.length).toBeLessThan(20_000);
  });

  it("the route returns the news meme with its Narrative and Score, and a Meta's idea still has none", () => {
    store.recordSignals([{ id: "s:1", sourceId: "rss:a", sourceLabel: "Feed", title: "Story", summary: "", url: "https://a.example/1", publishedAt: new Date(NOW).toISOString() }]);
    const narrativeId = store.createNarrative(store.unclusteredSignals(5)[0]!, [1, 0], ago(0), { id: "e", dimension: 2 });
    const scoreId = store.recordScore({ narrativeId, rubricVersion: 1, scores: { momentum: 9, novelty: 6, buildability: 3, hook: 8, legitimacy: 6 }, total: 6.4, rationale: "r", signalCount: 1, changedMateriallyAt: ago(0), createdAt: ago(0) });
    const tech = store.createProposal({ narrativeSummary: "n", techOneLiner: "t", whyNow: "w", name: "Cat", ticker: "CAT", description: "d", evidenceLinks: [] });
    const made = store.createMemeProposals(
      {
        narrative: { id: narrativeId, scoreId },
        metaKey: `narrative:${narrativeId}`,
        metaLabel: "Story",
        snapshot: storySnap({ narrative: { id: narrativeId, title: "Story", summary: "", signalCount: 1, createdAt: ago(0), lastSignalAt: ago(0) } }) as unknown as MetaSnapshot,
        reason: "News meme: x",
        summary: "From news: Story.",
        evidenceLinks: ["https://wire.example/story"],
        ideas: trio().ideas,
      },
      { now: new Date(NOW) },
    );
    const one = list({ query: { kind: "meme" } }).find((p) => p.id === made[0]!.id)!;
    expect(one).toMatchObject({ kind: "meme", narrativeId, scoreId, metaKey: `narrative:${narrativeId}` });
    expect(one.metaSnapshot).toMatchObject({ version: 3, kind: "narrative" });
    const wire = JSON.parse(JSON.stringify(one)) as MemeProposalPayload;
    expect(memeView(wire, NOW)).toMatchObject({ source: "news", fromNews: { href: `/narratives/${narrativeId}` } });
    expect(list({ query: { kind: "narrative" } }).map((p) => p.id)).toEqual([tech.id]);
    expect(list({ query: { kind: "meme" } }).every((p) => (p as { score: unknown }).score !== null)).toBe(true); // the page's card shows the failing Score (the list and header do not)
  });
});

describe("the Current Meta shows a Meta's ideas", () => {
  const response = (ideas: unknown): CurrentMetaPayload =>
    ({
      computedAt: ago(5),
      coverageNote: null,
      metas: [{ key: "jensen", label: "Jensen", leader: { mint: "Ja", name: "Jensen", symbol: "JENSEN", marketCapUsd: 2_400_000, stale: false }, holding: false, enteredAt: ago(600), counts: { "6h": { tokens: 100, creators: 70, migrations: 3, migrationsAfter60s: 1 }, "24h": { tokens: 256, creators: 141, migrations: 9, migrationsAfter60s: 4 } }, topTokens: [], summary: "A line", summarySource: "llm", ideas }],
      watching: [],
    }) as unknown as CurrentMetaPayload;
  const idea = (id: number, over: Record<string, unknown> = {}) => ({ id, name: `Idea ${id}`, ticker: `T${id}`, angle: `Angle ${id}`, status: "new", riskLabels: ["real person"], createdAt: ago(10), expiresAt: new Date(NOW + 5 * 3_600_000).toISOString(), ...over });
  const section = (payload: CurrentMetaPayload) => draw(renderCurrent, { view: currentMetaView(payload, NOW) });

  it("lists each idea under its Meta with its name, ticker, status, risk label, time left and angle, linking to its card by id", async () => {
    const html = await section(response([idea(11), idea(12, { status: "shortlisted" }), idea(13)]));
    expect(html).toContain('data-test="meta-ideas"');
    for (const id of [11, 12, 13]) expect(html).toContain(`data-test="meta-idea-${id}"`);
    expect(html).toContain('href="/proposals/11"');
    for (const text of ["Idea 11", "T11", "Angle 11", "closes in 5 h", "real person", "shortlisted"]) expect(html, text).toContain(text);
    expect(html.match(/data-test="idea-kind"/g)).toHaveLength(3);
    expect(html).not.toMatch(/undefined|NaN|null/);
  });

  it("shows no ideas block for a Meta without any", async () => {
    expect(await section(response([]))).not.toContain("meta-ideas");
    expect(await section(response(undefined))).not.toContain("meta-ideas");
  });

  it("hostile names, angles and labels are text; the link is the card's numeric id and never text from the model; a row without a valid id is dropped", async () => {
    const evil = `<img src=x onerror=alert(1)></script><script>alert(1)</script> javascript:alert(1) ${"A".repeat(10_000)}`;
    const html = await section(response([idea(21, { name: evil, ticker: evil, angle: evil, riskLabels: [evil] }), idea("../../etc" as never), idea(-1), idea(2.5), idea(31, { name: "" })]));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html.match(/data-test="meta-idea-/g)).toHaveLength(1);
    expect([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(["/proposals/21"]);
    expect(html.length).toBeLessThan(8_000);
  });

  it("the view keeps `ideas` out of a row that has none, so older payloads render as before", () => {
    const v = currentMetaView(response([]), NOW);
    expect(v.metas[0]).not.toHaveProperty("ideas");
    expect(ideaViews(undefined, NOW)).toEqual([]);
    expect(ideaViews([idea(1, { status: "new", expiresAt: new Date(NOW - 1000).toISOString() })], NOW)[0]!.expires).toBe("closes on the next worker tick");
    expect(ideaViews([idea(1, { status: "shortlisted" })], NOW)[0]!.expires).toBe("shortlisted");
  });

  it("an idea made before a worker stop shows the later close time through the unchanged view (meta redesign ticket 10)", () => {
    store.recordWorkerAlive(new Date(NOW - 11 * 3_600_000));
    store.createMemeProposals(
      { metaKey: "jensen", metaLabel: "Jensen", snapshot: snapshot("Jensen"), reason: "Hot now", summary: "s", evidenceLinks: [], ideas: [1, 2, 3].map((n) => ({ name: `Idea ${["Alpha", "Bravo", "Charlie"][n - 1]}`, ticker: `TK${["A", "B", "C"][n - 1]}`, angle: "a", difference: "d", description: "p", hook: "gm", imageIdea: "i", riskLabels: [] })) },
      { now: new Date(NOW - 11 * 3_600_000) },
    );
    const payload = (): Array<{ id: number; name: string; ticker: string; angle: string; status: string; riskLabels: string[]; expiresAt: string | null }> =>
      store.liveMemeProposals().map((p) => ({ id: p.id, name: p.name, ticker: p.ticker, angle: p.angle ?? "", status: p.status, riskLabels: p.riskLabels ?? [], expiresAt: p.expiresAt }));
    expect(ideaViews(payload(), NOW)[0]!.expires).toBe("closes in 1 h"); // made 11 h ago, no stop recorded
    for (let m = 5; m <= 60; m += 5) store.recordWorkerAlive(new Date(NOW - 11 * 3_600_000 + m * 60_000)); // alive 1 h after the idea, then stopped
    store.recordWorkerAlive(new Date(NOW - 2 * 3_600_000)); // 8 h stop
    expect(ideaViews(payload(), NOW)[0]!.expires).toBe("closes in 9 h");
  });
});

describe("the Proposals list and page sources", () => {
  const read = (p: string) => readFileSync(new URL(`../../app/${p}`, import.meta.url), "utf8");

  it("the list has a meme pill, a Kind filter in the URL query and the API query, a meme count in the header, and no Spec modal for a meme", () => {
    const home = read("pages/index.vue");
    expect(home).toContain('data-test="kind-pill"');
    expect(home).toContain('{ value: "meme", label: "Meme" }');
    expect(home).toContain('key: "kind"');
    expect(home).toContain("route.query.kind");
    expect(home).toContain("p.kind === 'meme' ? send(p.id, 'shortlist') : askShortlist(p)");
    expect(home).toContain("memeRowView(p)");
    expect(home).toContain("{{ memeCount }} meme");
    expect(home).not.toMatch(/v-html/);
  });

  it("the Proposal page draws the meme card for a meme, with the Shortlist and Dismiss that ask for no Spec", () => {
    const page = read("pages/proposals/[id].vue");
    expect(page).toContain('<MemeCard v-if="meme" :view="meme" />');
    expect(page).toContain("send('shortlist')");
    expect(page).toContain('data-test="kind-pill"');
    expect(page).not.toMatch(/v-html/);
  });

  it("the list and the Proposal page draw an Angle pill for an Operator-angle idea, and the page reads the angle from the Proposal", () => {
    const home = read("pages/index.vue");
    expect(home).toContain("memeRowView(p).fromOperatorAngle");
    expect(home).toContain('data-test="angle-pill"');
    const page = read("pages/proposals/[id].vue");
    expect(page).toContain("meme?.operatorAngle");
    expect(page).toContain('data-test="angle-pill"');
    expect(page).not.toMatch(/v-html/);
    expect(home).not.toMatch(/v-html/);
  });

  it("the list row view cuts and flattens what it shows", () => {
    const row = memeRowView(proposalPayload({ whyNow: "line one\nline two ".repeat(100), narrativeSummary: "x".repeat(1000), meme: { riskLabels: ["a", "b", "c", "d", "e", "f", "g"] } }));
    expect(row.angle.length).toBeLessThanOrEqual(301);
    expect(row.angle).not.toContain("\n");
    expect(row.metaLine.length).toBeLessThanOrEqual(201);
    expect(row.riskLabels).toHaveLength(5);
  });
});

describe("an idea made from the Operator's angle (meta redesign ticket 11)", () => {
  const v2 = (kind = "operator-angle"): MemeProposalPayload["metaSnapshot"] => ({
    version: 2,
    capturedAt: ago(0),
    meta: { label: "GTA 6", counts: { "24h": { tokens: 25, creators: 14, migrations: 2, migrationsAfter60s: 1 } }, topTokens: [] },
    leader: { mint: "KMint", name: "Lucia", symbol: "LUCIA", marketCapUsd: 2_400_000 },
    trigger: { kind, reason: "$LUCIA at $2.4M, 14 creators in 24 h", at: ago(3) },
    run: { computedAt: ago(5) },
    roomLeft: { passed: true, text: "still has room" },
    news: [],
  });
  const angled = (over: NonNullable<MemeProposalPayload["operatorAngle"]> = {}, more: Partial<MemeProposalPayload> = {}) =>
    proposalPayload({ reason: "Operator angle: GTA 6 iguana", metaSnapshot: v2(), operatorAngle: { requestId: 4, angle: "GTA 6 iguana: screenshot on rockstargames.com shows an iguana", sourceUrl: "https://www.rockstargames.com/VI/only-in-leonida", urlDropped: false, ...over }, ...more });

  it("the Proposal page shows an Operator angle card first: the angle as text, the source as a link for an http(s) address, and the trigger named", async () => {
    const html = await draw(renderCard, { view: memeView(angled(), NOW) });
    expect(html).toContain('data-test="meme-operator-angle"');
    expect(html.indexOf('data-test="meme-operator-angle"')).toBeLessThan(html.indexOf('data-test="meme-idea"'));
    expect(html).toContain('data-test="meme-operator-angle-text">GTA 6 iguana: screenshot on rockstargames.com shows an iguana<');
    expect(html).toContain('href="https://www.rockstargames.com/VI/only-in-leonida"');
    expect(html).toContain("rockstargames.com/VI/only-in-leonida");
    expect(html).toContain("Operator angle: $LUCIA at $2.4M, 14 creators in 24 h, asked 3 minutes ago");
    expect(html).not.toMatch(/undefined|NaN|null/);
  });

  it("the source is plain text when it is not an http(s) address, and a note when the link was dropped; the text is one line of escaped text", async () => {
    const evil = "<img src=x onerror=1>\nline two\r\nline three";
    const html = await draw(renderCard, { view: memeView(angled({ angle: evil, sourceUrl: "javascript:alert(1)" }), NOW) });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=1&gt; line two line three");
    expect(html).not.toMatch(/href="javascript:/);
    expect(html).toContain('data-test="meme-operator-angle-source"');
    expect(html.slice(html.indexOf('data-test="meme-operator-angle-source"'), html.indexOf('data-test="meme-idea"'))).toContain("javascript:alert(1)");
    const dropped = await draw(renderCard, { view: memeView(angled({ sourceUrl: null, urlDropped: true }), NOW) });
    expect(dropped).toContain('data-test="meme-operator-angle-dropped"');
    expect(dropped).not.toContain('data-test="meme-operator-angle-source"');
    const none = await draw(renderCard, { view: memeView(angled({ sourceUrl: null }), NOW) });
    expect(none).not.toContain("meme-operator-angle-source");
    expect(none).not.toContain("meme-operator-angle-dropped");
  });

  it("a very long angle and a credentialled link are cut and never linked", async () => {
    const html = await draw(renderCard, { view: memeView(angled({ angle: "Z".repeat(100_000), sourceUrl: "https://user:pw@evil.example/x" }), NOW) });
    expect(html).not.toContain("Z".repeat(700));
    expect(html).toContain("…");
    expect(html).not.toContain('href="https://user');
    expect(html.length).toBeLessThan(20_000);
  });

  it("an idea with no angle renders exactly as before: no card, and the view says null", async () => {
    const plain = proposalPayload();
    expect(memeView(plain, NOW).operatorAngle).toBeNull();
    expect(memeView({ ...plain, operatorAngle: null }, NOW).operatorAngle).toBeNull();
    expect(memeView({ ...plain, operatorAngle: { angle: "   " } }, NOW).operatorAngle).toBeNull();
    const html = await draw(renderCard, { view: memeView(plain, NOW) });
    expect(html).not.toContain("meme-operator-angle");
    expect(html).not.toContain("Operator angle");
    expect(memeRowView(plain).fromOperatorAngle).toBe(false);
    expect(memeRowView(angled()).fromOperatorAngle).toBe(true);
  });

  it("the routes carry the angle: a stored angle trio's Proposals have operatorAngle, an automatic one has null, and the list sees the same", () => {
    const [auto] = store.createMemeProposals(trio("jensen"), { now: new Date(NOW) });
    const [mine] = store.createMemeProposals(trio("jensen", { operatorAngle: { requestId: 3, angle: "an angle", sourceUrl: "https://example.com/a", urlDropped: false } }), { now: new Date(NOW + 60_000) });
    expect(one({ params: { id: String(auto!.id) } }).operatorAngle).toBeNull();
    expect(one({ params: { id: String(mine!.id) } }).operatorAngle).toEqual({ requestId: 3, angle: "an angle", sourceUrl: "https://example.com/a", urlDropped: false });
    expect(list({ query: { kind: "meme" } }).filter((p) => p.operatorAngle !== null)).toHaveLength(3);
  });

  it("ideas under a Meta carry the Angle flag only for the angle's trio", () => {
    store.createMemeProposals(trio("jensen"), { now: new Date(NOW) });
    store.createMemeProposals(trio("jensen", { operatorAngle: { requestId: 3, angle: "an angle", sourceUrl: null, urlDropped: false } }), { now: new Date(NOW + 60_000) });
    const refs = memeIdeasByKey(store.liveMemeProposals()).get("jensen")!;
    expect(refs).toHaveLength(6);
    expect(refs.filter((r) => r.fromAngle === true)).toHaveLength(3);
    const views = ideaViews(refs, NOW);
    expect(views.filter((x) => x.fromAngle)).toHaveLength(3);
    expect(views).toHaveLength(6);
  });

  it("UrlLink opens external links in a new tab with rel noopener noreferrer nofollow", () => {
    const src = readFileSync(new URL("../../app/components/UrlLink.vue", import.meta.url), "utf8");
    expect(src).toContain('target="_blank" rel="noopener noreferrer nofollow"');
  });

  it("no new component or view uses a raw HTML directive", () => {
    for (const file of ["components/MemeCard.vue", "components/AngleForm.vue", "components/CurrentMeta.vue", "pages/meta.vue", "pages/index.vue", "pages/proposals/[id].vue"]) {
      expect(readFileSync(new URL(`../../app/${file}`, import.meta.url), "utf8"), file).not.toContain("v-html");
    }
  });
});
