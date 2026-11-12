import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Datastore } from "@argus/core";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import type { CleanupView } from "../../app/utils/cleanup-view.ts";

/** The API (real route handlers, Nitro globals stubbed), the "Clean up build" card (the real template, server-rendered) and the page's wiring. */
type Ev = { params: Record<string, string>; body?: unknown };
let store: Datastore;
const roots: string[] = [];
let buildRoot = "";
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("getRouterParam", (e: Ev, k: string) => e.params[k]);
vi.stubGlobal("readBody", async (e: Ev) => e.body);
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);
vi.stubGlobal("useDataDir", () => "/argus/data");
vi.stubGlobal("useBuildRoot", () => buildRoot);

const get = (await import("../api/proposals/[id].get.ts")).default as unknown as (e: Ev) => { status: string; cleanup: CleanupView };
const post = (await import("../api/proposals/[id]/commands.post.ts")).default as unknown as (e: Ev) => Promise<unknown>;
const view = (id: number) => get({ params: { id: String(id) } }).cleanup;
const send = (id: number, body: unknown) => post({ params: { id: String(id) }, body });
const code = async (p: Promise<unknown>) => ((await p.then(() => ({ statusCode: 200 }), (e: { statusCode: number }) => e)) as { statusCode: number }).statusCode;

const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const base = { narrativeSummary: "s", techOneLiner: "t", whyNow: "w", description: "d", evidenceLinks: [] };
let n = 0;
function dismissed(): number {
  const p = store.createProposal({ ...base, name: `Bar ${++n}`, ticker: `T${n}` });
  store.transition(p.id, "shortlisted", "operator");
  store.transition(p.id, "spec-drafted", "system");
  store.transition(p.id, "dismissed", "operator", "no");
  return p.id;
}
function toBuilt(): number {
  const p = store.createProposal({ ...base, name: `Bar ${++n}`, ticker: `T${n}` });
  store.transition(p.id, "shortlisted", "operator");
  store.transition(p.id, "spec-drafted", "system");
  store.transition(p.id, "approved", "operator");
  store.transition(p.id, "building", "build");
  store.completeBuild(p.id, { previewUrl: "https://x.workers.dev" });
  return p.id;
}
function checkout(slug: string, origin: string | null) {
  mkdirSync(join(buildRoot, slug, ".git"), { recursive: true });
  const o = origin === null ? "" : `[remote "origin"]\n\turl = ${origin}\n`;
  writeFileSync(join(buildRoot, slug, ".git", "config"), `[remote "template"]\n\turl = /t\n${o}`);
}
const slugOf = (id: number) => store.getProposal(id)!.slug;

beforeEach(() => {
  store = Datastore.open(":memory:");
  n = 0;
  buildRoot = mkdtempSync(join(tmpdir(), "argus-cleanview-"));
  roots.push(buildRoot);
});
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

it("a dismissed Proposal with a recorded repo, a Worker and a checkout offers Clean up, with each artifact found", () => {
  const id = dismissed();
  const slug = slugOf(id);
  store.markWorkerDeployed(id);
  store.recordBuildRepo(id, `luis/${slug}`);
  checkout(slug, `https://github.com/luis/${slug}.git`);
  expect(view(id)).toEqual({
    available: true,
    refusal: null,
    plan: { worker: { name: slug, found: true }, repo: { name: `luis/${slug}`, found: true, legacy: false }, directory: { path: join(buildRoot, slug), found: true, removable: true } },
    confirmName: null,
    results: [],
    cleaned: false,
  });
});

it("marks what is not there as not found, and offers nothing when there is nothing", () => {
  const id = dismissed();
  expect(view(id)).toMatchObject({ available: false, refusal: null });
  store.markWorkerDeployed(id);
  expect(view(id)).toMatchObject({ available: true, plan: { directory: { found: false }, repo: { name: null, found: false } } });
});

