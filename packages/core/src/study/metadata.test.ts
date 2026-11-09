import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Resolver, Transport, TransportResponse } from "./guarded-fetch.ts";
import { fetchMetadata, inPopulation, parseMetadata } from "./metadata.ts";

const json = (o: unknown) => JSON.stringify(o);

describe("parseMetadata", () => {
  it("reads description, image and the three links from a pump.fun metadata document", () => {
    const m = parseMetadata(json({ name: "Moon Cat", symbol: "MCAT", description: "The first cat on the moon", image: "https://ipfs.io/ipfs/img", showName: true, createdOn: "pump.fun", twitter: "https://x.com/mooncat", telegram: "https://t.me/mooncat", website: "https://mooncat.example" }));
    expect(m).toEqual({
      description: "The first cat on the moon",
      imageUrl: "https://ipfs.io/ipfs/img",
      websiteUrl: "https://mooncat.example/",
      xUrl: "https://x.com/mooncat",
      telegramUrl: "https://t.me/mooncat",
    });
  });

  it("treats twitter.com as an X link and normalises it to x.com", () => {
    expect(parseMetadata(json({ twitter: "https://twitter.com/mooncat" }))?.xUrl).toBe("https://x.com/mooncat");
    expect(parseMetadata(json({ twitter: "https://www.twitter.com/mooncat" }))?.xUrl).toBe("https://x.com/mooncat");
    expect(parseMetadata(json({ twitter: "https://x.com/i/communities/123" }))?.xUrl).toBe("https://x.com/i/communities/123");
  });

  it("sorts a link by what it points at, whichever field the creator put it in", () => {
    const m = parseMetadata(json({ website: "https://x.com/mooncat", twitter: "https://t.me/mooncat", telegram: "" }));
    expect(m).toMatchObject({ websiteUrl: null, xUrl: "https://x.com/mooncat", telegramUrl: "https://t.me/mooncat" });
  });

  it("ignores things that are not links: empty, a bare x.com, a handle, scripts, over-long URLs", () => {
    const m = parseMetadata(json({ website: "javascript:alert(1)", twitter: "https://x.com/", telegram: "@mooncat" }));
    expect(m).toMatchObject({ websiteUrl: null, xUrl: null, telegramUrl: null });
    expect(parseMetadata(json({ website: `https://a.example/${"x".repeat(2100)}` }))?.websiteUrl).toBeNull();
    expect(parseMetadata(json({ twitter: "mooncat" }))?.xUrl).toBeNull();
  });

  it("keeps only one website URL even if the document names several", () => {
    const m = parseMetadata(json({ website: "https://one.example", external_url: "https://two.example", extensions: { website: "https://three.example" } }));
    expect(m?.websiteUrl).toBe("https://one.example/");
  });

  it("sanitises text like the PumpPortal Source: markup removed, trimmed, cut", () => {
    const m = parseMetadata(json({ description: `  <img src=x onerror=alert(1)>Hello <b>world</b> ${"y".repeat(5000)}` }));
    expect(m?.description.startsWith("Hello world y")).toBe(true);
    expect(m?.description).not.toContain("<");
    expect(m!.description.length).toBeLessThanOrEqual(1000);
  });

  it("returns undefined for something that is not a JSON object", () => {
    for (const bad of ["", "not json", "[]", "42", "null", '"str"']) expect(parseMetadata(bad), bad).toBeUndefined();
  });

  it("handles non-string field values", () => {
    expect(parseMetadata(json({ website: 5, twitter: { a: 1 }, description: ["x"], image: null }))).toEqual({ description: "", imageUrl: null, websiteUrl: null, xUrl: null, telegramUrl: null });
  });
});

describe("population rule", () => {
  const links = (o: Partial<{ websiteUrl: string | null; xUrl: string | null; telegramUrl: string | null }>) => ({ description: "", imageUrl: null, websiteUrl: null, xUrl: null, telegramUrl: null, ...o });
  it("a website or an X link means studied", () => {
    expect(inPopulation(links({ websiteUrl: "https://a.example/" }))).toEqual({ studied: true, reason: "population: website link" });
    expect(inPopulation(links({ xUrl: "https://x.com/a" }))).toEqual({ studied: true, reason: "population: X link" });
    expect(inPopulation(links({ websiteUrl: "https://a.example/", xUrl: "https://x.com/a" }))).toEqual({ studied: true, reason: "population: website and X links" });
  });
  it("neither means counted only, and a Telegram link alone does not count", () => {
    expect(inPopulation(links({}))).toEqual({ studied: false, reason: "no website or X link" });
    expect(inPopulation(links({ telegramUrl: "https://t.me/a" }))).toEqual({ studied: false, reason: "no website or X link" });
  });
});

describe("fetchMetadata", () => {
  const PUBLIC = "93.184.216.34";
  const resolve: Resolver = async () => [PUBLIC];
  const answer = (status: number, body: string): TransportResponse => ({ status, headers: { "content-type": "application/json" }, body: (async function* () { yield Buffer.from(body); })(), destroy: () => {} });
  const opts = { maxBytes: 64 * 1024, timeoutMs: 500 };

  it("fetches the uri once through the guard and parses it", async () => {
    const seen: string[] = [];
    const transport: Transport = async (req) => (seen.push(req.url.href), answer(200, json({ website: "https://mooncat.example", description: "d" })));
    const r = await fetchMetadata("https://ipfs.io/ipfs/bafy", { ...opts, resolve, transport });
    expect(r).toMatchObject({ ok: true, metadata: { websiteUrl: "https://mooncat.example/", description: "d" } });
    expect(seen).toEqual(["https://ipfs.io/ipfs/bafy"]);
  });

  it("refuses a uri that points at a private address, without connecting", async () => {
    const seen: string[] = [];
    const transport: Transport = async (req) => (seen.push(req.url.href), answer(200, "{}"));
    for (const uri of ["http://127.0.0.1/meta.json", "http://169.254.169.254/latest/meta-data/", "file:///etc/passwd"]) {
      expect(await fetchMetadata(uri, { ...opts, resolve, transport }), uri).toMatchObject({ ok: false });
    }
    expect(seen).toEqual([]);
  });

  it("fails on an HTTP error, a non-JSON body and an over-size body", async () => {
    const t = (status: number, body: string): Transport => async () => answer(status, body);
    expect(await fetchMetadata("https://ipfs.io/x", { ...opts, resolve, transport: t(404, "") })).toMatchObject({ ok: false });
    expect(await fetchMetadata("https://ipfs.io/x", { ...opts, resolve, transport: t(200, "<html>") })).toMatchObject({ ok: false });
    expect(await fetchMetadata("https://ipfs.io/x", { ...opts, resolve, maxBytes: 20, transport: t(200, json({ description: "a".repeat(100) })) })).toMatchObject({ ok: false });
  });

  it("the recorded PumpPortal create fixture carries a uri that the guard accepts (no links come with the payload itself)", () => {
    const create = JSON.parse(readFileSync(new URL("../fixtures/pumpportal-create.json", import.meta.url), "utf8")) as { uri: string };
    expect(create.uri).toMatch(/^https:\/\/ipfs\.io\/ipfs\//);
  });
});
