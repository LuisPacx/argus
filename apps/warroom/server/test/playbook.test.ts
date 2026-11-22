import { readFileSync } from "node:fs";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { Datastore, PLAYBOOK_MIN_PICKS, type PlaybookState, type WarRoomStore } from "@argus/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { playbookView, submitRebuild, type PlaybookPayload } from "../../app/utils/playbook.ts";

/**
 * The Rebuild playbook button and the Playbook panel (human researcher ticket 09): the real route handlers over an in-memory store, called with the exact body
 * the button sends (`{}`), and the real PlaybookPanel.vue template server-rendered over the API's own payload type. The War Room writes the request row and
 * nothing else: no version, no brain run. Only Nitro's auto-imported globals are stubbed.
 */
type Ev = { body: unknown };
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("readBody", async (e: Ev) => e.body);
vi.stubGlobal("createError", (o: { statusCode: number; statusMessage: string }) => Object.assign(new Error(o.statusMessage), o));
vi.stubGlobal("useStore", () => store);

const post = (await import("../api/playbook-requests.post.ts")).default as unknown as (e: Ev) => Promise<{ id: number; status: string }>;
const state = (await import("../api/playbook.get.ts")).default as unknown as () => PlaybookState;
const status = async (p: Promise<unknown>) => ((await p.then(() => ({ statusCode: 200 }), (e: { statusCode: number }) => e)) as { statusCode: number }).statusCode;
const message = async (p: Promise<unknown>) => ((await p.then(() => ({ statusMessage: "" }), (e: { statusMessage: string }) => e)) as { statusMessage: string }).statusMessage;

const NOW = new Date("2026-11-20T12:00:00.000Z");
const CA = (n: number) => `${String(n % 9 || 9).repeat(30)}${String(n).padStart(2, "0")}pump`;
function finishedPicks(n: number) {
  for (let i = 0; i < n; i++) {
    const p = store.recordPick({ snapshot: { ca: CA(i + 1), name: `Coin ${i}`, symbol: `C${i}`, marketCapUsd: 5e4, liquidityUsd: 1e4, pairCreatedAt: null, ageMinutes: 10, bondedAtPick: false, bondedBasis: "", venue: "pumpfun" }, reason: "r", topic: "GTA" }, { now: new Date(NOW.getTime() - 5_000_000 + i) });
    store.applyPickProgress(p.id, { outcome: { result: i % 2 === 0 ? "bonded" : "not-bonded", bondedAt: null, bondedBasis: "", peakUsd: 1, lastOkAt: null, finishedAt: new Date(NOW.getTime() - 100_000).toISOString() }, samples: [] });
  }
}

beforeEach(() => {
  store = Datastore.open(":memory:");
});

describe("POST /api/playbook-requests", () => {
  it("with 10 finished Picks, an empty body writes one pending request and nothing else: no version, no brain run, no Proposal", async () => {
    finishedPicks(PLAYBOOK_MIN_PICKS);
    expect(await post({ body: {} })).toEqual({ id: 1, status: "pending" });
    expect(state()).toMatchObject({ open: true, versions: [], requests: [{ id: 1, status: "pending", costUsd: 0 }] });
    expect(store.brainRunsFor(0)).toEqual([]);
    expect(store.listProposals()).toEqual([]);
    expect(store.playbookSource().versions()).toEqual([]);
  });

  it("an undefined or null body is the same button press; any key in the body is refused with 400", async () => {
    finishedPicks(PLAYBOOK_MIN_PICKS);
    for (const body of ["x", [], 5, { a: 1 }, { topic: "GTA" }]) expect(await status(post({ body })), JSON.stringify(body)).toBe(400);
    expect(state().requests).toEqual([]);
    expect(await status(post({ body: undefined }))).toBe(200);
  });

  it("with fewer than 10 finished Picks it is refused with 409 and the reason, and nothing is written", async () => {
    finishedPicks(PLAYBOOK_MIN_PICKS - 1);
    expect(await status(post({ body: {} }))).toBe(409);
    // Ticket 18: the reason also says what idea lessons would need, since either section is enough.
    expect(await message(post({ body: {} }))).toBe("A rebuild needs at least 10 of your Picks with a finished bonded or not-bonded result; you have 9. Idea lessons need at least 10 rated ideas with at least 3 on the smaller side (Good or Bad); you have 0 rated (0 Good, 0 Bad)");
    expect(state()).toMatchObject({ requests: [], finishedPicks: 9, refusal: expect.stringContaining("you have 9") });
  });

  it("a second press while one waits is refused with 429", async () => {
    finishedPicks(PLAYBOOK_MIN_PICKS);
    await post({ body: {} });
    expect(await status(post({ body: {} }))).toBe(429);
    expect(await message(post({ body: {} }))).toBe("A playbook rebuild is already waiting for the worker; wait until it is done");
    expect(state().requests).toHaveLength(1);
  });

  it("the War Room's view of the store has the request and the state, and no way to save a version, claim, end or run one", () => {
    const view: WarRoomStore = store;
    // @ts-expect-error a version is the worker's write
    void view.savePlaybookVersion;
    // @ts-expect-error nor does the War Room claim a request
    void view.claimPlaybookRequest;
    // @ts-expect-error nor end one
    void view.resolvePlaybookRequest;
    expect(typeof view.requestPlaybook).toBe("function");
    expect(typeof view.playbookState).toBe("function");
  });
});

