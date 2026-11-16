import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HttpError } from "./http.ts";
import { JupiterTokensClient, TOPTRENDING_PREFIX } from "./jupiter.ts";

const fixture = readFileSync(join(import.meta.dirname, "../fixtures/jupiter-toptrending-1h.json"), "utf8");
const GTA6 = "4kjruqGHDsSqkMdFfCjV7Vb62HPFhtXyWc2t6JpQzDnz";
const TTWO = "TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo";
const MINT = "M".repeat(32);

const answer = (body: string) => new JupiterTokensClient({ fetchText: async () => body });
const one = (over: Record<string, unknown>) => JSON.stringify([{ id: MINT, name: "Ok", symbol: "OK", mcap: 1_000_000, liquidity: 100_000, stats24h: { buyVolume: 60_000, sellVolume: 40_000 }, ...over }]);

describe("JupiterTokensClient.topTrending: a trimmed real answer (2026-11-16)", () => {
  it("reads the GTA VI token with mint, name, symbol, market cap, liquidity, volume, age and tags", async () => {
    const tokens = await answer(fixture).topTrending("1h", 50);
    expect(tokens.map((t) => t.symbol)).toEqual(["GTA6", "TTWO", "NVDAx", "ZEC", "GTA 6 Coin"]); // Jupiter's order is kept
    const gta = tokens[0]!;
    expect(gta.mint).toBe(GTA6);
    expect(gta.name).toBe("GTA VI");
    expect(gta.marketCapUsd).toBeCloseTo(7_344_795.91, 1);
    expect(gta.liquidityUsd).toBeCloseTo(271_310.39, 1);
    expect(gta.volume24hUsd).toBeCloseTo(554_241.05 + 530_890.29, 1); // buy plus sell volume of the last 24 h
    expect(gta.holderCount).toBe(74_869);
    expect(gta.organicScore).toBeCloseTo(73.17, 2);
    expect(gta.createdAt).toBe("2026-08-06T13:35:52.000Z");
    expect(gta.tags).toEqual(["unknown"]);
    const stock = tokens[1]!;
    expect(stock.mint).toBe(TTWO);
    expect(stock.tags).toEqual(["stocks", "rwa", "backpack", "token-2022", "verified"]);
  });

  it("asks for the list prefix, the interval and the limit, and never more than 100", async () => {
    const urls: string[] = [];
    const client = new JupiterTokensClient({ fetchText: async (url) => (urls.push(url), "[]") });
    await client.topTrending("1h", 50);
    await client.topTrending("6h", 5_000);
    await client.topTrending("5m", 0);
    expect(urls).toEqual([`${TOPTRENDING_PREFIX}1h?limit=50`, `${TOPTRENDING_PREFIX}6h?limit=100`, `${TOPTRENDING_PREFIX}5m?limit=1`]);
    expect(TOPTRENDING_PREFIX.endsWith("/tokens/v2/toptrending/")).toBe(true);
  });

  it("uses a replaced prefix for a loopback mirror", async () => {
    const urls: string[] = [];
    await new JupiterTokensClient({ baseUrl: "http://127.0.0.1:9/list/", fetchText: async (url) => (urls.push(url), "[]") }).topTrending("1h", 3);
    expect(urls).toEqual(["http://127.0.0.1:9/list/1h?limit=3"]);
  });
});

