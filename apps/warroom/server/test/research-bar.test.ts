import { readFileSync } from "node:fs";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { expect, it } from "vitest";
import { researchBar, type ResearchPayload } from "../../app/utils/research-bar.ts";

const payload = (over: Partial<ResearchPayload> = {}, api: Partial<ResearchPayload["api"]> = {}): ResearchPayload => ({
  usedUsd: 1.666,
  budgetUsd: 6,
  runs: 12,
  usedShareOfQuota: 0.0833,
  quotaUsd: 40,
  share: 0.15,
  exhausted: false,
  newProposals: 3,
  newProposalsCap: 30,
  api: { enabled: false, capUsd: 5, usedUsd: 0, runs: 0, exhausted: false, ...api },
  ...over,
});

async function draw(p: ResearchPayload): Promise<string> {
  const sfc = parse(readFileSync(new URL("../../app/components/ResearchBar.vue", import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: "ResearchBar.vue", id: "rb" });
  const render = new Function("Vue", compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render"))(await import("vue")) as (ctx: unknown, cache: unknown[]) => unknown;
  const view = researchBar(p);
  return renderToString(createSSRApp({ render: () => render({ view }, []) as ReturnType<typeof h> }));
}

it("researchBar gives the short figures and the details lines", () => {
  const v = researchBar(payload());
  expect(v.label).toBe("Research 24h");
  expect(v.budget).toBe("$1.67 / $6.00");
  expect(v.proposals).toBe("3 / 30");
  expect(v.api).toBe("API $0.0000 / $5.00");
  expect(v.budgetPct).toBeCloseTo(27.77, 1);
  expect(v.proposalsPct).toBe(10);
  expect(v.details.join(" ")).toContain("12 judge and propose runs, 8% of an assumed $40 daily quota; the limit is 15%.");
  expect(v.details.join(" ")).toContain("over 0 runs");
  expect(v.details.join(" ")).toContain("ARGUS_API_FALLBACK=1");
});

it("singular run, fallback on, and no NaN or overflow on zero budget or over-cap values", () => {
  const one = researchBar(payload({ runs: 1 }, { enabled: true, runs: 1, usedUsd: 0.5 }));
  expect(one.details.join(" ")).toContain("1 judge and propose run,");
  expect(one.details.join(" ")).toContain("over 1 run");
  expect(one.details.join(" ")).not.toContain("ARGUS_API_FALLBACK");
  const odd = researchBar(payload({ budgetUsd: 0, usedUsd: 3, newProposals: 40 }));
  expect(odd.budgetPct).toBe(0);
  expect(odd.proposalsPct).toBe(100);
  expect(JSON.stringify(odd)).not.toMatch(/NaN|undefined/);
});

it("the alerts are the short state lines, only when their flag is set", () => {
  expect(researchBar(payload()).alerts).toEqual([]);
  const all = researchBar(payload({ exhausted: true, newProposals: 30 }, { exhausted: true }));
  expect(all.alerts).toHaveLength(3);
});

it("the bar renders one short row; the sentences live in details or titles", async () => {
  const html = await draw(payload());
  expect(html).toContain('data-test="research-usage"');
  expect(html).toContain("Research 24h");
  expect(html).toContain("$1.67 / $6.00");
  expect(html).toContain('data-test="proposal-cap"');
  expect(html).toContain("3 / 30");
  expect(html).toContain('data-test="api-spend"');
  expect(html).toContain("API $0.0000 / $5.00");
  expect(html.match(/role="progressbar"/g)).toHaveLength(2);
  expect(html).toContain("<details");
  expect(html.split("<details")[0]).not.toContain("judge and propose");
  expect(html).toContain("12 judge and propose runs");
  expect(html).not.toMatch(/undefined|NaN|<p /);
});

it("alerts render inline outside the details", async () => {
  const html = await draw(payload({ exhausted: true, newProposals: 30 }, { exhausted: true }));
  const before = html.split("<details")[0]!;
  expect(before).toContain("Research budget reached");
  expect(before).toContain("API daily cap reached");
  expect(before).toContain("Proposal cap reached");
  expect(before).toContain("fill-bad");
});