it("never offers it for built, approved or launched Proposals, nor for a launched one that was closed or dismissed", () => {
  const built = toBuilt();
  store.markWorkerDeployed(built);
  expect(view(built)).toMatchObject({ available: false, plan: null });
  const launched = toBuilt();
  store.markWorkerDeployed(launched);
  store.markLaunched(launched, MINT);
  expect(view(launched)).toMatchObject({ available: false, plan: null });
  store.transition(launched, "closed", "operator");
  expect(view(launched)).toMatchObject({ available: false, plan: null, refusal: expect.stringContaining("launched") as unknown });
  const dismissedLaunched = toBuilt();
  store.markWorkerDeployed(dismissedLaunched);
  store.markLaunched(dismissedLaunched, MINT.slice(0, -1) + "2");
  store.transition(dismissedLaunched, "dismissed", "operator", "x");
  expect(view(dismissedLaunched)).toMatchObject({ available: false, plan: null, refusal: expect.stringContaining("launched") as unknown });
});

it("a build-failed Proposal is offered it, and a cleaned one is not", () => {
  const id = toBuilt();
  store.transition(id, "dismissed", "operator", "x");
  store.markWorkerDeployed(id);
  expect(view(id).available).toBe(true);
  store.recordCleanup(id, [`Clean up: Worker ${slugOf(id)} deleted`], true);
  expect(view(id)).toMatchObject({ available: false, cleaned: true, results: [`Worker ${slugOf(id)} deleted`] });
});

it("a checkout argus cannot prove is the Build's is shown as one to remove by hand, with its path", async () => {
  const id = dismissed();
  const slug = slugOf(id);
  store.markWorkerDeployed(id);
  checkout(slug, null); // the Build failed before gh repo create: only the template remote
  const v = view(id);
  expect(v).toMatchObject({ available: true, plan: { directory: { path: join(buildRoot, slug), found: true, removable: false } } });
  const html = await draw(v);
  expect(html).toContain("will not remove the directory");
  expect(html).toContain(join(buildRoot, slug));
  expect(html).toContain("Remove it by hand");
  // a removable checkout says nothing of the kind
  const ok = dismissed();
  store.markWorkerDeployed(ok);
  store.recordBuildRepo(ok, `luis/${slugOf(ok)}`);
  checkout(slugOf(ok), `https://github.com/luis/${slugOf(ok)}.git`);
  expect(await draw(view(ok))).not.toContain("by hand");
});

it("a dismissed Proposal whose Build is still running is not offered Clean up", async () => {
  const p = store.createProposal({ ...base, name: "Live", ticker: "LV" });
  store.transition(p.id, "shortlisted", "operator");
  store.transition(p.id, "spec-drafted", "system");
  store.transition(p.id, "approved", "operator");
  store.beginBuild(p.id, { backend: "claude-code", model: "m" });
  store.markWorkerDeployed(p.id);
  store.transition(p.id, "dismissed", "operator", "x");
  expect(view(p.id)).toMatchObject({ available: false, plan: null, refusal: expect.stringContaining("still running") as unknown });
  expect(await code(send(p.id, { type: "cleanup-build" }))).toBe(409);
  expect(store.listCommands()).toEqual([]);
});

it("the results are the latest run's lines only", () => {
  const id = dismissed();
  store.markWorkerDeployed(id);
  store.recordCleanup(id, ["Clean up: Worker a failed: x", "Clean up: repo b failed: x", "Clean up: directory c failed: x"], false);
  store.recordCleanup(id, ["Clean up: Worker a deleted", "Clean up: repo b already gone", "Clean up: directory c deleted"], true);
  expect(view(id).results).toEqual(["Worker a deleted", "repo b already gone", "directory c deleted"]);
});

it("a legacy Build asks for its repo name to be typed", () => {
  const id = dismissed();
  const slug = slugOf(id);
  checkout(slug, `https://github.com/luis/${slug}.git`);
  expect(view(id)).toMatchObject({ available: true, confirmName: `luis/${slug}`, plan: { repo: { legacy: true, found: true } } });
});

