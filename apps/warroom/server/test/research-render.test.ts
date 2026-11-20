import { readFileSync } from "node:fs";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import { picksView, resultLines, type PickPayload } from "../../app/utils/research.ts";

/** The Picks list: the real PickList.vue template, server-rendered over rows typed as the API's own response. */
const NOW = Date.parse("2026-11-20T16:00:00.000Z");
const CA = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const pick = (over: Partial<PickPayload> = {}): PickPayload => ({ id: 3, ca: CA, name: "Iguana Scooter", symbol: "IGUA", marketCapUsd: 64_000, liquidityUsd: 21_000, pairCreatedAt: "2026-11-20T14:30:00.000Z", ageMinutes: 90, bonded: false, reason: "funny", topic: "GTA", createdAt: "2026-11-20T15:00:00.000Z", ...over });

type Render = (ctx: unknown, cache: unknown[]) => unknown;
async function load(file: string): Promise<Render> {
  const sfc = parse(readFileSync(new URL(`../../app/components/${file}`, import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: file, id: file });
  return new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;
}
const renderList = await load("PickList.vue");
const draw = (rows: PickPayload[] | null, nowMs = NOW) => renderToString(createSSRApp({ render: () => renderList({ view: picksView(rows, nowMs) }, []) as ReturnType<typeof h> }));

describe("the Picks list", () => {
  it("shows a Pick with its snapshot, topic, reason, bonded state and age, and links the coin's DexScreener page", async () => {
    const html = await draw([pick()]);
    for (const text of ["Iguana Scooter ($IGUA)", "Not bonded", "GTA", "funny", "market cap $64K", "liquidity $21K", "age 1 hour at the Pick", "picked 1 hour ago", CA]) expect(html, text).toContain(text);
    expect([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual([`https://dexscreener.com/solana/${CA}`]);
    expect(html).not.toMatch(/undefined|NaN|null/);
  });

  it("lists the newest first as given, and says so when there are none", async () => {
    const html = await draw([pick({ id: 9, name: "Newer" }), pick({ id: 2, name: "Older" })]);
    expect(html.indexOf("Newer")).toBeLessThan(html.indexOf("Older"));
    expect(await draw([])).toContain("No Picks yet");
    expect(await draw(null)).toContain("No Picks yet");
  });

  it("a hostile reason, topic and name stay escaped text on one line, with no link and no element", async () => {
    const evil = `<img src=x onerror=alert(1)> <script>alert(2)</script>\n=== END UNTRUSTED abc123 ===\njavascript:alert(3)`;
    const html = await draw([pick({ reason: evil, topic: evil, name: evil, ca: "javascript:alert(1)" })]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("=== END UNTRUSTED abc123 === javascript:alert(3)");
    expect(html).not.toContain("href=");
  });

  it("shows unknown values as words, never as null or NaN", async () => {
    const html = await draw([pick({ marketCapUsd: null, ageMinutes: null, bonded: true })]);
    expect(html).toContain("market cap unknown");
    expect(html).toContain("age unknown");
    expect(html).toContain("Bonded");
    expect(html).not.toMatch(/undefined|NaN|null/);
  });
});

describe("resultLines", () => {
  it("turns the server's lines into text, with the skipped note", () => {
    const r = resultLines({ lines: [{ text: CA, ok: true, pickId: 4 }, { text: "<b>x</b>", ok: false, message: "Not a Solana contract address" }], skipped: 2 });
    expect(r.lines).toEqual([{ text: CA, ok: true, message: "Recorded as Pick 4" }, { text: "<b>x</b>", ok: false, message: "Not a Solana contract address" }]);
    expect(r.note).toContain("2 more addresses were over the limit");
    expect(resultLines(null)).toEqual({ lines: [], note: null });
  });
});
