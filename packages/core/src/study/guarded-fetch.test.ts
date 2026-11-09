import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { guardedGet, nodeTransport, type Resolver, type Transport, type TransportResponse } from "./guarded-fetch.ts";

const PUBLIC = "93.184.216.34";
const bodyOf = (...chunks: string[]): AsyncIterable<Uint8Array> =>
  (async function* () {
    for (const c of chunks) yield Buffer.from(c);
  })();
const reply = (status: number, headers: Record<string, string>, ...chunks: string[]): TransportResponse => ({ status, headers, body: bodyOf(...chunks), destroy: () => {} });

/** A fake network: host -> addresses for DNS, and url -> response for the wire. Records every connection. */
function fakeNet(dns: Record<string, string[]>, pages: Record<string, TransportResponse | (() => TransportResponse)>) {
  const connections: Array<{ url: string; address: string; headers: Record<string, string> }> = [];
  const resolve: Resolver = async (host) => {
    const a = dns[host];
    if (!a) throw new Error(`ENOTFOUND ${host}`);
    return a;
  };
  const transport: Transport = async (req) => {
    connections.push({ url: req.url.href, address: req.address, headers: req.headers });
    const page = pages[req.url.href];
    if (!page) return reply(404, {});
    return typeof page === "function" ? page() : page;
  };
  return { resolve, transport, connections };
}

describe("guardedGet: SSRF", () => {
  it("refuses a private address literal without connecting", async () => {
    const net = fakeNet({}, {});
    const r = await guardedGet("http://127.0.0.1/", { ...net, maxBytes: 1000, timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, reason: "blocked" });
    expect(net.connections).toEqual([]);
  });

  it("refuses a host that resolves to a private address, and one that resolves to a public and a private address", async () => {
    const net = fakeNet({ "evil.example": ["10.0.0.5"], "split.example": [PUBLIC, "169.254.169.254"] }, {});
    for (const host of ["evil.example", "split.example"]) {
      const r = await guardedGet(`https://${host}/`, { ...net, maxBytes: 1000, timeoutMs: 1000 });
      expect(r, host).toMatchObject({ ok: false, reason: "blocked" });
    }
    expect(net.connections).toEqual([]);
  });

  it("refuses a redirect to a loopback or metadata address and never connects to it", async () => {
    for (const target of ["http://127.0.0.1:80/admin", "http://169.254.169.254/latest/meta-data/", "http://[::1]/"]) {
      const net = fakeNet({ "good.example": [PUBLIC] }, { "https://good.example/": reply(302, { location: target }) });
      const r = await guardedGet("https://good.example/", { ...net, maxBytes: 1000, timeoutMs: 1000 });
      expect(r, target).toMatchObject({ ok: false, reason: "blocked" });
      expect(net.connections.map((c) => c.url)).toEqual(["https://good.example/"]);
    }
  });

  it("refuses a redirect to a name that resolves to a private address (DNS checked per hop)", async () => {
    const net = fakeNet({ "good.example": [PUBLIC], "rebind.example": ["192.168.0.10"] }, { "https://good.example/": reply(301, { location: "https://rebind.example/x" }) });
    const r = await guardedGet("https://good.example/", { ...net, maxBytes: 1000, timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, reason: "blocked" });
    expect(net.connections).toHaveLength(1);
  });

  it("connects to the address it validated, with the original Host header", async () => {
    const net = fakeNet({ "site.example": [PUBLIC] }, { "https://site.example/": reply(200, { "content-type": "text/html" }, "hi") });
    await guardedGet("https://site.example/", { ...net, maxBytes: 1000, timeoutMs: 1000 });
    expect(net.connections[0]).toMatchObject({ address: PUBLIC, headers: expect.objectContaining({ host: "site.example" }) });
  });

  it("follows a relative redirect to a public page and reports the final URL", async () => {
    const net = fakeNet({ "site.example": [PUBLIC] }, { "https://site.example/a": reply(301, { location: "/b" }), "https://site.example/b": reply(200, { "content-type": "text/html" }, "ok") });
    const r = await guardedGet("https://site.example/a", { ...net, maxBytes: 1000, timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: true, finalUrl: "https://site.example/b", status: 200 });
    expect(r.ok && r.body.toString()).toBe("ok");
  });

  it("stops after the redirect limit", async () => {
    const net = fakeNet({ "loop.example": [PUBLIC] }, { "https://loop.example/": () => reply(302, { location: "https://loop.example/" }) });
    const r = await guardedGet("https://loop.example/", { ...net, maxBytes: 1000, timeoutMs: 1000, maxRedirects: 3 });
    expect(r).toMatchObject({ ok: false, reason: "redirect-limit" });
    expect(net.connections).toHaveLength(4);
  });
});