describe("JupiterTokensClient.topTrending: untrusted answers", () => {
  it("drops an entry that is not an object, a mint that is not address-shaped and a missing id, and keeps the rest", async () => {
    const body = JSON.stringify([null, 7, "x", [], { id: "short", name: "Short" }, { id: "has/slash" + "a".repeat(30), name: "Slash" }, { name: "No id" }, { id: 12345, name: "Numeric id" }, { id: MINT, name: "Kept", symbol: "KEPT" }]);
    expect((await answer(body).topTrending()).map((t) => t.name)).toEqual(["Kept"]);
  });

  it("treats a non-finite, negative or non-number figure as absent, never as a number", async () => {
    // JSON.parse turns 1e999 into Infinity.
    const raw = `[{"id":"${MINT}","name":"Odd","mcap":1e999,"fdv":-5,"liquidity":"lots","holderCount":null,"organicScore":-1,"stats24h":{"buyVolume":-1,"sellVolume":null}}]`;
    const [t] = await answer(raw).topTrending();
    expect(t).toEqual({ mint: MINT, name: "Odd", symbol: "", tags: [] });
    const [u] = await answer(one({ stats24h: { buyVolume: 30, sellVolume: "x" } })).topTrending();
    expect(u!.volume24hUsd).toBe(30); // the half that is a number still counts
  });

  it("cuts a 100,000-character name and a long ticker, strips markup, and does not stall on a run of `<`", async () => {
    const started = performance.now();
    const [t] = await answer(one({ name: "N".repeat(100_000), symbol: "S".repeat(5_000) })).topTrending();
    expect(t!.name).toHaveLength(100);
    expect(t!.symbol).toHaveLength(30);
    const [m] = await answer(one({ name: "<b>Bold</b> <script>x</script>Name", symbol: "<<<<" + "<".repeat(100_000) })).topTrending();
    expect(m!.name).toBe("Bold xName");
    expect(m!.symbol.length).toBeLessThanOrEqual(30);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("reads at most 100 entries of a 10,000-entry answer, fast", async () => {
    const big = JSON.stringify(Array.from({ length: 10_000 }, (_, i) => ({ id: `${String(i).padStart(8, "0")}`.padEnd(40, "x"), name: `T${i}`, symbol: `T${i}` })));
    const started = performance.now();
    const tokens = await answer(big).topTrending();
    expect(tokens).toHaveLength(100);
    expect(tokens[99]!.name).toBe("T99");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("cuts and filters the tags, and takes a bad creation time as absent", async () => {
    const tags = ["verified", 3, null, "<i>stocks</i>", "x".repeat(500), ...Array.from({ length: 50 }, (_, i) => `t${i}`)];
    const [t] = await answer(one({ tags, firstPool: { createdAt: "not a time" } })).topTrending();
    expect(t!.tags.slice(0, 3)).toEqual(["verified", "stocks", "x".repeat(40)]);
    expect(t!.tags.length).toBeLessThanOrEqual(20);
    expect(t!.createdAt).toBeUndefined();
  });

  it("throws a plain error for a body that is not JSON and for an answer with no list, never an empty list", async () => {
    for (const body of ["", "<html>busy</html>", "{"]) await expect(answer(body).topTrending()).rejects.toThrow(/Jupiter: response is not JSON/);
    for (const body of ["{}", "null", '{"error":"rate limited"}', '"[]"', "42"]) await expect(answer(body).topTrending()).rejects.toThrow(/Jupiter: unexpected response \(no list\)/);
    expect(await answer("[]").topTrending()).toEqual([]); // a real empty list is a list
  });
});

describe("JupiterTokensClient: requests and retries", () => {
  it("retries a 429 and a network error with the ticket 04 wrapper, on an injected timer, and counts each request", async () => {
    const waits: number[] = [];
    let requests = 0;
    const errors = [new HttpError("busy", 429, 2_000), new TypeError("fetch failed")];
    const client = new JupiterTokensClient({
      retries: 2,
      sleep: async (ms) => void waits.push(ms),
      log: () => {},
      onRequest: () => void requests++,
      fetchText: async () => {
        const e = errors.shift();
        if (e) throw e;
        return fixture;
      },
    });
    expect(await client.topTrending()).toHaveLength(5);
    expect(requests).toBe(3);
    expect(waits).toEqual([2_000, 1_000]);
  });

  it("a throw from onRequest ends the call at once and is not retried", async () => {
    let fetches = 0;
    let asked = 0;
    const client = new JupiterTokensClient({
      retries: 2,
      sleep: async () => {},
      log: () => {},
      onRequest: () => {
        if (++asked > 1) throw new Error("budget");
      },
      fetchText: async () => {
        fetches++;
        throw new HttpError("busy", 429);
      },
    });
    await expect(client.topTrending()).rejects.toThrow("budget");
    expect(fetches).toBe(1);
    expect(asked).toBe(2);
  });

  it("notes each retry in the log with the path only", async () => {
    const lines: string[] = [];
    const client = new JupiterTokensClient({ retries: 1, sleep: async () => {}, log: (l) => lines.push(l), fetchText: (() => {
      let n = 0;
      return async () => {
        if (n++ === 0) throw new TypeError("fetch failed");
        return "[]";
      };
    })() });
    await client.topTrending();
    expect(lines).toEqual(["[jupiter] retry 1/1 after fetch failed (waiting 500 ms): /tokens/v2/toptrending/1h"]);
  });
});
