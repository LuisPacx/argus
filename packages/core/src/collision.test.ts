import { describe, expect, it } from "vitest";
import { createCollisionChecker, describeCollision, type CollisionChecker } from "./collision.ts";
import { HttpError, type FetchText } from "./sources/http.ts";

const T0 = new Date("2026-11-06T10:00:00.000Z");
const MINT = "MoonCatMint1111111111111111111111111111111";
const pair = (name: string, symbol: string) => ({
  chainId: "solana",
  url: "https://dexscreener.com/solana/Pair",
  baseToken: { address: MINT, name, symbol },
});
const dexBody = (...pairs: ReturnType<typeof pair>[]) => JSON.stringify({ pairs });
const ghBody = (...names: string[]) => JSON.stringify({ items: names.map((n) => ({ full_name: `someone/${n}`, name: n, html_url: `https://github.com/someone/${n}` })) });

type Handler = (url: string) => string | Promise<string>;
/** Fake DexScreener and GitHub: each answers by handler, and every requested URL is recorded. */
function setup(over: { dex?: Handler; github?: Handler; timeoutMs?: number } = {}) {
  const urls: string[] = [];
  const wrap =
    (h: Handler): FetchText =>
    async (url) => {
      urls.push(url);
      return h(url);
    };
  let clock = T0.getTime();
  const checker: CollisionChecker = createCollisionChecker({
    dexFetchText: wrap(over.dex ?? (() => dexBody())),
    githubFetchText: wrap(over.github ?? (() => ghBody())),
    now: () => new Date(clock),
    timeoutMs: over.timeoutMs,
  });
  return { checker, urls, advance: (ms: number) => (clock += ms) };
}

describe("collision checks, DexScreener by name and ticker", () => {
  it("is clear only when both searches answered and nothing matches; it names its source and the time of the check", async () => {
    const { checker, urls } = setup({ dex: () => dexBody(pair("Other Coin", "OTH")) });
    const r = await checker.check({ name: "Stock Paws", ticker: "PAWS" });
    expect(r.dex).toMatchObject({ status: "clear", source: "DexScreener", checkedAt: T0.toISOString() });
    expect(urls.filter((u) => u.includes("/latest/dex/search"))).toEqual([
      expect.stringContaining("q=Stock%20Paws"),
      expect.stringContaining("q=PAWS"),
    ]);
  });

  it("collides on a pair with the same ticker, ignoring case", async () => {
    const { checker } = setup({ dex: () => dexBody(pair("Paws Of Doom", "paws")) });
    const r = await checker.check({ name: "Stock Paws", ticker: "PAWS" });
    expect(r.dex.status).toBe("collides");
    expect(r.dex.detail).toContain("PAWS");
  });

  it("collides on a pair with the same name, ignoring case and punctuation", async () => {
    const { checker } = setup({ dex: () => dexBody(pair("stock  paws!", "SPW")) });
    expect((await checker.check({ name: "Stock Paws", ticker: "PAWS" })).dex.status).toBe("collides");
  });

  it("is unknown, never clear, when a search is rate-limited, even if the other one found nothing", async () => {
    let n = 0;
    const { checker } = setup({
      dex: () => {
        if (++n === 2) throw new HttpError("DexScreener fetch failed: 429 Too Many Requests", 429, 30_000);
        return dexBody();
      },
    });
    const r = await checker.check({ name: "Stock Paws", ticker: "PAWS" });
    expect(r.dex).toMatchObject({ status: "unknown", source: "DexScreener", checkedAt: T0.toISOString() });
    expect(r.dex.detail).toMatch(/rate-limited/i);
  });

  it("still reports a collision found by one search when the other failed", async () => {
    let n = 0;
    const { checker } = setup({
      dex: () => {
        if (++n === 1) throw new Error("boom");
        return dexBody(pair("Paws Of Doom", "PAWS"));
      },
    });
    expect((await checker.check({ name: "Stock Paws", ticker: "PAWS" })).dex.status).toBe("collides");
  });

  it("is unknown when the answer is not what DexScreener sends", async () => {
    const { checker } = setup({ dex: () => "<html>maintenance</html>" });
    expect((await checker.check({ name: "Stock Paws", ticker: "PAWS" })).dex.status).toBe("unknown");
  });

  it("is unknown when a search never answers: the check is time-bounded", async () => {
    const { checker } = setup({ dex: () => new Promise<string>(() => {}), timeoutMs: 20 });
    const r = await checker.check({ name: "Stock Paws", ticker: "PAWS" });
    expect(r.dex.status).toBe("unknown");
    expect(r.dex.detail).toMatch(/timed out/i);
  });
});