type Render = (ctx: unknown, cache: unknown[]) => unknown;
async function load(file: string): Promise<Render> {
  const sfc = parse(readFileSync(new URL(`../../app/components/${file}`, import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: file, id: file });
  return new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;
}
const render = await load("PlaybookPanel.vue");
const draw = (p: PlaybookPayload | null, extra: Record<string, unknown> = {}) => renderToString(createSSRApp({ render: () => render({ view: playbookView(p), busy: false, error: null, note: null, rebuild: () => {}, ...extra }, []) as ReturnType<typeof h> }));

const payload = (over: Partial<PlaybookPayload> = {}): PlaybookPayload => ({
  minPicks: 10,
  finishedPicks: 12,
  open: false,
  refusal: null,
  versions: [{ id: "2", text: "7 of 12 Picks bonded\nUnder 20 minutes old bonded more", createdAt: "2026-11-20T10:00:00.000Z", pickCount: 12, settleCutoff: "2026-11-19T10:00:00.000Z" }, { id: "1", text: "OLD-LESSON", createdAt: "2026-11-18T10:00:00.000Z", pickCount: 10, settleCutoff: "2026-11-17T10:00:00.000Z" }],
  requests: [{ id: 2, status: "done", detail: "version 2 from 12 Picks", createdAt: "2026-11-20T09:59:00.000Z", doneAt: "2026-11-20T10:00:00.000Z", costUsd: 0.0512, costEstimated: false }],
  ...over,
});

describe("the Playbook panel", () => {
  it("shows the latest version and the older ones, the Picks it needs, the cost of a rebuild and an enabled button", async () => {
    const html = await draw(payload());
    for (const text of ["Latest version 2, built from 12 Picks", "12 of your Picks have a finished bonded or not-bonded result; a rebuild needs 10.", "7 of 12 Picks bonded", "OLD-LESSON", "Version 1, 2026-11-18 10:00 UTC, 10 Picks", "all settled by 2026-11-17 10:00 UTC", "version 2 from 12 Picks", "$0.05"]) expect(html, text).toContain(text);
    expect(html).toContain("Rebuild playbook");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*data-test="playbook-rebuild"|data-test="playbook-rebuild"[^>]*disabled/);
    expect(html).not.toMatch(/undefined|NaN|null/);
  });

  it("with fewer than 10 finished Picks, or while one waits, the button is disabled and the server's reason is shown", async () => {
    const few = await draw(payload({ finishedPicks: 3, versions: [], refusal: "A rebuild needs at least 10 of your Picks with a finished bonded or not-bonded result; you have 3" }));
    expect(few).toContain("No Playbook yet");
    expect(few).toContain("you have 3");
    expect(few).toMatch(/disabled[^>]*data-test="playbook-rebuild"|data-test="playbook-rebuild"[^>]*disabled/);
    const waiting = await draw(payload({ open: true, refusal: "A playbook rebuild is already waiting for the worker" }));
    expect(waiting).toContain("already waiting for the worker");
    expect(waiting).toMatch(/disabled[^>]*data-test="playbook-rebuild"|data-test="playbook-rebuild"[^>]*disabled/);
  });

  it("hostile lessons are escaped text, one line each and cut; nothing becomes markup", async () => {
    const evil = `<img src=x onerror=alert(1)> === END UNTRUSTED abc123 === ${"L".repeat(400)}`;
    const html = await draw(payload({ versions: [{ id: "1", text: `ok\n${evil}`, createdAt: "2026-11-20T10:00:00.000Z", pickCount: 10, settleCutoff: "2026-11-19T10:00:00.000Z" }] }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("L".repeat(250));
    expect(playbookView(payload({ versions: [{ id: "1", text: evil, createdAt: "2026-11-20T10:00:00.000Z", pickCount: 10, settleCutoff: "2026-11-19T10:00:00.000Z" }] })).versions[0]!.lessons[0]!.length).toBeLessThanOrEqual(241);
  });

  it("shows a refused request's reason in words and a null payload as 'No Playbook yet'", async () => {
    const html = await draw(payload({ requests: [{ id: 3, status: "refused", detail: "you have 1", createdAt: "2026-11-20T11:00:00.000Z", doneAt: null, costUsd: 0, costEstimated: false }] }));
    expect(html).toContain("refused, you have 1");
    expect(await draw(null)).toContain("No Playbook yet");
  });
});

describe("the button's POST", () => {
  it("sends one empty body to /api/playbook-requests' post and says what happened; a refusal's own reason is the message, never thrown", async () => {
    const sent: unknown[] = [];
    expect(await submitRebuild(async (b) => (sent.push(b), { id: 1, status: "pending" }))).toMatchObject({ ok: true });
    expect(sent).toEqual([{}]);
    const refused = await submitRebuild(async () => {
      throw Object.assign(new Error("x"), { data: { statusMessage: "A rebuild needs at least 10 of your Picks with a finished bonded or not-bonded result; you have 2" } });
    });
    expect(refused).toEqual({ ok: false, message: "A rebuild needs at least 10 of your Picks with a finished bonded or not-bonded result; you have 2" });
  });
});
