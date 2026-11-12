import { readFileSync } from "node:fs";
import { BUILD_TICK_MS, Datastore } from "@argus/core";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import { buildNoticeView } from "../../app/utils/build-notice.ts";
import type { ProposalBuildStatus } from "../utils/build-status.ts";

/** The API (real route handler, Nitro globals stubbed) and the notice's rendering (the real BuildNotice.vue template, server-rendered). */
type Ev = { params: Record<string, string> };
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("getRouterParam", (e: Ev, k: string) => e.params[k]);
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);
vi.stubGlobal("useDataDir", () => "/argus/data");
vi.stubGlobal("useBuildRoot", () => "/builds/code");

type Api = { status: string } & ProposalBuildStatus;
const get = (await import("../api/proposals/[id].get.ts")).default as unknown as (e: Ev) => Api;
const api = (id: number) => get({ params: { id: String(id) } });

const NOW = Date.parse("2026-11-11T20:00:00.000Z");
const base = { narrativeSummary: "s", techOneLiner: "t", whyNow: "w", description: "d", evidenceLinks: [] };
let n = 0;
function proposal(status: "new" | "approved" | "building") {
  const p = store.createProposal({ ...base, name: `P${++n}`, ticker: `T${n}`, evidenceLinks: [] });
  if (status === "new") return p.id;
  store.transition(p.id, "shortlisted", "operator");
  store.completeSpec(p.id, { path: "/x", hash: "h" });
  store.transition(p.id, "approved", "operator");
  if (status === "building") store.beginBuild(p.id, { backend: "claude-code", model: "m" });
  return p.id;
}

beforeEach(() => {
  store = Datastore.open(":memory:");
  n = 0;
});

type Render = (ctx: unknown, cache: unknown[]) => unknown;
async function load(file: string): Promise<Render> {
  const sfc = parse(readFileSync(new URL(`../../app/components/${file}`, import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: file, id: file });
  return new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;
}
const renderNotice = await load("BuildNotice.vue");
async function draw(p: Api): Promise<string> {
  const view = buildNoticeView(p, NOW);
  if (!view) return "";
  return renderToString(createSSRApp({ render: () => renderNotice({ view }, []) as ReturnType<typeof h> }));
}
const withRefusal = (p: Api, message: string, secondsAgo = 12): Api => ({ ...p, buildRefusal: { code: "image-missing", message, at: new Date(NOW - secondsAgo * 1000).toISOString() } });

it("the API carries { code, message, at } for an approved Proposal, null for the rest, and the tick in seconds", () => {
  const a = proposal("approved");
  expect(api(a).buildRefusal).toBeNull();
  store.recordBuildRefusal({ code: "image-missing", message: "the Build image x is not present" });
  const r = api(a);
  expect(Object.keys(r.buildRefusal!).sort()).toEqual(["at", "code", "message"]);
  expect(r.buildRefusal).toMatchObject({ code: "image-missing", message: "the Build image x is not present" });
  expect(r.buildRetrySeconds).toBe(BUILD_TICK_MS / 1000);
  expect(r.buildRunning).toBe(false);
  expect(api(proposal("new")).buildRefusal).toBeNull();
});

it("the retry interval is the worker's tick: the worker's one TICK_MS is BUILD_TICK_MS, and that is what its timers use", () => {
  const main = readFileSync(new URL("../../../worker/src/main.ts", import.meta.url), "utf8");
  expect(main).toMatch(/^const TICK_MS = BUILD_TICK_MS;/m);
  expect(main).toMatch(/void runBuildTick\(\);\n {2}\}, TICK_MS\);/);
});

it("approved with a refusal: the message, the interval and the last-checked age", async () => {
  const html = await draw(withRefusal({ ...api(proposal("approved")) }, "the Build token file /home/u/.config/argus/build-token does not exist"));
  expect(html).toContain("Build not started: the Build token file /home/u/.config/argus/build-token does not exist, retried every 5 s");
  expect(html).toContain("last checked 12 s ago");
});

it("approved without one: waiting for the next tick; behind a running Build: the running-Build wording", async () => {
  const a = proposal("approved");
  expect(await draw(api(a))).toContain("Waiting for the next build tick");
  const b = proposal("approved");
  store.transition(a, "building", "build");
  const html = await draw(api(b));
  expect(html).toContain("Waiting for the running Build to finish");
  expect(html).not.toContain("next build tick");
});

it("any other status shows none of the three", async () => {
  for (const id of [proposal("new"), proposal("building")]) {
    const html = await draw(api(id));
    expect(html).not.toMatch(/Build not started|Waiting for/);
  }
  const stale = withRefusal({ ...api(proposal("new")) }, "x");
  expect(await draw(stale)).toBe("");
});

it("a message holding markup and a javascript: URL renders as text", async () => {
  const evil = `<img src=x onerror=alert(1)> <a href="javascript:alert(1)">go</a> javascript:alert(1)`;
  const html = await draw(withRefusal({ ...api(proposal("approved")) }, evil));
  expect(html).not.toContain("<img");
  expect(html).not.toMatch(/<a /);
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
});

const renderMarker = await load("BuildBlockedMarker.vue");
async function drawMarker(p: Api): Promise<string> {
  const view = buildNoticeView(p, NOW);
  return renderToString(createSSRApp({ render: () => renderMarker({ view }, []) as ReturnType<typeof h> }));
}

it("the title-card marker shows a fixed label linking to the notice, only for an approved Proposal with a refusal", async () => {
  const html = await drawMarker(withRefusal({ ...api(proposal("approved")) }, "the Build token file /home/u/.config/argus/build-token does not exist"));
  expect(html).toContain("Build blocked");
  expect(html).toContain('href="#build-notice"');
  expect(html).not.toContain("build-token");
  expect(html).not.toContain("/home/u");
});

it("the marker is absent without a refusal, behind a running Build, and for any other status", async () => {
  const a = proposal("approved");
  expect(await drawMarker(api(a))).not.toContain("Build blocked");
  const b = proposal("approved");
  store.transition(a, "building", "build");
  expect(await drawMarker(api(b))).not.toContain("Build blocked");
  expect(await drawMarker(api(proposal("new")))).not.toContain("Build blocked");
  expect(await drawMarker(withRefusal({ ...api(proposal("new")) }, "x"))).not.toContain("Build blocked");
  expect(await drawMarker(withRefusal({ ...api(proposal("building")) }, "x"))).not.toContain("Build blocked");
});
