import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GeckoTerminalClient } from "./geckoterminal.ts";
import { HttpError } from "./http.ts";

const fixture = readFileSync(join(import.meta.dirname, "../fixtures/geckoterminal-trending-pools.json"), "utf8");
const GTA6 = "4kjruqGHDsSqkMdFfCjV7Vb62HPFhtXyWc2t6JpQzDnz";
const MINT = "M".repeat(32);

const answer = (body: string) => new GeckoTerminalClient({ fetchText: async () => body });

/** One pool answer: the base token's id and the pool's attributes, with a matching included token. */
function pool(over: { attrs?: Record<string, unknown>; base?: unknown; token?: Record<string, unknown> | null } = {}) {
  const base = over.base ?? `solana_${MINT}`;
  return {
    data: [{ id: "solana_pool", type: "pool", attributes: { name: "OK / SOL", fdv_usd: "2000000", market_cap_usd: "1500000", reserve_in_usd: "100000", volume_usd: { h24: "60000" }, pool_created_at: "2026-11-01T00:00:00Z", ...over.attrs }, relationships: { base_token: { data: { id: base } } } }],
    included: over.token === null ? [] : [{ id: base, type: "token", attributes: { name: "Ok", symbol: "OK", ...over.token } }],
  };
}
const one = (over: Parameters<typeof pool>[0] = {}) => JSON.stringify(pool(over));

describe("GeckoTerminalClient.trendingPools: a trimmed real answer (2026-11-16)", () => {
  it("reads the GTA VI pool: base token mint, name, symbol, FDV as the market cap, pool liquidity and volume", async () => {
    const pools = await answer(fixture).trendingPools(1);
    expect(pools.map((p) => p.symbol)).toEqual(["mihao", "GATO", "GTA6", "Rocco"]); // GeckoTerminal's order is kept
    const gta = pools.find((p) => p.mint === GTA6)!;
    expect(gta.name).toBe("GTA VI");
    expect(gta.symbol).toBe("GTA6");
    expect(gta.marketCapUsd).toBe(7_290_436); // market_cap_usd is null: fdv_usd stands in
    expect(gta.fdvUsd).toBe(7_290_436);
    expect(gta.liquidityUsd).toBeCloseTo(65_004.1056, 4);
    expect(gta.volume24hUsd).toBeCloseTo(743_799.83, 2);
    expect(gta.createdAt).toBe("2026-10-29T13:56:21.000Z");
  });

  it("uses market_cap_usd when it is present and positive, and fdv_usd when it is null, zero or negative", async () => {
    const pools = await answer(fixture).trendingPools();
    expect(pools[0]).toMatchObject({ symbol: "mihao", marketCapUsd: 15_109_994.6794861, fdvUsd: 15_109_994.5012377 });
    for (const mc of [null, "0", "-3", "x", 12]) {
      const [p] = await answer(one({ attrs: { market_cap_usd: mc } })).trendingPools();
      expect(p!.marketCapUsd, String(mc)).toBe(mc === 12 ? 12 : 2_000_000);
    }
  });

  it("asks for the Solana trending pools with the base token included, one page at a time, within 1 to 10", async () => {
    const urls: string[] = [];
    const client = new GeckoTerminalClient({ baseUrl: "http://127.0.0.1:9", fetchText: async (url) => (urls.push(url), '{"data":[]}') });
    await client.trendingPools(2);
    await client.trendingPools(0);
    await client.trendingPools(99);
    expect(urls).toEqual([
      "http://127.0.0.1:9/api/v2/networks/solana/trending_pools?include=base_token&page=2",
      "http://127.0.0.1:9/api/v2/networks/solana/trending_pools?include=base_token&page=1",
      "http://127.0.0.1:9/api/v2/networks/solana/trending_pools?include=base_token&page=10",
    ]);
  });
});

