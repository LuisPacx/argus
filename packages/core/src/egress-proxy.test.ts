import { once } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isPublicAddress, parseAllowlist, startEgressProxy, type EgressProxy, type EgressProxyOptions } from "./egress-proxy.ts";

const ALLOWED = "api.anthropic.com";

interface Rig {
  proxy: EgressProxy;
  logs: string[];
  /** Number of TCP connections the fake upstream accepted. */
  upstreamConnections: () => number;
  /** Hostnames the proxy asked the resolver about. */
  resolved: string[];
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A fake upstream that answers every chunk with "echo:" + chunk. Stands in for api.anthropic.com:443. */
async function fakeUpstream() {
  let connections = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    connections++;
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => {});
    s.on("data", (d) => s.write(Buffer.concat([Buffer.from("echo:"), d])));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return { port: (server.address() as net.AddressInfo).port, connections: () => connections };
}

/** Real proxy on a loopback port; DNS and the upstream port are test doubles, the policy code is the real one. */
async function rig(over: Partial<EgressProxyOptions> = {}, opts: { resolveTo?: string[]; allowPrivate?: boolean } = {}): Promise<Rig> {
  const upstream = await fakeUpstream();
  const logs: string[] = [];
  const resolved: string[] = [];
  const proxy = await startEgressProxy({
    allow: [`${ALLOWED}:443`, "registry.npmjs.org:443"],
    host: "127.0.0.1",
    port: 0,
    log: (l) => logs.push(l),
    testOverrides: {
      resolve: async (h) => {
        resolved.push(h);
        return opts.resolveTo ?? ["127.0.0.1"];
      },
      allowPrivateAddresses: opts.allowPrivate ?? true,
      upstreamPort: upstream.port,
    },
    ...over,
  });
  cleanups.push(() => proxy.close());
  return { proxy, logs, upstreamConnections: upstream.connections, resolved };
}