it("the command route queues nothing for a status that cannot be cleaned, and the worker is left to decide the rest", async () => {
  const built = toBuilt();
  store.markWorkerDeployed(built);
  expect(await code(send(built, { type: "cleanup-build" }))).toBe(409);
  const launched = toBuilt();
  store.markWorkerDeployed(launched);
  store.markLaunched(launched, MINT);
  store.transition(launched, "closed", "operator");
  expect(await code(send(launched, { type: "cleanup-build" }))).toBe(409);
  const empty = dismissed();
  expect(await code(send(empty, { type: "cleanup-build" }))).toBe(409);
  expect(store.listCommands()).toEqual([]);

  const ok = dismissed();
  store.markWorkerDeployed(ok);
  expect(await code(send(ok, { type: "cleanup-build", reason: "ignored" }))).toBe(200);
  expect(store.listCommands()).toMatchObject([{ proposalId: ok, type: "cleanup-build", reason: "", status: "pending" }]);
});

it("the command route needs the typed repo name for a legacy Build", async () => {
  const id = dismissed();
  const slug = slugOf(id);
  checkout(slug, `https://github.com/luis/${slug}.git`);
  expect(await code(send(id, { type: "cleanup-build" }))).toBe(400);
  expect(await code(send(id, { type: "cleanup-build", reason: slug }))).toBe(400);
  expect(store.listCommands()).toEqual([]);
  expect(await code(send(id, { type: "cleanup-build", reason: ` luis/${slug} ` }))).toBe(200);
  expect(store.listCommands()).toMatchObject([{ type: "cleanup-build", reason: `luis/${slug}` }]);
});

type Render = (ctx: unknown, cache: unknown[]) => unknown;
async function load(file: string): Promise<Render> {
  const sfc = parse(readFileSync(new URL(`../../app/components/${file}`, import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: file, id: file });
  return new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;
}
const renderCard = await load("BuildArtifacts.vue");
const draw = (v: CleanupView, disabled = false) => renderToString(createSSRApp({ render: () => renderCard({ view: v, disabled, $emit: () => {} }, []) as ReturnType<typeof h> }));
const card = (over: Partial<CleanupView> = {}): CleanupView => ({
  available: true,
  refusal: null,
  plan: { worker: { name: "bar-1", found: true }, repo: { name: "luis/bar-1", found: false, legacy: false }, directory: { path: "/home/x/code/bar-1", found: true, removable: true } },
  confirmName: null,
  results: [],
  cleaned: false,
  ...over,
});

it("the card lists the Worker, repo and directory, each found or not found, and the button", async () => {
  const html = await draw(card());
  expect(html).toContain("Worker <code>bar-1</code>: found");
  expect(html).toContain("GitHub repo <code>luis/bar-1</code>: not found");
  expect(html).toContain("/home/x/code/bar-1");
  expect(html).toContain("Clean up build");
  expect(html).not.toContain("disabled");
  expect(await draw(card(), true)).toContain("disabled");
  expect(await draw(card({ available: false }))).not.toContain("cleanup-open");
});

it("the card draws results as text, including the fix for a missing scope, and escapes markup", async () => {
  const html = await draw(card({ results: ["repo luis/bar-1 failed: GitHub refused. Run: gh auth refresh -h github.com -s delete_repo, then Clean up build again", "directory <img src=x onerror=alert(1)> deleted"] }));
  expect(html).toContain("gh auth refresh -h github.com -s delete_repo");
  expect(html).toContain("&lt;img src=x");
  expect(html).not.toContain("<img");
});

it("the page queues nothing until the Operator confirms, uses no raw HTML or external link, and disables the buttons while a command is in flight", () => {
  const page = readFileSync(new URL("../../app/pages/proposals/[id].vue", import.meta.url), "utf8");
  const component = readFileSync(new URL("../../app/components/BuildArtifacts.vue", import.meta.url), "utf8");
  expect(page).not.toContain("v-html");
  expect(component).not.toContain("v-html");
  // The card's button only opens the dialog; the command is sent by the dialog's confirm.
  expect(page).toContain('@open="confirmingCleanup = true"');
  expect(page).toMatch(/@confirm="confirmCleanup"/);
  expect(page.match(/send\("cleanup-build"/g)).toHaveLength(1);
  expect(page).toContain(':disabled="working || sending"');
  const dialog = page.slice(page.indexOf('data-test="cleanup-plan"') - 600, page.indexOf("</ConfirmModal>", page.indexOf('data-test="cleanup-plan"')));
  expect(dialog).not.toMatch(/href=|<a[ >]|NuxtLink|UrlLink/);
});