describe("GeckoTerminalClient.trendingPools: untrusted answers", () => {
  it("drops an entry that is not an object, has no base token, or has a mint that is not address-shaped", async () => {
    const good = pool().data[0];
    const body = JSON.stringify({
      data: [null, 4, "x", [], {}, { attributes: {} }, { attributes: {}, relationships: {} }, { ...good, relationships: { base_token: { data: { id: "solana_short" } } } }, { ...good, relationships: { base_token: { data: { id: `sol_${MINT}` } } } }, { ...good, relationships: { base_token: { data: { id: 5 } } } }, good],
      included: [],
    });
    const pools = await answer(body).trendingPools();
    expect(pools.map((p) => p.mint)).toEqual([MINT]);
  });

  it("treats a non-finite, negative or non-numeric figure as absent", async () => {
    const [p] = await answer(one({ attrs: { fdv_usd: "-1", market_cap_usd: "Infinity", reserve_in_usd: "1e999", volume_usd: { h24: "lots" }, pool_created_at: "yesterday" } })).trendingPools();
    expect(p).toEqual({ mint: MINT, name: "Ok", symbol: "OK" });
    const [q] = await answer(one({ attrs: { reserve_in_usd: Number.POSITIVE_INFINITY } })).trendingPools();
    expect(q!.liquidityUsd).toBeUndefined();
  });

  it("cuts a 100,000-character name, strips markup, takes the ticker from the pool name when no token is included", async () => {
    const started = performance.now();
    const [p] = await answer(one({ token: { name: "N".repeat(100_000), symbol: "<b>S</b>" + "<".repeat(100_000) } })).trendingPools();
    expect(p!.name).toHaveLength(100);
    expect(p!.symbol.length).toBeLessThanOrEqual(30);
    expect(p!.symbol.startsWith("S")).toBe(true);
    const [q] = await answer(one({ token: null, attrs: { name: "<i>Sym</i> / SOL" } })).trendingPools();
    expect(q).toMatchObject({ mint: MINT, name: "", symbol: "Sym" });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("reads at most 100 pools of a 10,000-pool answer, fast", async () => {
    const good = pool().data[0] as Record<string, unknown>;
    const big = JSON.stringify({ data: Array.from({ length: 10_000 }, (_, i) => ({ ...good, relationships: { base_token: { data: { id: `solana_${String(i).padStart(8, "0").padEnd(40, "x")}` } } } })), included: Array.from({ length: 10_000 }, () => ({ id: "solana_x", attributes: {} })) });
    const started = performance.now();
    expect(await answer(big).trendingPools()).toHaveLength(100);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("throws a plain error for a body that is not JSON and for an answer with no data list, never an empty list", async () => {
    for (const body of ["", "<html>busy</html>", "{"]) await expect(answer(body).trendingPools()).rejects.toThrow(/GeckoTerminal: response is not JSON/);
    for (const body of ["[]", "{}", "null", '{"data":null}', '{"data":{}}', '{"errors":[{"status":"429"}]}', "42"]) await expect(answer(body).trendingPools()).rejects.toThrow(/GeckoTerminal: unexpected response/);
    expect(await answer('{"data":[]}').trendingPools()).toEqual([]);
  });
});

describe("GeckoTerminalClient: requests and retries", () => {
  it("retries a 503 once, counts each request, and a throw from onRequest is not retried", async () => {
    const waits: number[] = [];
    let requests = 0;
    const errors = [new HttpError("down", 503)];
    const ok = new GeckoTerminalClient({ retries: 2, sleep: async (ms) => void waits.push(ms), log: () => {}, onRequest: () => void requests++, fetchText: async () => { const e = errors.shift(); if (e) throw e; return fixture; } });
    expect(await ok.trendingPools()).toHaveLength(4);
    expect(requests).toBe(2);
    expect(waits).toEqual([500]);

    let fetches = 0;
    const capped = new GeckoTerminalClient({ retries: 2, sleep: async () => {}, log: () => {}, onRequest: () => { throw new Error("budget"); }, fetchText: async () => { fetches++; return fixture; } });
    await expect(capped.trendingPools()).rejects.toThrow("budget");
    expect(fetches).toBe(0);
  });
});
