import { describe, expect, it } from "vitest";
import type { Resolver, Transport, TransportResponse } from "./guarded-fetch.ts";
import { DEFAULT_IPFS_GATEWAYS, GatewayStats, ipfsGateways, metadataCandidates, parseIpfsUri } from "./ipfs-gateways.ts";
import { fetchMetadata } from "./metadata.ts";

const CID = "bafkreictddc23key7yw5gps2prjn7tuuckwokbnjzx7qwflelxcypnomz4";
const GW = ["https://gw-a.example/ipfs/", "https://gw-b.example/ipfs/"];

describe("uri rewrite", () => {
  it("rewrites an ipfs.io uri to every configured gateway, in order", () => {
    expect(metadataCandidates(`https://ipfs.io/ipfs/${CID}`, GW)).toEqual([`https://gw-a.example/ipfs/${CID}`, `https://gw-b.example/ipfs/${CID}`]);
  });

  it("handles other public gateways, subdomain form, ipfs://, a sub-path and a query", () => {
    for (const uri of [`https://dweb.link/ipfs/${CID}`, "https://bafkreictddc23key7yw5gps2prjn7tuuckwokbnjzx7qwflelxcypnomz4.ipfs.dweb.link/", `ipfs://${CID}`, `https://gateway.pinata.cloud/ipfs/${CID}`]) {
      expect(metadataCandidates(uri, GW), uri).toEqual([`https://gw-a.example/ipfs/${CID}`, `https://gw-b.example/ipfs/${CID}`]);
    }
    expect(parseIpfsUri(`https://ipfs.io/ipfs/${CID}/meta.json?x=1`)).toEqual({ cid: CID, rest: "/meta.json?x=1" });
  });

  it("leaves a non-IPFS uri, an unknown host and a bad CID alone", () => {
    for (const uri of ["https://arweave.net/abc", `https://evil.example/ipfs/${CID}`, "https://ipfs.io/ipfs/short", "https://ipfs.io/other"]) {
      expect(metadataCandidates(uri, GW), uri).toEqual([uri]);
    }
  });

  it("with no gateways configured, uris are fetched as written", () => {
    expect(metadataCandidates(`https://ipfs.io/ipfs/${CID}`, [])).toEqual([`https://ipfs.io/ipfs/${CID}`]);
  });

  it("the default list does not include ipfs.io", () => {
    expect(DEFAULT_IPFS_GATEWAYS.some((g) => g.includes("//ipfs.io/"))).toBe(false);
  });
});

describe("ipfsGateways config", () => {
  it("defaults, reads an ordered comma list, normalises it and drops junk", () => {
    expect(ipfsGateways({})).toEqual([...DEFAULT_IPFS_GATEWAYS]);
    expect(ipfsGateways({ ARGUS_STUDY_IPFS_GATEWAYS: "https://a.example, junk, http://insecure.example/ipfs/, https://b.example/ipfs" })).toEqual(["https://a.example/", "https://b.example/ipfs/"]);
    expect(ipfsGateways({ ARGUS_STUDY_IPFS_GATEWAYS: "junk" })).toEqual([...DEFAULT_IPFS_GATEWAYS]);
  });
});

describe("fetchMetadata across gateways", () => {
  const resolve: Resolver = async () => ["93.184.216.34"];
  const answer = (status: number, body = ""): TransportResponse => ({ status, headers: {}, body: (async function* () { yield Buffer.from(body); })(), destroy: () => {} });
  const opts = { maxBytes: 64 * 1024, timeoutMs: 500, resolve, gateways: GW };

  it("falls back on 429 and counts each gateway", async () => {
    const seen: string[] = [];
    const transport: Transport = async (req) => (seen.push(req.url.hostname), req.url.hostname === "gw-a.example" ? answer(429) : answer(200, '{"twitter":"https://x.com/a"}'));
    const stats = new GatewayStats();
    const r = await fetchMetadata(`https://ipfs.io/ipfs/${CID}`, { ...opts, transport, stats });
    expect(r).toMatchObject({ ok: true });
    expect(seen).toEqual(["gw-a.example", "gw-b.example"]);
    expect(stats.summary()).toBe("gw-a.example ok=0 fail=1, gw-b.example ok=1 fail=0");
  });

  it("when every gateway fails retryably the result is retryable; a 404 stops without trying the rest", async () => {
    const all429: Transport = async () => answer(429);
    expect(await fetchMetadata(`https://ipfs.io/ipfs/${CID}`, { ...opts, transport: all429 })).toMatchObject({ ok: false, detail: "HTTP 429", retryable: true });
    const seen: string[] = [];
    const nf: Transport = async (req) => (seen.push(req.url.hostname), answer(404));
    expect(await fetchMetadata(`https://ipfs.io/ipfs/${CID}`, { ...opts, transport: nf })).toMatchObject({ ok: false, retryable: false });
    expect(seen).toEqual(["gw-a.example"]);
  });
});
