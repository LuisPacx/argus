import { readFileSync } from "node:fs";
import { Datastore, MAKE_IDEAS_ANGLE_TEXT, type ResearchBrief } from "@argus/core";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeHttpUrl } from "../../app/utils/safe-link.ts";
import { MAKE_IDEAS_ANGLE_TEXT as VIEW_MAKE_IDEAS_TEXT, memeRowView, memeView, type MemeProposalPayload } from "../../app/utils/meme.ts";
import { researchRequestsView, submitTopicIdeas, topicKeyOf, type ResearchRequestPayload } from "../../app/utils/research-brief.ts";
import type { AngleRequestPayload } from "../../app/utils/angle.ts";

/**
 * Make ideas under a Research brief (human researcher ticket 06): POST /api/meme-angle with a research request id (the real handler over a real
 * in-memory store), the button and status line under the brief on /research, and the Proposal card and pill of a topic idea. The same file holds the
 * two leftovers of the ticket 02 review: a button-made card no longer says "The angle you typed", and the route's wording.
 */
type Ev = { body: unknown };
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("readBody", async (e: Ev) => e.body);
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);
type Post = (e: Ev) => Promise<{ id: number; status: string; sourceUrl: string | null; urlDropped: boolean }>;
const post = (await import("../api/meme-angle.post.ts")).default as unknown as Post;
const status = async (p: Promise<unknown>) => ((await p.then(() => ({ statusCode: 200 }), (e: { statusCode: number }) => e)) as { statusCode: number }).statusCode;
const message = async (p: Promise<unknown>) => ((await p.then(() => ({ statusMessage: "" }), (e: { statusMessage: string }) => e)) as { statusMessage: string }).statusMessage;

const NOW = Date.parse("2026-11-20T20:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const CA = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const brief = (): ResearchBrief => ({
  story: "A trailer clip of an iguana is spreading.",
  sources: [{ title: "Studio page", url: "https://example.com/trailer" }],
  coins: [{ ca: CA, name: "Iguana Scooter", symbol: "IGUA", marketCapUsd: 64_000, liquidityUsd: 21_000, bonded: "yes", note: "named after the clip" }],
  freeNames: [{ name: "Vice Lizard", ticker: "VLIZ", why: "the animal", note: "" }],
  xNote: "X was read",
  createdAt: ago(60),
});
let researchId = 0;
beforeEach(() => {
  store = Datastore.open(":memory:");
  const r = store.requestResearch("GTA");
  store.saveResearchBrief(r.id, brief());
  researchId = r.id;
});

