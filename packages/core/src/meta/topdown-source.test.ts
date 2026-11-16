import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HttpError } from "../sources/http.ts";
import { META_RULE } from "./config.ts";
import { createTopDownReader, TOPDOWN_BUDGET_ERROR } from "./topdown-source.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "../fixtures", name), "utf8");
const JUPITER = fixture("jupiter-toptrending-1h.json");
const GECKO = fixture("geckoterminal-trending-pools.json");
const GTA6 = "4kjruqGHDsSqkMdFfCjV7Vb62HPFhtXyWc2t6JpQzDnz";

type Answer = string | Error;

/** Counting fakes for the two lists: each request is recorded, and answers are taken in order (the last one repeats). No timer: the retry sleep is a recorder. */
function rig(opts: { jupiter?: Answer[]; gecko?: Answer[]; calls?: number } = {}) {
  const requests = { jupiter: [] as string[], gecko: [] as string[] };
  const sleeps: number[] = [];
  const answerFrom = (list: Answer[], seen: string[]) => async (url: string) => {
    const a = list[Math.min(seen.length, list.length - 1)] as Answer;
    seen.push(url);
    if (a instanceof Error) throw a;
    return a;
  };
  const reader = createTopDownReader({
    config: { ...META_RULE, topDownCalls: opts.calls ?? META_RULE.topDownCalls },
    fetchJupiter: answerFrom(opts.jupiter ?? [JUPITER], requests.jupiter),
    fetchGecko: answerFrom(opts.gecko ?? [GECKO], requests.gecko),
    retries: 2,
    sleep: async (ms) => void sleeps.push(ms),
    log: () => {},
  });
  return { reader, requests, sleeps };
}

describe("the top-down reader: the call budget (ADR 0015, counted at the HTTP request, retries included)", () => {
  it("a normal tick makes exactly 1 Jupiter and 3 GeckoTerminal requests, and merges both lists", async () => {
    const { reader, requests } = rig();
    const out = await reader();
    expect(requests.jupiter).toHaveLength(1);
    expect(requests.gecko).toHaveLength(3);
    expect(requests.gecko.map((u) => u.slice(u.indexOf("page=")))).toEqual(["page=1", "page=2", "page=3"]);
    expect(out.requests).toBe(4);
    expect(out.errors).toEqual([]);
    const gta = out.candidates.find((c) => c.mint === GTA6)!;
    expect(gta.sources).toEqual(["jupiter", "geckoterminal"]);
    expect(out.dropped.some((d) => d.reason === "stock token")).toBe(true);
  });

  it("Jupiter answering 429 every time makes 3 Jupiter requests, then GeckoTerminal pages 1 and 2 (5 in all); the third page is never made and no sixth request goes out", async () => {
    const busy = new HttpError("Jupiter fetch failed: 429 Too Many Requests", 429);
    const { reader, requests, sleeps } = rig({ jupiter: [busy] });
    const out = await reader();
    expect(requests.jupiter).toHaveLength(3);
    expect(requests.gecko).toHaveLength(2);
    expect(out.requests).toBe(5);
    expect(sleeps).toEqual([500, 1_000]); // only Jupiter's two retries waited
    expect(out.errors).toEqual(["jupiter: Jupiter fetch failed: 429 Too Many Requests", `geckoterminal page 3: ${TOPDOWN_BUDGET_ERROR}`]);
    expect(out.candidates.length).toBeGreaterThan(0); // GeckoTerminal's two pages still count
    expect(out.candidates.every((c) => c.sources.join() === "geckoterminal")).toBe(true);
  });

  it("the budget error is not retried: no wait, and no request is made for it", async () => {
    const { reader, requests, sleeps } = rig({ calls: 2 });
    const out = await reader();
    expect(requests.jupiter).toHaveLength(1);
    expect(requests.gecko).toHaveLength(1);
    expect(out.requests).toBe(2);
    expect(sleeps).toEqual([]);
    expect(out.errors).toEqual([`geckoterminal page 2: ${TOPDOWN_BUDGET_ERROR}`]);
  });

  it("ARGUS_META_TOPDOWN_CALLS=1 makes only the Jupiter request", async () => {
    const { reader, requests } = rig({ calls: 1 });
    const out = await reader();
    expect(requests.jupiter).toHaveLength(1);
    expect(requests.gecko).toHaveLength(0);
    expect(out.requests).toBe(1);
    expect(out.errors).toEqual([`geckoterminal page 1: ${TOPDOWN_BUDGET_ERROR}`]);
    expect(out.candidates.map((c) => c.symbol)).toContain("GTA6"); // Jupiter's list alone still gives candidates
  });

  it("every call of the reader has its own budget", async () => {
    const { reader, requests } = rig();
    await reader();
    await reader();
    expect(requests.jupiter).toHaveLength(2);
    expect(requests.gecko).toHaveLength(6);
  });

  it("both lists failing returns no candidates and says what failed, and a failing GeckoTerminal page ends the paging", async () => {
    const down = new TypeError("fetch failed");
    const { reader, requests } = rig({ jupiter: [down], gecko: [down] });
    const out = await reader();
    expect(out.candidates).toEqual([]);
    expect(out.dropped).toEqual([]);
    expect(requests.jupiter).toHaveLength(3); // one try and two retries
    expect(requests.gecko).toHaveLength(2); // the 4th and 5th request: page 1 fails, its retry fails, the budget ends the third try
    expect(out.requests).toBe(5);
    expect(out.errors).toEqual(["jupiter: fetch failed", `geckoterminal page 1: ${TOPDOWN_BUDGET_ERROR}`]);
  });

  it("an answer that is not a list is an error line, not an empty list, and the other list still counts", async () => {
    const { reader } = rig({ jupiter: ['{"message":"rate limited"}'] });
    const out = await reader();
    expect(out.errors).toEqual(["jupiter: Jupiter: unexpected response (no list)"]);
    expect(out.candidates.length).toBeGreaterThan(0);
  });

  it("stops paging at an empty page", async () => {
    const { reader, requests } = rig({ gecko: [GECKO, '{"data":[]}'] });
    const out = await reader();
    expect(requests.gecko).toHaveLength(2);
    expect(out.requests).toBe(3);
  });
});
