import { readFileSync } from "node:fs";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { Datastore, SCOREBOARD_MIN_PICKS, type Scoreboard } from "@argus/core";
import { describe, expect, it, vi } from "vitest";
import { scoreboardView, type ScoreboardPayload } from "../../app/utils/research-scoreboard.ts";

/**
 * The Scoreboard on /research (human researcher ticket 08): the real ResearchScoreboard.vue template, server-rendered over the payload typed as the API's own
 * response (core's `Scoreboard`), and the real GET /api/scoreboard handler over an in-memory store.
 */
const stats = (finished: number, bonded: number, over: Partial<Scoreboard["operator"]> = {}): Scoreboard["operator"] => ({ bonded, finished, rate: finished === 0 ? null : bonded / finished, alreadyBonded: 0, unknown: 0, pending: 0, ...over });
const board = (over: Partial<Scoreboard> = {}): Scoreboard => ({
  windowDays: 7,
  minPicks: SCOREBOARD_MIN_PICKS,
  operator: stats(20, 5),
  machine: stats(20, 8),
  topics: ["GTA", "Chess"],
  operatorOutside: stats(3, 1, { pending: 2 }),
  machineOutside: stats(0, 0),
  verdict: { kind: "machine", text: "The machine is ahead: 40% against 25%." },
  ...over,
});

type Render = (ctx: unknown, cache: unknown[]) => unknown;
async function load(file: string): Promise<Render> {
  const sfc = parse(readFileSync(new URL(`../../app/components/${file}`, import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: file, id: file });
  return new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;
}
const render = await load("ResearchScoreboard.vue");
const draw = (b: Scoreboard | null) => renderToString(createSSRApp({ render: () => render({ view: scoreboardView(b as ScoreboardPayload | null) }, []) as ReturnType<typeof h> }));
const kindOf = (html: string) => /data-kind="([^"]+)"/.exec(html)?.[1];

describe("the Scoreboard", () => {
  it("shows each side's rate with its n, the topics compared, the rows left out, the window and the 20 Pick rule, and the verdict at 20 each", async () => {
    const html = await draw(board());
    for (const text of ["Scoreboard: Operator against machine", "Bonded within 24 hours of the Pick, last 7 days.", `No verdict is drawn until each side has ${SCOREBOARD_MIN_PICKS} finished Picks.`, "25%", "n=20 (5 bonded)", "40%", "n=20 (8 bonded)", "Topics compared", "GTA, Chess", "Operator, no topic or a topic the machine did not pick on: 33%, n=3 (1 bonded)", "2 not finished yet", "The machine is ahead: 40% against 25%."]) expect(html, text).toContain(text);
    // One line says what is counted; the old "outside the brief lists" row and wording are gone.
    expect(html).toContain("Counted: every Operator Pick on those topics (withdrawn ones left out), against the machine&#39;s picks from the brief lists.");
    expect(html.match(/data-test="scoreboard-counted"/g)).toHaveLength(1);
    expect(html).not.toContain("Operator, not compared");
    expect(html).not.toContain("from a brief&#39;s list");
    expect(kindOf(html)).toBe("machine");
    expect(html).not.toMatch(/undefined|NaN|null/);
  });

  it("says 'not enough Picks yet' and names no winner when either side has fewer than 20, even if core sent a leader", async () => {
    for (const [o, m] of [[19, 20], [20, 19], [0, 0], [3, 40]] as const) {
      const html = await draw(board({ operator: stats(o, o), machine: stats(m, 0) }));
      expect(html, `${o}/${m}`).toContain("Not enough Picks yet: a verdict needs 20 finished Picks on each side.");
      expect(kindOf(html), `${o}/${m}`).toBe("not-enough");
      expect(html, `${o}/${m}`).not.toContain("is ahead");
    }
    const real = await draw(board({ operator: stats(5, 2), machine: stats(5, 1), verdict: { kind: "not-enough", text: "Not enough Picks yet: ..." } }));
    expect(kindOf(real)).toBe("not-enough");
    expect(real).not.toContain("is ahead");
  });

  it("an empty side shows 'no finished Picks yet', never 0%, and no data at all still prints the rule", async () => {
    const html = await draw(board({ operator: stats(0, 0), machine: stats(0, 0), topics: [], verdict: { kind: "not-enough", text: "x" } }));
    expect(html).toContain("no finished Picks yet");
    expect(html).toContain("No topic has Picks from both sides yet.");
    expect(html).not.toContain("0%");
    const none = await draw(null);
    expect(none).toContain("No verdict is drawn until each side has 20 finished Picks.");
    expect(none).toContain("no finished Picks yet");
    expect(kindOf(none)).toBe("not-enough");
  });

  it("shows a tie when core says level at 20 each", async () => {
    const html = await draw(board({ operator: stats(20, 6), machine: stats(20, 6), verdict: { kind: "level", text: "Level: both at 30%." } }));
    expect(html).toContain("Level: both at 30%.");
  });

  it("shows a hostile topic as escaped text, cut to a line", async () => {
    const html = await draw(board({ topics: [`<img src=x onerror=alert(1)> ${"T".repeat(300)}`] }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("GET /api/scoreboard", () => {
  it("returns core's Scoreboard from the store, read only", async () => {
    const store = Datastore.open(":memory:");
    vi.stubGlobal("defineEventHandler", (f: unknown) => f);
    vi.stubGlobal("useStore", () => store);
    const handler = (await import("../api/scoreboard.get.ts")).default as unknown as () => Scoreboard;
    const s = handler();
    expect(s).toMatchObject({ windowDays: 7, minPicks: 20, topics: [] });
    expect(s.verdict.kind).toBe("not-enough");
    vi.unstubAllGlobals();
  });
});