describe("collision checks, GitHub by repo name", () => {
  it("searches repository names for the slug of the proposed name", async () => {
    const { checker, urls } = setup();
    await checker.check({ name: "Stock Paws!", ticker: "PAWS" });
    const gh = urls.filter((u) => u.includes("/search/repositories"));
    expect(gh).toHaveLength(1);
    expect(new URL(gh[0]!).searchParams.get("q")).toBe("stock-paws in:name");
  });

  it("is clear when no repository has exactly that name", async () => {
    const { checker } = setup({ github: () => ghBody("stock-paws-extra", "paws") });
    expect((await checker.check({ name: "Stock Paws", ticker: "PAWS" })).github).toMatchObject({ status: "clear", source: "GitHub", checkedAt: T0.toISOString() });
  });

  it("collides when a repository has exactly that name, whoever owns it", async () => {
    const { checker } = setup({ github: () => ghBody("Stock-Paws") });
    const r = await checker.check({ name: "Stock Paws", ticker: "PAWS" });
    expect(r.github.status).toBe("collides");
    expect(r.github.detail).toContain("someone/Stock-Paws");
  });

  it("is unknown on a rate limit, on a timeout and on a layout change", async () => {
    const limited = setup({ github: () => { throw new HttpError("GitHub fetch failed: 403 rate limit exceeded", 403); } });
    expect((await limited.checker.check({ name: "Stock Paws", ticker: "PAWS" })).github.status).toBe("unknown");
    const hung = setup({ github: () => new Promise<string>(() => {}), timeoutMs: 20 });
    expect((await hung.checker.check({ name: "Stock Paws", ticker: "PAWS" })).github.status).toBe("unknown");
    const changed = setup({ github: () => JSON.stringify({ message: "moved" }) });
    expect((await changed.checker.check({ name: "Stock Paws", ticker: "PAWS" })).github.status).toBe("unknown");
  });

  it("an unnamed repo (a name with no letters or digits) cannot be checked, so it is unknown", async () => {
    const { checker, urls } = setup();
    expect((await checker.check({ name: "!!!", ticker: "PAWS" })).github.status).toBe("unknown");
    expect(urls.some((u) => u.includes("/search/repositories"))).toBe(false);
  });

  it("backs off after a rate limit: no request goes out until the wait is over, and the skipped check is unknown", async () => {
    let limited = true;
    const { checker, urls, advance } = setup({
      github: () => {
        if (limited) throw new HttpError("GitHub fetch failed: 429", 429, 120_000);
        return ghBody();
      },
    });
    const ask = () => checker.check({ name: "Stock Paws", ticker: "PAWS" });
    expect((await ask()).github.status).toBe("unknown");
    const sent = urls.filter((u) => u.includes("/search/repositories")).length;
    limited = false;
    advance(60_000);
    const skipped = await ask();
    expect(skipped.github.status).toBe("unknown");
    expect(skipped.github.detail).toMatch(/backing off/i);
    expect(urls.filter((u) => u.includes("/search/repositories")).length).toBe(sent);
    advance(61_000);
    expect((await ask()).github.status).toBe("clear");
  });
});

describe("the test run", () => {
  it("points DexScreener and GitHub at a dead loopback port, so no worker a test spawns reaches the network", () => {
    expect(process.env.ARGUS_DEXSCREENER_URL).toBe("http://127.0.0.1:1");
    expect(process.env.ARGUS_GITHUB_SEARCH_URL).toBe("http://127.0.0.1:1");
  });
});

describe("describeCollision", () => {
  it("never words an unknown as clear", () => {
    const c = { status: "unknown" as const, detail: "timed out", source: "GitHub", checkedAt: T0.toISOString() };
    expect(describeCollision(c)).toMatch(/unknown/i);
    expect(describeCollision(c)).not.toMatch(/clear/i);
  });
});
