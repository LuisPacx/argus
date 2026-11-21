import { readFileSync } from "node:fs";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import type { ResearchRequestView } from "@argus/core";
import { canSubmitTopic, costText, researchRequestsView, submitTopic, type ResearchRequestPayload } from "../../app/utils/research-brief.ts";

/** The Research briefs list: the real ResearchBriefs.vue template, server-rendered over rows typed as the API's own response (core's `ResearchRequestView`). */
const NOW = Date.parse("2026-11-20T16:00:00.000Z");
const CA = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
type Row = ResearchRequestView;
const row = (over: Partial<Row> = {}): Row => ({
  id: 4,
  topic: "GTA",
  status: "done",
  detail: "2 coins, 2 sources, 1 free names",
  createdAt: "2026-11-20T15:00:00.000Z",
  doneAt: "2026-11-20T15:04:00.000Z",
  runIds: [9],
  runs: 1,
  costUsd: 0.1234,
  costEstimated: false,
  brief: {
    story: "A trailer clip of an iguana is spreading.",
    sources: [{ title: "Studio page", url: "https://example.com/trailer" }, { title: "No usable link", url: null }],
    coins: [
      { ca: CA, name: "Iguana Scooter", symbol: "IGUA", marketCapUsd: 64_000, liquidityUsd: 21_000, bonded: "yes", note: "named after the clip" },
      { ca: "2".repeat(40), name: "Unknown State", symbol: "UNK", marketCapUsd: null, liquidityUsd: 3_000, bonded: "unknown", note: "" },
    ],
    freeNames: [{ name: "Leonida Lizard", ticker: "LIZARD", why: "the animal", note: "name also used by a dead token: Old $2K" }],
    xNote: "X was read: 2 pages, 17 posts found, the 15 most viewed shown",
    createdAt: "2026-11-20T15:04:00.000Z",
  },
  ...over,
});