describe("guardedGet: caps", () => {
  it("cuts a body at the size cap, flags it and stops reading", async () => {
    let pulled = 0;
    const endless: TransportResponse = {
      status: 200,
      headers: { "content-type": "text/html" },
      body: (async function* () {
        for (;;) {
          pulled++;
          yield Buffer.alloc(400, "a");
        }
      })(),
      destroy: () => {},
    };
    const net = fakeNet({ "big.example": [PUBLIC] }, { "https://big.example/": endless });
    const r = await guardedGet("https://big.example/", { ...net, maxBytes: 1000, timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: true, truncated: true });
    expect(r.ok && r.body.length).toBe(1000);
    expect(pulled).toBeLessThanOrEqual(4);
  });

  it("does not flag a body exactly at the cap", async () => {
    const net = fakeNet({ "x.example": [PUBLIC] }, { "https://x.example/": reply(200, {}, "a".repeat(1000)) });
    const r = await guardedGet("https://x.example/", { ...net, maxBytes: 1000, timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: true, truncated: false });
  });

  it("gives up at the time cap when the server never answers", async () => {
    const hang: Transport = () => new Promise<TransportResponse>(() => {});
    const started = Date.now();
    const r = await guardedGet("https://slow.example/", { resolve: async () => [PUBLIC], transport: hang, maxBytes: 1000, timeoutMs: 40 });
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("gives up at the time cap when the body trickles", async () => {
    let destroyed = false;
    const trickle: TransportResponse = {
      status: 200,
      headers: {},
      body: (async function* () {
        for (;;) {
          await new Promise((r) => setTimeout(r, 20));
          yield Buffer.from("a");
        }
      })(),
      destroy: () => {
        destroyed = true;
      },
    };
    const r = await guardedGet("https://trickle.example/", { resolve: async () => [PUBLIC], transport: async () => trickle, maxBytes: 100_000, timeoutMs: 80 });
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
    expect(destroyed).toBe(true);
  });

  it("reports a DNS failure as an error, not a block", async () => {
    const net = fakeNet({}, {});
    const r = await guardedGet("https://nowhere.example/", { ...net, maxBytes: 1000, timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, reason: "error" });
  });
});

describe("guardedGet: beforeRequest hook", () => {
  it("lets the caller refuse any hop, including a redirect target", async () => {
    const net = fakeNet({ "a.example": [PUBLIC], "b.example": [PUBLIC] }, { "https://a.example/": reply(302, { location: "https://b.example/" }), "https://b.example/": reply(200, {}, "x") });
    const r = await guardedGet("https://a.example/", { ...net, maxBytes: 1000, timeoutMs: 1000, beforeRequest: async (u) => (u.hostname === "b.example" ? "no" : undefined) });
    expect(r).toMatchObject({ ok: false, reason: "refused", detail: "no" });
    expect(net.connections.map((c) => c.url)).toEqual(["https://a.example/"]);
  });
});

describe("nodeTransport (the real wire; the guard is guardedGet's job, not its)", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  it("connects to the given address, sends the Host header and returns status, headers and body", async () => {
    const seen: Array<{ host?: string; ua?: string; encoding?: string }> = [];
    server = createServer((req, res) => {
      seen.push({ host: req.headers.host, ua: req.headers["user-agent"], encoding: req.headers["accept-encoding"] });
      res.writeHead(200, { "content-type": "text/html" }).end("<p>hello</p>");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const ac = new AbortController();
    const res = await nodeTransport({ url: new URL(`http://site.example:${port}/p`), address: "127.0.0.1", headers: { host: "site.example", "user-agent": "t", "accept-encoding": "identity" }, signal: ac.signal });
    const chunks: Buffer[] = [];
    for await (const c of res.body) chunks.push(Buffer.from(c));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(Buffer.concat(chunks).toString()).toBe("<p>hello</p>");
    expect(seen).toEqual([{ host: "site.example", ua: "t", encoding: "identity" }]);
  });

  it("guardedGet with the real transport never connects to a loopback server", async () => {
    let connections = 0;
    server = createServer((_req, res) => res.end("secret"));
    server.on("connection", () => connections++);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    // port is refused by the port rule; the loopback address would be refused anyway
    const r = await guardedGet(`http://127.0.0.1:${port}/`, { maxBytes: 1000, timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, reason: "blocked" });
    const viaName = await guardedGet("http://localtest.example/", { resolve: async () => ["127.0.0.1"], maxBytes: 1000, timeoutMs: 1000 });
    expect(viaName).toMatchObject({ ok: false, reason: "blocked" });
    expect(connections).toBe(0);
  });
});
