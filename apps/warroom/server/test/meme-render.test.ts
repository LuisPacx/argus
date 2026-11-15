import { readFileSync } from "node:fs";
import { Datastore, META_RULE, recomputeMetas as recomputeWithRule, type MetaSnapshot, type MetasResponse, type NewMemeTrio, type Proposal } from "@argus/core";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ideaViews, memeRowView, memeView, type MemeProposalPayload } from "../../app/utils/meme.ts";
import { metaView } from "../../app/utils/meta.ts";
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

  it("GET /api/metas lists a Meta's live ideas under it (new and shortlisted only), newest first, and the count in the research bar includes the task", async () => {
    for (let i = 0; i < 4; i++) store.study.recordTokenEvent({ kind: "create", mint: mintOf(), receivedAt: ago(30), signature: "", name: "Jensen", symbol: "JENSEN", creator: `C${i}`.padEnd(44, "x"), uri: "https://ipfs.io/ipfs/x", pool: "pump" });
    await recomputeMetas(store, new Date(NOW));
    const row = store.latestMetas("24h", 5)!.rows[0]!;
    const made = store.createMemeProposals(trio(row.key), { now: new Date(NOW) });
    store.transition(made[0]!.id, "dismissed", "operator", "no");
    store.transition(made[1]!.id, "shortlisted", "operator");
    const body = metas({ query: {} });
    expect(body.metas[0]!.ideas!.map((i) => i.id)).toEqual([made[2]!.id, made[1]!.id].sort((a, b) => a - b)); // dismissed one is gone; a trio shares its creation time, so by slot
    expect(body.metas[0]!.ideas![0]).toMatchObject({ name: "Idea Bravo", status: "shortlisted", riskLabels: ["real person"] });
    // The runs of the task are in the research figures and the bar says so.
    const id = store.startBrainRun({ proposalId: 0, task: "meme-ideas", backend: "claude-code", model: "sonnet" });
    store.finishBrainRun(id, { sessionId: null, totalCostUsd: 0.1, exitStatus: "success" });
    const r = research() as never as Parameters<typeof researchBar>[0];
    expect(r).toMatchObject({ runs: 1, memeIdeas: { enabled: false, runs: 1, cap: 40 } });
    expect(researchBar(r).details.join(" ")).toContain("Meme ideas: 1 of 40 runs in the last 24 h (counted in the budget above); off until ARGUS_MEME_IDEAS=1.");
  });

  it("a Meta with no live idea has no ideas key at all", async () => {
    for (let i = 0; i < 3; i++) store.study.recordTokenEvent({ kind: "create", mint: mintOf(), receivedAt: ago(30), signature: "", name: "Bare", symbol: "BARE", creator: `C${i}`.padEnd(44, "x"), uri: "https://ipfs.io/ipfs/x", pool: "pump" });
    await recomputeMetas(store, new Date(NOW));
    expect(metas({ query: {} }).metas[0]).not.toHaveProperty("ideas");
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
const renderList = await load("MetaList.vue");
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

describe("the /meta list shows a Meta's ideas", () => {
  const response = (ideas: unknown): MetasResponse =>
    ({
      window: "24h",
      computedAt: ago(5),
      note: "n",
      windowTokens: 1000,
      windowMigrations: 30,
      baseMigrationRate: 0.03,
      coverage: null,
      coverageNote: null,
      metas: [{ rank: 2, label: "Jensen", firstSeenAt: ago(600), counts: { "6h": { tokens: 100, creators: 70, migrations: 3, migrationsAfter60s: 1 }, "24h": { tokens: 256, creators: 141, migrations: 9, migrationsAfter60s: 4 } }, migrationRate: 0.04, createsPerMigration: 28, topTokens: [], summary: "A line", summarySource: "llm", ideas }],
    }) as unknown as MetasResponse;
  const idea = (id: number, over: Record<string, unknown> = {}) => ({ id, name: `Idea ${id}`, ticker: `T${id}`, angle: `Angle ${id}`, status: "new", riskLabels: ["real person"], createdAt: ago(10), expiresAt: new Date(NOW + 5 * 3_600_000).toISOString(), ...over });
  const section = (payload: MetasResponse) => draw(renderList, { view: metaView(payload, NOW, { rows: 50 }) });

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
    const v = metaView(response([]), NOW, { rows: 5 });
    expect(v.rows[0]).not.toHaveProperty("ideas");
    expect(ideaViews(undefined, NOW)).toEqual([]);
    expect(ideaViews([idea(1, { status: "new", expiresAt: new Date(NOW - 1000).toISOString() })], NOW)[0]!.expires).toBe("closes on the next worker tick");
    expect(ideaViews([idea(1, { status: "shortlisted" })], NOW)[0]!.expires).toBe("shortlisted");
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

  it("the list row view cuts and flattens what it shows", () => {
    const row = memeRowView(proposalPayload({ whyNow: "line one\nline two ".repeat(100), narrativeSummary: "x".repeat(1000), meme: { riskLabels: ["a", "b", "c", "d", "e", "f", "g"] } }));
    expect(row.angle.length).toBeLessThanOrEqual(301);
    expect(row.angle).not.toContain("\n");
    expect(row.metaLine.length).toBeLessThanOrEqual(201);
    expect(row.riskLabels).toHaveLength(5);
  });
});
