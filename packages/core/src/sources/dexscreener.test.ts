import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DexScreenerClient, DexScreenerTrendingSource } from "./dexscreener.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "../fixtures", name), "utf8");
const MOON = "MoonCatMint1111111111111111111111111111111";
const BOT = "RocketBotMint22222222222222222222222222222";

/** Answers each DexScreener URL from a route table and records what was asked. */
function fakeApi(routes: Record<string, string>) {
  const calls: string[] = [];
  const fetchText = async (url: string) => {
    calls.push(url);
    const body = routes[url];
    if (body === undefined) throw new Error(`unexpected request ${url}`);
    return body;
  };
  return { fetchText, calls };
}

const boostsUrl = "https://api.dexscreener.com/token-boosts/top/v1";
const pairsUrl = `https://api.dexscreener.com/tokens/v1/solana/${MOON},${BOT}`;

describe("DexScreenerClient", () => {
  it("lists the top boosted tokens, dropping malformed entries", async () => {
    const api = fakeApi({ [boostsUrl]: fixture("dexscreener-boosts.json") });
    const boosts = await new DexScreenerClient({ fetchText: api.fetchText }).topBoosts();
    expect(boosts.map((b) => [b.chainId, b.tokenAddress])).toEqual([
      ["solana", MOON],
      ["solana", BOT],
      ["ethereum", "0x0000000000000000000000000000000000000001"],
    ]);
    expect(boosts[0]!.description).toBe("The cat that went to the moon.");
  });

  it("looks up pairs by token address", async () => {
    const api = fakeApi({ [pairsUrl]: fixture("dexscreener-pairs.json") });
    const pairs = await new DexScreenerClient({ fetchText: api.fetchText }).tokenPairs("solana", [MOON, BOT]);
    expect(pairs).toHaveLength(3);
    expect(pairs[1]).toMatchObject({ name: "Moon Cat", symbol: "MCAT", tokenAddress: MOON, liquidityUsd: 98765, volume24hUsd: 1234567.8, priceChange24hPct: -12.5, url: "https://dexscreener.com/solana/PairBig" });
  });

  it("reads market cap and FDV when DexScreener gives them, and leaves them absent (not 0) when it does not", async () => {
    const base = { chainId: "solana", url: "https://dexscreener.com/solana/P", baseToken: { address: MOON, name: "Moon Cat", symbol: "MCAT" } };
    const body = JSON.stringify([
      { ...base, marketCap: 13_000_000, fdv: 13_500_000 },
      { ...base, marketCap: "13M", fdv: Number.NaN },
      { ...base, fdv: 7 },
    ]);
    const pairs = await new DexScreenerClient({ fetchText: async () => body }).tokenPairs("solana", [MOON]);
    expect(pairs[0]).toMatchObject({ marketCapUsd: 13_000_000, fdvUsd: 13_500_000 });
    expect("marketCapUsd" in pairs[1]!).toBe(false);
    expect("fdvUsd" in pairs[1]!).toBe(false);
    expect(pairs[2]).toMatchObject({ fdvUsd: 7 });
    expect("marketCapUsd" in pairs[2]!).toBe(false);
  });

  it("searches pairs by name or ticker, URL-encoded (for the collision checks)", async () => {
    const api = fakeApi({ "https://api.dexscreener.com/latest/dex/search?q=moon%20cat%26x": JSON.stringify({ schemaVersion: "1.0.0", pairs: JSON.parse(fixture("dexscreener-pairs.json")) }) });
    const pairs = await new DexScreenerClient({ fetchText: api.fetchText }).search("moon cat&x");
    expect(pairs.map((p) => p.symbol)).toEqual(["MCAT", "MCAT", "RBOT"]);
  });

  it("never builds a URL from an unsafe chain id or address", async () => {
    const api = fakeApi({});
    const client = new DexScreenerClient({ fetchText: api.fetchText });
    expect(await client.tokenPairs("solana", ["../../x", "a b"])).toEqual([]);
    expect(await client.tokenPairs("so/lana", [MOON])).toEqual([]);
    expect(api.calls).toEqual([]);
  });

  it("fails on a body that is not JSON of the expected shape", async () => {
    await expect(new DexScreenerClient({ fetchText: async () => "<html>" }).topBoosts()).rejects.toThrow();
    await expect(new DexScreenerClient({ fetchText: async () => '{"x":1}' }).topBoosts()).rejects.toThrow(/unexpected/);
  });

  it("search answers an empty list only for a real no-match answer (`pairs: []`); a missing, null or non-array `pairs` is an error", async () => {
    expect(await new DexScreenerClient({ fetchText: async () => '{"schemaVersion":"1.0.0","pairs":[]}' }).search("q")).toEqual([]);
    for (const body of ['{"schemaVersion":"1.0.0"}', '{"pairs":null}', '{"pairs":{"a":1}}', '{"pairs":"none"}']) {
      await expect(new DexScreenerClient({ fetchText: async () => body }).search("q")).rejects.toThrow(/unexpected/);
    }
  });

  it("search keeps pairs whose chain or token address is not a Solana/EVM-style token (SUI, TON), so a name or ticker still matches; token lookups stay strict", async () => {
    const odd = [
      { chainId: "sui", url: "https://dexscreener.com/sui/x", baseToken: { address: "0x2::cat::CAT", name: "Sui Cat", symbol: "SCAT" } },
      { chainId: "ton", url: "https://dexscreener.com/ton/y", baseToken: { address: "EQ-short", name: "Ton Cat", symbol: "TCAT" } },
    ];
    const client = new DexScreenerClient({ fetchText: async () => JSON.stringify({ pairs: odd }) });
    expect((await client.search("cat")).map((p) => [p.chainId, p.symbol])).toEqual([["sui", "SCAT"], ["ton", "TCAT"]]);
    expect(await new DexScreenerClient({ fetchText: async () => JSON.stringify(odd) }).tokenPairs("solana", [MOON])).toEqual([]);
  });

  it("caps hostile responses: item count and field lengths", async () => {
    const many = Array.from({ length: 5_000 }, (_, i) => ({ chainId: "solana", tokenAddress: `Mint${String(i).padStart(30, "0")}` }));
    expect(await new DexScreenerClient({ fetchText: async () => JSON.stringify(many) }).topBoosts()).toHaveLength(100);
    const pair = { chainId: "solana", url: `https://dexscreener.com/${"u".repeat(5_000)}`, baseToken: { address: MOON, name: "N".repeat(5_000), symbol: "S".repeat(5_000) } };
    const [p] = await new DexScreenerClient({ fetchText: async () => JSON.stringify([pair]) }).tokenPairs("solana", [MOON]);
    expect(p!.name).toHaveLength(100);
    expect(p!.symbol).toHaveLength(30);
    expect(p!.url).toBe("");
  });
});