describe("POST /api/meme-angle with a researchRequestId", () => {
  it("writes one pending request row for the brief and nothing else: no Proposal, no command", async () => {
    const r = await post({ body: { researchRequestId: researchId } });
    expect(r).toEqual({ id: 1, status: "pending", sourceUrl: null, urlDropped: false });
    expect(store.memeAngleRequests()).toEqual([{ id: 1, metaKey: `topic:${researchId}`, status: "pending", detail: "", createdAt: expect.any(String), doneAt: null, proposalIds: [], urlDropped: false }]);
    expect(store.getAngleRequest(1)).toMatchObject({ metaLabel: "GTA", angle: "", researchRequestId: researchId });
    expect(store.listProposals()).toEqual([]);
    expect(store.pendingCommands()).toEqual([]);
  });

  it("refuses a second request for the same brief (409), a brief that does not exist (400), a bad id (400) and extra keys (400)", async () => {
    await post({ body: { researchRequestId: researchId } });
    store.resolveAngleRequest(1, { status: "done", detail: "3 ideas" });
    expect(await status(post({ body: { researchRequestId: researchId } }))).toBe(409);
    expect(await message(post({ body: { researchRequestId: researchId } }))).toMatch(/already pressed Make ideas for this brief/);
    expect(await status(post({ body: { researchRequestId: 99 } }))).toBe(400);
    for (const bad of ["1", 0, -1, 1.5, null, [1]]) expect(await status(post({ body: { researchRequestId: bad } })), JSON.stringify(bad)).toBe(400);
    expect(await status(post({ body: { researchRequestId: researchId, metaKey: "gta" } }))).toBe(400);
    expect(await status(post({ body: { researchRequestId: researchId, angle: "x" } }))).toBe(400);
    expect(store.memeAngleRequests()).toHaveLength(1);
  });

  it("answers 429 with the reason while one request waits, and the Meta body still works exactly as before", async () => {
    await post({ body: { researchRequestId: researchId } });
    const other = store.requestResearch("Other");
    store.saveResearchBrief(other.id, brief());
    expect(await status(post({ body: { researchRequestId: other.id } }))).toBe(429);
    expect(await message(post({ body: { researchRequestId: other.id } }))).toMatch(/One request is waiting/);
    expect(await status(post({ body: { metaKey: "gta", angle: "x" } }))).toBe(400); // not a current Meta: the Meta path's own refusal
    expect(await message(post({ body: { metaKey: "gta", angle: "x" } }))).toMatch(/not a current Meta/);
  });

  it("the route's wording no longer says the angle is required (ticket 02 review)", async () => {
    const src = readFileSync(new URL("../api/meme-angle.post.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/with metaKey and angle\b/);
    expect(src).not.toContain("is the angle required");
    expect(src).toContain("With no\n *   `angle` key it is the \"Make ideas\" button");
    expect(await message(post({ body: [] }))).toMatch(/metaKey \(and an optional angle\) or a researchRequestId/);
    expect(await message(post({ body: { metaKey: "gta", nope: 1 } }))).toBe("The body has keys other than metaKey and angle");
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
const renderBriefs = await load("ResearchBriefs.vue");
async function draw(render: Render, ctx: Record<string, unknown>): Promise<string> {
  const app = createSSRApp({ render: () => render({ safeHttpUrl, ...ctx }, []) as ReturnType<typeof h> });
  app.component("UrlLink", { props: ["href", "label"], render() { return h("a", { class: "url-link", href: this.href }, this.label); } });
  app.component("NuxtLink", { props: ["to"], render() { return h("a", { class: "nuxt-link", href: this.to }, this.$slots.default?.()); } });
  return renderToString(app);
}

const topicPayload = (over: Partial<MemeProposalPayload> = {}): MemeProposalPayload => ({
  kind: "meme",
  status: "new",
  name: "Vice Lizard",
  ticker: "VLIZ",
  whyNow: "The clip is the joke.",
  description: "A lizard, but make it a coin.",
  reason: 'Operator pressed Make ideas on a Research brief: Topic "GTA": 1 coins, 1 free names in the Research brief',
  narrativeSummary: "From a Research brief on GTA.",
  evidenceLinks: [`https://dexscreener.com/solana/${CA}`],
  metaLabel: "GTA",
  metaSnapshot: {
    version: 4,
    kind: "topic",
    capturedAt: ago(0),
    topic: { requestId: 7, text: "GTA" },
    brief: { story: "A trailer clip of an iguana is spreading.", coins: [{ ca: CA, name: "Iguana Scooter", symbol: "IGUA", marketCapUsd: 64_000, bonded: "yes" }, { ca: "javascript:alert(1)", name: "Evil", symbol: "EVIL", marketCapUsd: null, bonded: "no" }], freeNames: [{ name: "Vice Lizard", ticker: "VLIZ" }], createdAt: ago(60) },
    trigger: { kind: "operator-topic", reason: 'Topic "GTA": 1 coins', at: ago(3) },
  },
  meme: { difference: "It jokes about the clip.", hook: "gm", imageIdea: "A lizard.", riskLabels: [] },
  operatorAngle: { requestId: 4, angle: "GTA", sourceUrl: null, urlDropped: false, source: "topic", researchRequestId: 7 },
  ...over,
});
const meta2 = (): MemeProposalPayload["metaSnapshot"] => ({ version: 2, capturedAt: ago(0), meta: { label: "GTA 6", counts: { "24h": { tokens: 25, creators: 14, migrations: 2, migrationsAfter60s: 1 } }, topTokens: [] }, leader: { mint: "KMint", name: "Lucia", symbol: "LUCIA", marketCapUsd: 2_400_000 }, trigger: { kind: "operator-angle", reason: "$LUCIA at $2.4M", at: ago(3) }, run: { computedAt: ago(5) }, roomLeft: { passed: true, text: "still has room" }, news: [] });

describe("a topic idea's card and pill", () => {
  it("shows the topic and a link back to the brief, the brief's coins with their DexScreener links, and no claim of a typed angle", async () => {
    const view = memeView(topicPayload(), NOW);
    expect(view).toMatchObject({ source: "topic", fromTopic: { topic: "GTA", href: "/research#research-7", linkText: "Research brief 7" }, operatorAngle: { kind: "topic", pill: "Topic", briefHref: "/research#research-7" } });
    const html = await draw(renderCard, { view });
    expect(html).toContain('data-test="meme-from-topic"');
    expect(html).toContain('data-test="meme-from-topic-topic">From topic: GTA<');
    expect(html).toContain('href="/research#research-7"');
    expect(html).toContain("Research brief 7");
    expect(html).not.toContain('data-test="meme-operator-angle"');
    expect(html).not.toContain("The angle you typed");
    expect(html).toContain("The Research brief when the idea was made");
    expect(html).toContain("How it differs from the coins already on the topic");
    expect(html).toContain("1 coin");
    expect(html).toContain("Topic: Topic");
    expect(html).toContain("Iguana Scooter ($IGUA) $64K");
    expect(html).toContain(`href="https://dexscreener.com/solana/${CA}"`);
    expect(html).not.toMatch(/href="javascript:/);
    expect(html).not.toMatch(/undefined|NaN|null/);
  });

  it("a hostile topic and brief are cut and shown as escaped text; a bad request id makes no link", async () => {
    const evil = "<img src=x onerror=1>\nline two " + "Z".repeat(5000);
    const view = memeView(topicPayload({ metaSnapshot: { ...topicPayload().metaSnapshot!, topic: { requestId: -3, text: evil }, brief: { story: evil, coins: [], freeNames: [] } } }), NOW);
    const html = await draw(renderCard, { view });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("Z".repeat(400)); // the story is cut to 300 characters, the topic to 60
    expect(html).toContain("…");
    expect(view.fromTopic).toMatchObject({ href: null, linkText: "Research brief" });
    expect(html).not.toContain('href="/research#research-');
    expect(html.length).toBeLessThan(20_000);
  });

  it("the list row and the page pill say Topic for a topic idea, Angle for a typed angle and Make ideas for a button-made one", () => {
    expect(memeRowView(topicPayload())).toMatchObject({ fromOperatorAngle: true, sourcePill: "Topic" });
    const typed = { requestId: 4, angle: "GTA 6 iguana", sourceUrl: null, urlDropped: false };
    expect(memeRowView({ ...topicPayload({ metaSnapshot: meta2() }), operatorAngle: typed })).toMatchObject({ fromOperatorAngle: true, sourcePill: "Angle" });
    expect(memeRowView({ ...topicPayload({ metaSnapshot: meta2() }), operatorAngle: { ...typed, angle: MAKE_IDEAS_ANGLE_TEXT } })).toMatchObject({ fromOperatorAngle: true, sourcePill: "Make ideas" });
    expect(memeRowView({ ...topicPayload(), operatorAngle: null })).toMatchObject({ fromOperatorAngle: false, sourcePill: "" });
    const home = readFileSync(new URL("../../app/pages/index.vue", import.meta.url), "utf8");
    expect(home).toContain("{{ memeRowView(p).sourcePill }}");
    const page = readFileSync(new URL("../../app/pages/proposals/[id].vue", import.meta.url), "utf8");
    expect(page).toContain("{{ meme.operatorAngle.pill }}");
    expect(page).toContain("meme.fromTopic");
  });
});

describe("a button-made idea no longer claims a typed angle (ticket 02 review)", () => {
  it("the view holds the same placeholder text the worker stores", () => {
    expect(VIEW_MAKE_IDEAS_TEXT).toBe(MAKE_IDEAS_ANGLE_TEXT);
  });

  it("a Make ideas card says so, shows no angle text and not the words 'The angle you typed'; a typed angle's card is unchanged", async () => {
    const button = memeView(topicPayload({ metaSnapshot: meta2(), operatorAngle: { requestId: 4, angle: MAKE_IDEAS_ANGLE_TEXT, sourceUrl: null, urlDropped: false } }), NOW);
    expect(button.operatorAngle).toMatchObject({ kind: "button", pill: "Make ideas" });
    const html = await draw(renderCard, { view: button });
    expect(html).toContain('data-test="meme-operator-angle"');
    expect(html).toContain("You pressed Make ideas on the Meta page; no angle was typed. The ideas below are about the Meta.");
    expect(html).not.toContain("The angle you typed");
    expect(html).not.toContain("meme-operator-angle-text");
    expect(html).not.toContain("no angle typed)");
    const typed = await draw(renderCard, { view: memeView(topicPayload({ metaSnapshot: meta2(), operatorAngle: { requestId: 4, angle: "GTA 6 iguana", sourceUrl: null, urlDropped: false } }), NOW) });
    expect(typed).toContain("The angle you typed on the Meta page. The ideas below are about it.");
    expect(typed).toContain('data-test="meme-operator-angle-text">GTA 6 iguana<');
  });
});

describe("the Make ideas button under a brief on /research", () => {
  const request = (over: Partial<ResearchRequestPayload> = {}): ResearchRequestPayload => ({ id: 7, topic: "GTA", status: "done", detail: "", createdAt: ago(60), doneAt: ago(55), runs: 1, costUsd: 0.1, costEstimated: false, brief: brief(), ...over });
  const angleRow = (over: Partial<AngleRequestPayload> = {}): AngleRequestPayload => ({ id: 3, metaKey: topicKeyOf(7), status: "pending", detail: "", createdAt: ago(2), doneAt: null, proposalIds: [], ...over });
  const render = (rows: ResearchRequestPayload[], angles: AngleRequestPayload[] | null, busyId: number | null = null) => draw(renderBriefs, { view: researchRequestsView(rows, NOW, angles), busyId });

  it("a finished brief has a Make ideas button, enabled with no request; a brief with no brief has none", async () => {
    const html = await render([request(), request({ id: 8, status: "failed", brief: null })], []);
    expect(html.match(/data-test="brief-make-ideas"/g)).toHaveLength(1);
    expect(html).toContain("Make ideas");
    expect(html).not.toMatch(/data-test="brief-make-ideas"[^>]*disabled|disabled[^>]*data-test="brief-make-ideas"/);
    expect(html).not.toContain("brief-ideas-status");
  });

  it("while the worker has the request the button waits and the status line says so; the status words are the Meta form's", async () => {
    const waiting = await render([request()], [angleRow()]);
    expect(waiting).toMatch(/<button[^>]*disabled[^>]*data-test="brief-make-ideas"|<button[^>]*data-test="brief-make-ideas"[^>]*disabled/);
    expect(waiting).toContain("Waiting for the worker, asked 2 minutes ago.");
    expect(await render([request()], [angleRow({ status: "capped", detail: "research budget reached" })])).toContain("Not run, a cap was reached: research budget reached.");
    expect(await render([request()], [angleRow({ status: "refused", detail: "the brief is gone" })])).toContain("Refused: the brief is gone.");
    expect(await render([request()], [angleRow({ status: "failed", detail: "the run failed" })])).toContain("Failed: the run failed.");
    expect(await render([request()], [angleRow({ status: "pending" })], 7)).toContain("Sending…");
  });

  it("a done request shows its status and links to its Proposals by numeric id; a Meta's request with another key is not shown here", async () => {
    const html = await render([request()], [angleRow({ metaKey: "gta", status: "done", proposalIds: [90] }), angleRow({ status: "done", detail: "3 ideas", proposalIds: [11, 12, 13] })]);
    expect(html).toContain("3 ideas filed, asked 2 minutes ago.");
    expect([...html.matchAll(/href="(\/proposals\/\d+)"/g)].map((m) => m[1])).toEqual(["/proposals/11", "/proposals/12", "/proposals/13"]);
    expect(html).not.toContain("/proposals/90");
    expect(html).not.toMatch(/undefined|NaN|null/);
  });

  it("the page posts only the research request id, from the button's event, and never uses a raw HTML directive", async () => {
    const posted: unknown[] = [];
    expect(await submitTopicIdeas(async (body) => (posted.push(body), { id: 1, status: "pending", sourceUrl: null, urlDropped: false }), 7)).toEqual({ ok: true, note: "Sent. The worker will write three ideas next." });
    expect(posted).toEqual([{ researchRequestId: 7 }]);
    expect(await submitTopicIdeas(async () => { throw { data: { statusMessage: "You already pressed Make ideas for this brief in the last 24 hours" } }; }, 7)).toEqual({ ok: false, message: "You already pressed Make ideas for this brief in the last 24 hours" });
    const page = readFileSync(new URL("../../app/pages/research.vue", import.meta.url), "utf8");
    expect(page).toContain('@make="makeIdeas"');
    expect(page).toContain("/api/meme-angle");
    for (const f of ["pages/research.vue", "components/ResearchBriefs.vue", "components/MemeCard.vue"]) expect(readFileSync(new URL(`../../app/${f}`, import.meta.url), "utf8"), f).not.toContain("v-html");
    const briefs = readFileSync(new URL("../../app/components/ResearchBriefs.vue", import.meta.url), "utf8");
    expect(briefs).toContain("emit('make', r.id)");
  });
});
