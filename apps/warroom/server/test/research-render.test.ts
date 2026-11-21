import { readFileSync } from "node:fs";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import type { PickOutcomeView } from "@argus/core";
import { safeHttpUrl } from "../../app/utils/safe-link.ts";
import { picksView, resultLines, type PickPayload } from "../../app/utils/research.ts";

/** The Picks list: the real PickList.vue template, server-rendered over rows typed as the API's own response. */
const NOW = Date.parse("2026-11-20T16:00:00.000Z");
const CA = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const pick = (over: Partial<PickPayload> = {}): PickPayload => ({ id: 3, ca: CA, name: "Iguana Scooter", symbol: "IGUA", marketCapUsd: 64_000, liquidityUsd: 21_000, pairCreatedAt: "2026-11-20T14:30:00.000Z", ageMinutes: 90, bondedAtPick: false, venue: "pumpfun", reason: "funny", topic: "GTA", createdAt: "2026-11-20T15:00:00.000Z", ...over });

type Render = (ctx: unknown, cache: unknown[]) => unknown;
async function load(file: string): Promise<Render> {
  const sfc = parse(readFileSync(new URL(`../../app/components/${file}`, import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: file, id: file });
  return new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;
}
const renderList = await load("PickList.vue");
const draw = (rows: PickPayload[] | null, nowMs = NOW, outcomes?: PickOutcomeView) => renderToString(createSSRApp({ render: () => renderList({ view: picksView(rows, nowMs, outcomes), safeHttpUrl }, []) as ReturnType<typeof h> }));

describe("the Picks list", () => {
  it("shows a Pick with its snapshot, topic, reason, bonded state and age, and links the coin's DexScreener page", async () => {
    const html = await draw([pick()]);
    for (const text of ["Iguana Scooter ($IGUA)", "Not bonded at pick", "on pumpfun", "GTA", "funny", "market cap $64K", "liquidity $21K", "age 1 hour at the Pick", "picked 1 hour ago", CA]) expect(html, text).toContain(text);
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
    const html = await draw([pick({ marketCapUsd: null, ageMinutes: null, bondedAtPick: true })]);
    expect(html).toContain("market cap unknown");
    expect(html).toContain("age unknown");
    expect(html).toContain("Bonded at pick");
    expect(html).not.toMatch(/undefined|NaN|null/);
  });
});

/** Ticket 04: the outcome line, the peaks and the bonding rate, typed as the API's own response (core's `PickOutcomeView`). */
const stats = (over: Partial<PickOutcomeView["all"]> = {}): PickOutcomeView["all"] => ({ bonded: 0, finished: 0, rate: null, alreadyBonded: 0, unknown: 0, pending: 0, ...over });
const outcomes = (over: Partial<PickOutcomeView> = {}): PickOutcomeView => ({ outcomes: [], all: stats(), week: stats(), ...over });
const marks = (states: PickOutcomeView["outcomes"][number]["marks"]) => states;

describe("pick outcomes on the page", () => {
  it("reads pending before the 24 hours are over, then bonded yes or no with the peaks", async () => {
    const waiting = marks([{ mark: "1h", state: "sampled", peakUsd: 90_000 }, { mark: "6h", state: "waiting", peakUsd: null }, { mark: "24h", state: "waiting", peakUsd: null }]);
    const pending = await draw([pick()], NOW, outcomes({ outcomes: [{ pickId: 3, result: "pending", over: false, bondedAt: null, marks: waiting }] }));
    expect(pending).toContain("Outcome: pending");
    expect(pending).toContain("+1h peak $90K, +6h waiting, +24h waiting");
    const yes = await draw([pick()], NOW, outcomes({ outcomes: [{ pickId: 3, result: "bonded", over: true, bondedAt: "2026-11-20T18:00:00.000Z", marks: [{ mark: "24h", state: "missed", peakUsd: null }] }] }));
    expect(yes).toContain("Outcome: bonded within 24h");
    expect(yes).toContain("+24h missed");
    const no = await draw([pick()], NOW, outcomes({ outcomes: [{ pickId: 3, result: "not-bonded", over: true, bondedAt: null, marks: [] }] }));
    expect(no).toContain("Outcome: did not bond within 24h");
  });

  it("a coin that was bonded at the Pick reads already bonded, and a vanished one unknown", async () => {
    expect(await draw([pick({ bondedAtPick: true })], NOW, outcomes())).toContain("Outcome: already bonded");
    const unknown = await draw([pick()], NOW, outcomes({ outcomes: [{ pickId: 3, result: "unknown", over: true, bondedAt: null, marks: [] }] }));
    expect(unknown).toContain("Outcome: unknown");
  });

  it("shows the rate with n for all time and 7 days, and the left-out counts", async () => {
    const html = await draw([pick()], NOW, outcomes({ all: stats({ bonded: 2, finished: 5, rate: 0.4, alreadyBonded: 1, unknown: 2, pending: 3 }), week: stats({ bonded: 1, finished: 2, rate: 0.5 }) }));
    expect(html).toContain("All time: 40% bonded within 24h (2 of 5 finished Picks, n=5)");
    expect(html).toContain("Last 7 days: 50% bonded within 24h (1 of 2 finished Picks, n=2)");
    expect(html).toContain("1 already bonded at the Pick, 2 unknown (coin vanished or could not be checked), 3 pending");
  });

  it("an empty set reads no finished Picks yet, never 0%", async () => {
    const html = await draw([pick()], NOW, outcomes());
    expect(html).toContain("All time: no finished Picks yet");
    expect(html).toContain("Last 7 days: no finished Picks yet");
    expect(html).not.toContain("0%");
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

/** Ticket 10: the Withdraw button and the struck-through withdrawn Pick. */
describe("withdrawing on the page", () => {
  const FRESH = "2026-11-20T15:55:00.000Z"; // 5 minutes before NOW
  it("shows the button only on an Operator Pick younger than 10 minutes", async () => {
    expect(await draw([pick({ createdAt: FRESH })])).toContain('data-test="pick-withdraw"');
    expect(await draw([pick({ createdAt: "2026-11-20T15:49:00.000Z" })])).not.toContain("pick-withdraw"); // 11 minutes
    expect(await draw([pick({ createdAt: FRESH, source: "shadow" })])).not.toContain("pick-withdraw");
    expect(await draw([pick({ createdAt: FRESH })], NOW + 6 * 60_000)).not.toContain("pick-withdraw"); // the page ticking past 10 minutes
  });

  it("shows a withdrawn Pick struck through and with no button", async () => {
    const html = await draw([pick({ createdAt: FRESH, withdrawnAt: "2026-11-20T15:56:00.000Z" })]);
    expect(html).toContain("line-through");
    expect(html).toContain("Withdrawn");
    expect(html).not.toContain("pick-withdraw\"");
    expect(await draw([pick({ createdAt: FRESH })])).not.toContain("line-through");
  });
});