describe("DexScreenerTrendingSource", () => {
  const api = () => fakeApi({ [boostsUrl]: fixture("dexscreener-boosts.json"), [pairsUrl]: fixture("dexscreener-pairs.json") });
  const make = (a = api()) => new DexScreenerTrendingSource({ client: new DexScreenerClient({ fetchText: a.fetchText }) });

  it("has a stable id and a label", () => {
    const s = make();
    expect([s.id, s.label]).toEqual(["dexscreener:trending", "DexScreener trending"]);
  });

  it("turns boosted Solana tokens into Signals using each token's deepest pair", async () => {
    const signals = await make().poll();
    expect(signals.map(({ id: _id, ...rest }) => rest)).toEqual([
      {
        sourceId: "dexscreener:trending",
        sourceLabel: "DexScreener trending",
        title: "Moon Cat ($MCAT)",
        summary: "Boosted on DexScreener. 24h volume $1,234,568, 24h change -12.5%, liquidity $98,765. The cat that went to the moon.",
        url: "https://dexscreener.com/solana/PairBig",
        publishedAt: "2026-11-04T13:46:40.000Z",
      },
      {
        sourceId: "dexscreener:trending",
        sourceLabel: "DexScreener trending",
        title: "Rocket Bot ($RBOT)",
        summary: "Boosted on DexScreener.",
        url: "",
        publishedAt: "1970-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("looks up only the chain's tokens, with one boosts call and one pairs call", async () => {
    const a = api();
    await make(a).poll();
    expect(a.calls).toEqual([boostsUrl, pairsUrl]);
  });

  it("gives a token the same id on every poll, namespaced by Source", async () => {
    const a = await make().poll();
    const b = await make().poll();
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
    expect(a[0]!.id).toBe(`dexscreener:trending:solana:${MOON}`);
  });

  it("skips a boosted token DexScreener cannot name", async () => {
    const a = fakeApi({ [boostsUrl]: fixture("dexscreener-boosts.json"), [pairsUrl]: "[]" });
    expect(await make(a).poll()).toEqual([]);
  });

  it("returns nothing, and asks nothing more, when no token is boosted", async () => {
    const a = fakeApi({ [boostsUrl]: "[]" });
    expect(await make(a).poll()).toEqual([]);
    expect(a.calls).toEqual([boostsUrl]);
  });
});

describe("DexScreenerClient default fetch", () => {
  it("sends JSON requests through the bounded fetch and fails a non-2xx", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429, statusText: "Too Many Requests", headers: { "retry-after": "30" } }));
    try {
      const err = await new DexScreenerClient().topBoosts().catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 429, retryAfterMs: 30_000 });
      expect(spy).toHaveBeenCalledWith(boostsUrl, expect.objectContaining({ headers: { accept: "application/json" }, signal: expect.any(AbortSignal) }));
    } finally {
      spy.mockRestore();
    }
  });
});
