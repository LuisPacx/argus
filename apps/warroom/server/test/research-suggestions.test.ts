import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Datastore } from "@argus/core";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESEARCH_TOPIC_MAX_CHARS } from "../../app/utils/research-brief.ts";
import { suggestionsView } from "../../app/utils/research-suggestions.ts";
import { tempDir } from "../../../../packages/core/src/testing/temp.ts";

/**
 * Radar suggestions on /research (human researcher ticket 07): the real RadarSuggestions.vue template rendered over the view built from the real
 * GET /api/radar response of a seeded store. Pressing a suggestion only emits the subject; no request row is written until the form posts.
 */
let store: Datastore;
let file: string;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("useStore", () => store);
const getRadar = (await import("../api/radar.get.ts")).default as unknown as () => Parameters<typeof suggestionsView>[0];

const NOW = Date.now();
const at = (minutes: number) => new Date(NOW - minutes * 60_000);

function dump(): string {
  const raw = new DatabaseSync(file);
  try {
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    return JSON.stringify(tables.map((t) => [t, raw.prepare(`SELECT * FROM "${t}"`).all()]));
  } finally {
    raw.close();
  }
}

beforeEach(() => {
  file = path.join(tempDir("warroom-suggest-"), "argus.db");
  store = Datastore.open(file);
});
afterEach(() => store.close());

function addTrend(term: string, key: string, minutesAgo: number, score = 40): number {
  const c = { trafficText: "2000+", trafficMin: 2_000, newsTitle: "A headline", newsUrl: "https://news.example/a", sourceId: "radar:google:US", key, term, at: at(0).toISOString() };
  store.radar.recordReading(c, at(minutesAgo).toISOString());
  store.radar.touchSeen(key, at(minutesAgo));
  return store.radar.createTrend({ key, label: term, firstSeen: at(minutesAgo).toISOString(), score, candidate: c });
}

type Vnode = { props?: Record<string, unknown> | null; children?: unknown };
type Render = (ctx: unknown, cache: unknown[]) => Vnode;
const sfc = parse(readFileSync(new URL("../../app/components/RadarSuggestions.vue", import.meta.url), "utf8"));
const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: "RadarSuggestions.vue", id: "rs" });
const render = new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;

const view = () => suggestionsView(getRadar());
const draw = (v: ReturnType<typeof suggestionsView>) => renderToString(createSSRApp({ render: () => render({ view: v, $emit: () => {} }, []) as ReturnType<typeof h> }));
function clickHandlers(node: unknown, found: Array<() => void> = []): Array<() => void> {
  if (!node || typeof node !== "object") return found;
  const n = node as Vnode;
  if (typeof n.props?.onClick === "function") found.push(n.props.onClick as () => void);
  const kids = Array.isArray(n.children) ? n.children : [];
  for (const k of kids) clickHandlers(k, found);
  return found;
}

describe("radar suggestions", () => {
  it("lists the live Trends newest first with score and sources, and says no Trends right now when there are none", async () => {
    expect(view().empty).toBe("no Trends right now");
    expect(await draw(view())).toContain("no Trends right now");
    addTrend("old one", "oldone", 300, 40);
    addTrend("fresh one", "freshone", 20, 55);
    const html = await draw(view());
    expect(html).not.toContain("no Trends right now");
    expect(html.indexOf("fresh one")).toBeLessThan(html.indexOf("old one"));
    expect(html).toContain("Score 55");
    expect(html).toContain("Score 40");
    expect(html).not.toMatch(/undefined|NaN/);
  });

  it("pressing a suggestion emits the plain subject and writes no request row; a GET changes no table", () => {
    addTrend("GTA", "gta", 10);
    const before = dump();
    const v = view();
    expect(dump()).toBe(before);
    const emitted: unknown[][] = [];
    const tree = render({ view: v, $emit: (...a: unknown[]) => emitted.push(a) }, []);
    const handlers = clickHandlers(tree);
    expect(handlers).toHaveLength(1);
    handlers[0]!();
    expect(emitted).toEqual([["pick", "GTA"]]);
    expect(store.researchRequests()).toEqual([]);
    expect(dump()).toBe(before);
  });

  it("a hostile subject is one escaped line, cut to the topic box length", async () => {
    const hostile = `<img src=x onerror=alert(1)>\n"><script>alert(2)</script>${"x".repeat(300)}`;
    addTrend(hostile, "hostile", 5);
    const v = view();
    expect(v.rows[0]!.topic).not.toMatch(/[\n\r]/);
    expect([...v.rows[0]!.topic].length).toBeLessThanOrEqual(RESEARCH_TOPIC_MAX_CHARS + 1);
    const html = await draw(v);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
  });
});