function connectClient(port: number) {
  const sock = net.connect(port, "127.0.0.1");
  sock.on("error", () => {});
  cleanups.push(() => void sock.destroy());
  let buf = Buffer.alloc(0);
  const waiters: Array<() => void> = [];
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    waiters.splice(0).forEach((w) => w());
  });
  const closed = new Promise<void>((r) => sock.on("close", () => r()));
  return {
    sock,
    closed,
    received: () => buf.toString("latin1"),
    /** Resolve once `pred` is true of everything received so far. */
    async until(pred: (s: string) => boolean, ms = 3000) {
      const deadline = Date.now() + ms;
      while (!pred(buf.toString("latin1"))) {
        if (Date.now() > deadline) throw new Error(`timeout; got ${buf.length} bytes: ${JSON.stringify(buf.toString("latin1").slice(0, 200))}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 25);
        });
      }
      return buf.toString("latin1");
    },
  };
}

/** Send raw bytes, read until the proxy closes, return the status code and the whole response. */
async function raw(r: Rig, bytes: string | Buffer) {
  const c = connectClient(r.proxy.port);
  c.sock.write(bytes);
  await Promise.race([c.closed, new Promise((_, rej) => setTimeout(() => rej(new Error("proxy did not close")), 3000))]);
  const text = c.received();
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);
  return { status, text };
}

const connectReq = (target: string, extra = "") => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${extra}\r\n`;

describe("egress proxy: allowed CONNECT", () => {
  it("tunnels bytes both ways to the allowlisted host:443 and logs the allowed tunnel", async () => {
    const r = await rig();
    const c = connectClient(r.proxy.port);
    c.sock.write(connectReq(`${ALLOWED}:443`));
    await c.until((s) => s.includes("\r\n\r\n"));
    expect(c.received()).toMatch(/^HTTP\/1\.1 200 /);
    c.sock.write("hello");
    expect(await c.until((s) => s.endsWith("echo:hello"))).toContain("echo:hello");
    expect(r.resolved).toEqual([ALLOWED]);
    expect(r.logs.join("\n")).toContain(`"event":"allowed"`);
    expect(r.logs.join("\n")).toContain(ALLOWED);
  });

  it("matches the host case-insensitively", async () => {
    const r = await rig();
    const c = connectClient(r.proxy.port);
    c.sock.write(connectReq("API.Anthropic.COM:443"));
    await c.until((s) => s.includes("\r\n\r\n"));
    expect(c.received()).toMatch(/^HTTP\/1\.1 200 /);
    expect(r.resolved).toEqual([ALLOWED]);
  });

  it("forwards bytes the client pipelined right behind the CONNECT headers", async () => {
    const r = await rig();
    const c = connectClient(r.proxy.port);
    c.sock.write(connectReq(`${ALLOWED}:443`) + "early");
    expect(await c.until((s) => s.endsWith("echo:early"))).toMatch(/^HTTP\/1\.1 200 /);
  });
});

describe("egress proxy: refusals (deny by default)", () => {
  const refused: Array<[string, string, number, string]> = [
    // [case, raw request, expected status, expected reason in the log]
    ["a host that is not on the allowlist", connectReq("example.com:443"), 403, "host-not-allowed"],
    ["a suffix of an allowed host (evil-api.anthropic.com)", connectReq("evil-api.anthropic.com:443"), 403, "host-not-allowed"],
    ["a subdomain of an allowed host", connectReq("sub.api.anthropic.com:443"), 403, "host-not-allowed"],
    ["an allowed host used as a subdomain of another (api.anthropic.com.evil.test)", connectReq("api.anthropic.com.evil.test:443"), 403, "host-not-allowed"],
    ["an allowed host with a trailing dot", connectReq("api.anthropic.com.:443"), 403, "host-not-allowed"],
    ["an allowed host with a double dot", connectReq("api..anthropic.com:443"), 403, "host-not-allowed"],
    ["the allowlisted host on port 80", connectReq(`${ALLOWED}:80`), 403, "port-not-allowed"],
    ["the allowlisted host on port 8443", connectReq(`${ALLOWED}:8443`), 403, "port-not-allowed"],
    ["a zero-padded port", connectReq(`${ALLOWED}:0443`), 403, "port-not-allowed"],
    ["a missing port", connectReq(ALLOWED), 403, "bad-target"],
    ["an empty port", connectReq(`${ALLOWED}:`), 403, "bad-target"],
    ["userinfo spoofing (allowed:443@evil)", connectReq(`${ALLOWED}:443@evil.test:443`), 403, "bad-target"],
    ["userinfo spoofing (allowed@evil)", connectReq(`${ALLOWED}@evil.test:443`), 403, "bad-target"],
    ["a percent-encoded host", connectReq("api%2eanthropic.com:443"), 403, "bad-target"],
    ["a path in the target", connectReq(`${ALLOWED}:443/x`), 403, "bad-target"],
    ["an IPv4 literal", connectReq("1.1.1.1:443"), 403, "ip-literal"],
    ["a loopback IPv4 literal", connectReq("127.0.0.1:443"), 403, "ip-literal"],
    ["a decimal IPv4 literal", connectReq("2130706433:443"), 403, "ip-literal"],
    ["an IPv4 shorthand literal", connectReq("127.1:443"), 403, "ip-literal"],
    ["a bracketed IPv6 literal", connectReq("[2606:4700::1111]:443"), 403, "bad-target"],
    ["a bracketed IPv4-mapped IPv6 literal", connectReq("[::ffff:127.0.0.1]:443"), 403, "bad-target"],
    ["a wildcard host", connectReq("*.anthropic.com:443"), 403, "bad-target"],
    ["host spoofing by Host header (CONNECT evil, Host allowed)", `CONNECT evil.test:443 HTTP/1.1\r\nHost: ${ALLOWED}:443\r\n\r\n`, 403, "host-not-allowed"],
    ["host spoofing by absolute-URI (CONNECT https://allowed:443)", connectReq(`https://${ALLOWED}:443`), 403, "bad-target"],
    ["plain HTTP GET with an absolute URI", `GET http://${ALLOWED}/ HTTP/1.1\r\nHost: ${ALLOWED}\r\n\r\n`, 405, "method-not-allowed"],
    ["plain HTTP GET to an allowed host", `GET / HTTP/1.1\r\nHost: ${ALLOWED}\r\n\r\n`, 405, "method-not-allowed"],
    ["POST", `POST http://${ALLOWED}/ HTTP/1.1\r\nHost: ${ALLOWED}\r\nContent-Length: 0\r\n\r\n`, 405, "method-not-allowed"],
    ["a lowercase method", connectReq(`${ALLOWED}:443`).replace("CONNECT", "connect"), 405, "method-not-allowed"],
    ["a CONNECT with the wrong version", `CONNECT ${ALLOWED}:443 HTTP/2.0\r\n\r\n`, 400, "bad-http-version"],
    ["HTTP/0.9 style request line", `CONNECT ${ALLOWED}:443\r\n\r\n`, 400, "malformed-request-line"],
    ["a request line with a double space", `CONNECT  ${ALLOWED}:443 HTTP/1.1\r\n\r\n`, 400, "malformed-request-line"],
    ["a request line with a tab", `CONNECT\t${ALLOWED}:443 HTTP/1.1\r\n\r\n`, 400, "malformed-request-line"],
    ["a NUL byte in the request line", `CONNECT ${ALLOWED}:443\0 HTTP/1.1\r\n\r\n`, 400, "malformed-request-line"],
    ["an empty request line", `\r\n\r\n`, 400, "malformed-request-line"],
  ];

  it.each(refused)("refuses %s, logs it, and opens no upstream connection or DNS query", async (_name, request, status, reason) => {
    const r = await rig();
    const res = await raw(r, request);
    expect(res.status).toBe(status);
    expect(r.logs.some((l) => l.includes(`"event":"denied"`) && l.includes(`"reason":"${reason}"`))).toBe(true);
    expect(r.logs.some((l) => l.includes(`"event":"allowed"`))).toBe(false);
    expect(r.upstreamConnections()).toBe(0);
    expect(r.resolved).toEqual([]);
  });

  it("never lets attacker-controlled text forge a log line (JSON-escaped, truncated)", async () => {
    const r = await rig();
    await raw(r, connectReq(`x"\r\n{"event":"allowed"}${"a".repeat(500)}:443`));
    for (const l of r.logs) expect(() => JSON.parse(l)).not.toThrow();
    expect(r.logs.some((l) => JSON.parse(l).event === "allowed")).toBe(false);
    expect(r.logs.every((l) => l.length < 400)).toBe(true);
  });

  it("answers a refused method with an Allow: CONNECT header", async () => {
    const r = await raw(await rig(), "GET / HTTP/1.1\r\n\r\n");
    expect(r.text).toContain("Allow: CONNECT");
  });
});

describe("egress proxy: addresses it will actually connect to", () => {
  const publicIps = ["160.79.104.10", "104.16.0.1", "8.8.8.8", "2606:4700::1111", "2607:6bc0::10"];
  const nonPublicIps = [
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.89.77.2", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "100.127.255.255", "0.0.0.0", "0.1.2.3", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    "198.18.0.1", "192.0.0.1", "192.0.2.1", "198.51.100.7", "203.0.113.9",
    "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:8.8.8.8",
    "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "2001::1", "not-an-ip", "",
  ];
  it.each(publicIps)("accepts public address %s", (ip) => expect(isPublicAddress(ip)).toBe(true));
  it.each(nonPublicIps)("refuses non-public address %j", (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each(["127.0.0.1", "10.89.77.2", "169.254.169.254", "::1", "fd00::1"])("refuses an allowlisted name that resolves to %s and never connects", async (ip) => {
    const r = await rig({}, { resolveTo: [ip], allowPrivate: false });
    const res = await raw(r, connectReq(`${ALLOWED}:443`));
    expect(res.status).toBe(403);
    expect(r.logs.some((l) => l.includes(`"reason":"private-address"`))).toBe(true);
    expect(r.upstreamConnections()).toBe(0);
  });

  it("refuses the whole name when only one of several answers is private (rebinding signal)", async () => {
    const r = await rig({}, { resolveTo: ["8.8.8.8", "127.0.0.1"], allowPrivate: false });
    expect((await raw(r, connectReq(`${ALLOWED}:443`))).status).toBe(403);
    expect(r.upstreamConnections()).toBe(0);
  });

  it("resolves once and connects to the address it validated, not to a second lookup", async () => {
    const r = await rig({}, { resolveTo: ["127.0.0.1"] });
    const c = connectClient(r.proxy.port);
    c.sock.write(connectReq(`${ALLOWED}:443`));
    await c.until((s) => s.includes("\r\n\r\n"));
    expect(r.resolved).toEqual([ALLOWED]);
    expect(r.logs.join("\n")).toContain(`"address":"127.0.0.1"`);
  });

  it("falls back to the next validated address when the first refuses the connection", async () => {
    const r = await rig({}, { resolveTo: ["127.0.0.2", "127.0.0.1"] });
    const c = connectClient(r.proxy.port);
    c.sock.write(connectReq(`${ALLOWED}:443`));
    await c.until((s) => s.includes("\r\n\r\n"));
    expect(c.received()).toMatch(/^HTTP\/1\.1 200 /);
    expect(r.logs.join("\n")).toContain(`"address":"127.0.0.1"`);
  });

  it("answers 502 when the name does not resolve", async () => {
    const r = await rig({}, { resolveTo: [] });
    expect((await raw(r, connectReq(`${ALLOWED}:443`))).status).toBe(502);
  });

  it("answers 502 when the resolver throws", async () => {
    const r = await rig({ testOverrides: { resolve: async () => { throw new Error("ENOTFOUND"); } } });
    expect((await raw(r, connectReq(`${ALLOWED}:443`))).status).toBe(502);
  });

  it("answers 502 when the upstream refuses the connection", async () => {
    const dead = net.createServer();
    dead.listen(0, "127.0.0.1");
    await once(dead, "listening");
    const deadPort = (dead.address() as net.AddressInfo).port;
    dead.close();
    await once(dead, "close");
    const r = await rig({ testOverrides: { resolve: async () => ["127.0.0.1"], allowPrivateAddresses: true, upstreamPort: deadPort } });
    expect((await raw(r, connectReq(`${ALLOWED}:443`))).status).toBe(502);
  });
});

describe("egress proxy: allowlist configuration", () => {
  it("accepts exact hostname:443 entries, lowercased", () => {
    expect([...parseAllowlist(["API.Anthropic.com:443", " registry.npmjs.org:443 "])]).toEqual(["api.anthropic.com:443", "registry.npmjs.org:443"]);
  });
  it.each(["*.anthropic.com:443", ".anthropic.com:443", "anthropic.com", "api.anthropic.com:80", "api.anthropic.com:8443", "1.1.1.1:443", "[::1]:443", "localhost:443", "a b.com:443", "api.anthropic.com.:443", "http://api.anthropic.com:443", "user@api.anthropic.com:443", ""])(
    "rejects %j at startup",
    (entry) => {
      expect(() => parseAllowlist([entry])).toThrow(/allowlist/);
    },
  );
  it("rejects an empty allowlist", () => {
    expect(() => parseAllowlist([])).toThrow(/empty/);
  });
});

describe("egress proxy: limits (bounded buffers, connections and time)", () => {
  it("answers 431 and stops reading when the head exceeds the cap without ending", async () => {
    const r = await rig({ maxHeaderBytes: 1024 });
    const res = await raw(r, `CONNECT ${ALLOWED}:443 HTTP/1.1\r\nX-Pad: ${"a".repeat(5000)}`);
    expect(res.status).toBe(431);
    expect(r.logs.some((l) => l.includes(`"reason":"header-too-large"`))).toBe(true);
    expect(r.upstreamConnections()).toBe(0);
  });

  it("answers 431 for a complete head that is over the cap, even when the target is allowed", async () => {
    const r = await rig({ maxHeaderBytes: 256 });
    const res = await raw(r, connectReq(`${ALLOWED}:443`, `X-Pad: ${"a".repeat(400)}\r\n`));
    expect(res.status).toBe(431);
    expect(r.upstreamConnections()).toBe(0);
  });

  it("closes a client that never finishes its head (408), however slowly it dribbles", async () => {
    const r = await rig({ headerTimeoutMs: 150 });
    const c = connectClient(r.proxy.port);
    c.sock.write("CONNECT ");
    const dribble = setInterval(() => c.sock.write("a"), 40);
    cleanups.push(() => clearInterval(dribble));
    await c.closed;
    expect(c.received()).toMatch(/^HTTP\/1\.1 408 /);
    expect(r.logs.some((l) => l.includes(`"reason":"header-timeout"`))).toBe(true);
  });

  it("closes a client that connects and sends nothing", async () => {
    const r = await rig({ headerTimeoutMs: 100 });
    const c = connectClient(r.proxy.port);
    await c.closed;
    expect(r.upstreamConnections()).toBe(0);
  });

  it("releases every refused connection even though the client never reads or closes its side", async () => {
    const r = await rig({ maxConnections: 100 });
    const clients = ["GET / HTTP/1.1\r\n\r\n", connectReq("example.com:443"), connectReq("1.1.1.1:443")].map((req) => {
      const c = connectClient(r.proxy.port);
      c.sock.pause();
      c.sock.write(req);
      return c;
    });
    expect(clients).toHaveLength(3);
    const deadline = Date.now() + 4000;
    while (r.proxy.activeConnections() > 0 && Date.now() < deadline) await new Promise((ok) => setTimeout(ok, 25));
    expect(r.proxy.activeConnections()).toBe(0);
  });

  it("closes an idle tunnel", async () => {
    const r = await rig({ idleTimeoutMs: 150 });
    const c = connectClient(r.proxy.port);
    c.sock.write(connectReq(`${ALLOWED}:443`));
    await c.until((s) => s.includes("\r\n\r\n"));
    await c.closed;
    expect(r.logs.some((l) => l.includes(`"reason":"idle-timeout"`))).toBe(true);
  });

  it("refuses connections beyond maxConnections with 503 and recovers when one closes", async () => {
    const r = await rig({ maxConnections: 2 });
    const a = connectClient(r.proxy.port);
    const b = connectClient(r.proxy.port);
    a.sock.write(connectReq(`${ALLOWED}:443`));
    b.sock.write(connectReq(`${ALLOWED}:443`));
    await a.until((s) => s.includes("\r\n\r\n"));
    await b.until((s) => s.includes("\r\n\r\n"));
    expect((await raw(r, connectReq(`${ALLOWED}:443`))).status).toBe(503);
    expect(r.upstreamConnections()).toBe(2);
    a.sock.destroy();
    await a.closed;
    await new Promise((ok) => setTimeout(ok, 50));
    const d = connectClient(r.proxy.port);
    d.sock.write(connectReq(`${ALLOWED}:443`));
    await d.until((s) => s.includes("\r\n\r\n"));
    expect(d.received()).toMatch(/^HTTP\/1\.1 200 /);
  });

  it("does not open an upstream connection when the client hangs up while the name is resolving", async () => {
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const r = await rig({ testOverrides: { resolve: async () => (await gate, ["127.0.0.1"]), allowPrivateAddresses: true } });
    const c = connectClient(r.proxy.port);
    c.sock.write(connectReq(`${ALLOWED}:443`));
    await new Promise((ok) => setTimeout(ok, 50));
    c.sock.destroy();
    await c.closed;
    release();
    await new Promise((ok) => setTimeout(ok, 100));
    expect(r.upstreamConnections()).toBe(0);
  });

  it("gives up on a resolver that never answers (502 within the connect timeout)", async () => {
    const r = await rig({ connectTimeoutMs: 100, testOverrides: { resolve: () => new Promise(() => {}), allowPrivateAddresses: true } });
    expect((await raw(r, connectReq(`${ALLOWED}:443`))).status).toBe(502);
  });

  it("closes the client when the upstream closes, and the upstream when the client closes", async () => {
    const r = await rig();
    const c = connectClient(r.proxy.port);
    c.sock.write(connectReq(`${ALLOWED}:443`));
    await c.until((s) => s.includes("\r\n\r\n"));
    c.sock.end();
    await c.closed;
  });

  it("close() tears down live tunnels and stops listening", async () => {
    const r = await rig();
    const c = connectClient(r.proxy.port);
    c.sock.write(connectReq(`${ALLOWED}:443`));
    await c.until((s) => s.includes("\r\n\r\n"));
    await r.proxy.close();
    await c.closed;
    await expect(new Promise((ok, no) => net.connect(r.proxy.port, "127.0.0.1").once("connect", ok).once("error", no))).rejects.toBeTruthy();
  });

  it("a tunnel streams more than any buffer cap (no whole-body buffering)", async () => {
    const r = await rig({ maxHeaderBytes: 512 });
    const c = connectClient(r.proxy.port);
    c.sock.write(connectReq(`${ALLOWED}:443`));
    await c.until((s) => s.includes("\r\n\r\n"));
    const big = "x".repeat(200_000);
    c.sock.write(big);
    await c.until((s) => s.replaceAll("echo:", "").length >= 200_000 + 39);
    expect(c.received().replaceAll("echo:", "").endsWith(big)).toBe(true);
  });
});