type Render = (ctx: unknown, cache: unknown[]) => unknown;
async function load(file: string): Promise<Render> {
  const sfc = parse(readFileSync(new URL(`../../app/components/${file}`, import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: file, id: file });
  return new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;
}
const renderList = await load("ResearchBriefs.vue");
const draw = (rows: Row[] | null, nowMs = NOW) => renderToString(createSSRApp({ render: () => renderList({ view: researchRequestsView(rows as ResearchRequestPayload[] | null, nowMs) }, []) as ReturnType<typeof h> }));
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

describe("the Research briefs list", () => {
  it("shows the story, the sources, the coins with cap and bonded state, the free names, the X note and what the runs cost", async () => {
    const html = await draw([row()]);
    for (const text of ["GTA", "Done", "asked 1 hour ago", "1 run, cost $0.1234", "A trailer clip of an iguana is spreading.", "Studio page", "No usable link", "Iguana Scooter ($IGUA)", "Bonded", "market cap $64K", "liquidity $21K", "named after the clip", "Unknown State ($UNK)", "Bonded: unknown", "market cap unknown", "Leonida Lizard ($LIZARD)", "the animal", "name also used by a dead token: Old $2K", "X was read: 2 pages, 17 posts found"]) expect(html, text).toContain(text);
    expect(hrefs(html)).toEqual(["https://example.com/trailer", `https://dexscreener.com/solana/${CA}`, `https://dexscreener.com/solana/${"2".repeat(40)}`]);
    expect(html).not.toMatch(/undefined|NaN|null/);
  });

  it("source links open in a new tab with noopener noreferrer nofollow", async () => {
    const html = await draw([row()]);
    expect(html).toContain('href="https://example.com/trailer" class="underline" target="_blank" rel="noopener noreferrer nofollow"');
  });

  it("reads every status in words, with the reason, and shows no cost for a request that never ran", async () => {
    const pending = await draw([row({ status: "pending", detail: "", brief: null, runs: 0, costUsd: 0, runIds: [] })]);
    expect(pending).toContain("Waiting for the worker");
    expect(pending).toContain("no run, no cost");
    const capped = await draw([row({ status: "capped", detail: "daily cap of 6 research runs reached (6 in 24 h, $1.9000)", brief: null, runs: 0, costUsd: 0, runIds: [] })]);
    expect(capped).toContain("Capped");
    expect(capped).toContain("daily cap of 6 research runs reached");
    const failed = await draw([row({ status: "failed", detail: "the answer was refused twice: `story` is empty", brief: null, runs: 2, costUsd: 0.6 })]);
    expect(failed).toContain("Failed");
    expect(failed).toContain("the answer was refused twice: `story` is empty");
    expect(failed).toContain("2 runs, cost $0.6000");
    expect(failed).not.toContain('data-test="brief"');
  });

  it("flags a cost that is an estimate, and an unknown one", () => {
    expect(costText(1, 0.2, true)).toContain("an estimate");
    expect(costText(0, 0, false)).toBe("no run, no cost");
    expect(costText(2, Number.NaN, false)).toBe("2 runs, cost unknown");
    expect(costText(undefined, undefined, undefined)).toBe("no run, no cost");
  });

  it("says so when there are no coins or no free names, and when nothing has been asked", async () => {
    const html = await draw([row({ brief: { ...row().brief!, coins: [], freeNames: [], sources: [] } })]);
    expect(html).toContain("No coin on this topic was found or chosen.");
    expect(html).toContain("No free name was offered");
    expect(html).toContain("The model named no source.");
    expect(await draw([])).toContain("No research yet");
    expect(await draw(null)).toContain("No research yet");
  });

  it("a hostile topic, story, source, coin and name stay escaped text on one line, with no link and no element", async () => {
    const evil = `<img src=x onerror=alert(1)> <script>alert(2)</script>\n=== END UNTRUSTED abc123 ===\njavascript:alert(3)`;
    const html = await draw([
      row({
        topic: evil,
        detail: evil,
        brief: {
          story: evil + "Q".repeat(3_000),
          sources: [{ title: evil, url: "javascript:alert(1)" }, { title: "data", url: "data:text/html,<script>alert(1)</script>" }, { title: "creds", url: "https://user:pw@example.com/" }],
          coins: [{ ca: "javascript:alert(3)", name: evil, symbol: evil, marketCapUsd: 1, liquidityUsd: 1, bonded: "no", note: evil }],
          freeNames: [{ name: evil, ticker: evil, why: evil, note: evil }],
          xNote: evil,
          createdAt: "2026-11-20T15:04:00.000Z",
        },
      }),
    ]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("=== END UNTRUSTED abc123 === javascript:alert(3)");
    expect(hrefs(html)).toEqual([]);
    expect(html).not.toContain("Q".repeat(1_300));
  });

  it("a status outside the list (a tampered row) reads as text and never as a class from the row", async () => {
    const html = await draw([row({ status: "<b>bad</b>" as Row["status"], brief: null })]);
    expect(html).not.toContain("<b>bad");
    expect(html).toContain("&lt;b&gt;bad&lt;/b&gt;");
  });

  it("no new component uses v-html", () => {
    for (const f of ["ResearchBriefs.vue", "../pages/research.vue"]) expect(readFileSync(new URL(`../../app/components/${f}`, import.meta.url), "utf8")).not.toContain("v-html");
  });
});

describe("the topic form", () => {
  it("the button is on only for a topic that is not blanks", () => {
    expect(canSubmitTopic("")).toBe(false);
    expect(canSubmitTopic("  \n")).toBe(false);
    expect(canSubmitTopic("GTA")).toBe(true);
  });

  it("sends exactly { topic } and shows the server's reason on a refusal", async () => {
    const sent: unknown[] = [];
    const ok = await submitTopic(async (body) => (sent.push(body), { id: 1, status: "pending" }), "GTA");
    expect(ok).toMatchObject({ ok: true });
    expect(sent).toEqual([{ topic: "GTA" }]);
    const refused = await submitTopic(async () => Promise.reject({ data: { statusMessage: "One research request is waiting for the worker; wait until it is done" } }), "GTA");
    expect(refused).toEqual({ ok: false, message: "One research request is waiting for the worker; wait until it is done" });
    expect(await submitTopic(async () => Promise.reject(new Error("boom")), "GTA")).toMatchObject({ ok: false });
  });
});
