import { describe, expect, it } from "vitest";
import { buildLaunchLink, isMintAddress } from "./launch.ts";

const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

describe("isMintAddress", () => {
  it("accepts base58 of 32 to 44 characters", () => {
    expect(isMintAddress(MINT)).toBe(true);
    expect(isMintAddress("1".repeat(32))).toBe(true);
  });
  it("rejects the wrong length, characters outside base58 (0 O I l), whitespace and non-strings", () => {
    expect(isMintAddress("1".repeat(31))).toBe(false);
    expect(isMintAddress("1".repeat(45))).toBe(false);
    expect(isMintAddress(`0${MINT.slice(1)}`)).toBe(false);
    expect(isMintAddress(`${MINT} `)).toBe(false);
    expect(isMintAddress("https://pump.fun/coin/" + MINT)).toBe(false);
    expect(isMintAddress(undefined)).toBe(false);
  });
});

describe("buildLaunchLink", () => {
  const p = { name: "Moon Cat", ticker: "MCAT", description: "A cat & a moon", previewUrl: "https://moon-cat.me.workers.dev" };
  it("builds the query newpairspam reads, encoded", () => {
    const u = new URL(buildLaunchLink(p, { baseUrl: "http://localhost:3000" }));
    expect(u.origin).toBe("http://localhost:3000");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      name: "Moon Cat",
      symbol: "MCAT",
      description: "A cat & a moon",
      website: "https://moon-cat.me.workers.dev",
    });
  });
  it("defaults the base, drops a path or query on it, and clamps to the form's limits", () => {
    const u = new URL(buildLaunchLink({ ...p, name: "n".repeat(40), ticker: "ABCDEFGHIJKL" }, { baseUrl: "https://np.example/app?x=1" }));
    expect(u.origin + u.pathname).toBe("https://np.example/");
    expect(u.searchParams.get("name")).toHaveLength(32);
    expect(u.searchParams.get("symbol")).toBe("ABCDEFGHIJ");
    expect(new URL(buildLaunchLink(p)).origin).toBe("http://localhost:3000");
    expect(new URL(buildLaunchLink(p, { baseUrl: "  " })).origin).toBe("http://localhost:3000");
  });
  it("sends imageUrl only for a configured http(s) logo, website only with a preview", () => {
    expect(new URL(buildLaunchLink(p, { logoUrl: "https://cdn.example/logo.png" })).searchParams.get("imageUrl")).toBe("https://cdn.example/logo.png");
    expect(new URL(buildLaunchLink(p, { logoUrl: "javascript:1" })).searchParams.has("imageUrl")).toBe(false);
    expect(new URL(buildLaunchLink(p)).searchParams.has("imageUrl")).toBe(false);
    expect(new URL(buildLaunchLink({ ...p, previewUrl: null })).searchParams.has("website")).toBe(false);
  });
});
