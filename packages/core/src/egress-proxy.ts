import dns from "node:dns";
import net from "node:net";

/**
 * Egress allowlist proxy (containment design section 5.2, ticket 14).
 *
 * Runs in a sidecar container next to a Build container that has no route out. It speaks only
 * HTTP CONNECT, to an exact allowlist of `host:443` entries, and tunnels bytes without
 * terminating TLS. Everything else is refused and logged. The Build agent is untrusted
 * (CODING_STANDARDS #13): every byte a client sends is attacker-controlled input.
 *
 * Policy, in order, for each connection:
 *  1. Read the request head with a size cap and a wall-clock deadline.
 *  2. The request line must be exactly `CONNECT <host>:<port> HTTP/1.0|1.1`. Any other method,
 *     an absolute URI, an origin-form path or a malformed line is refused (no plain HTTP).
 *  3. The target must be a bare lowercase-able hostname plus port. IP literals, userinfo, brackets,
 *     trailing dots and anything not matching the allowlist entry exactly are refused. Only the
 *     request target is consulted: the Host header and every other header are ignored.
 *  4. Only after the allowlist match is the name resolved (so non-allowlisted names never reach
 *     DNS), every answer must be a public unicast address, and the proxy connects to one of those
 *     very addresses by IP (no second lookup, so no check-then-resolve gap).
 */

const DEFAULTS = {
  maxConnections: 64,
  maxHeaderBytes: 8192,
  headerTimeoutMs: 10_000,
  connectTimeoutMs: 10_000,
  idleTimeoutMs: 120_000,
} as const;
/** Fallback addresses tried per CONNECT, each with its own deadline, so the worst case stays bounded. */
const MAX_DIAL_ADDRESSES = 4;

export interface EgressProxyOptions {
  /** Exact `host:443` entries. No wildcards, no suffixes, no IP literals. */
  allow: string[];
  /** Listen address. Default 0.0.0.0 (the sidecar's internal-network interface). */
  host?: string;
  /** Listen port. Default 3128. 0 picks a free port. */
  port?: number;
  /** One line per event, written to stdout by default. Lines are JSON, so attacker text cannot forge entries. */
  log?: (line: string) => void;
  maxConnections?: number;
  maxHeaderBytes?: number;
  headerTimeoutMs?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  /**
   * Test seams. Fail-open if reachable, so startEgressProxy throws when this is set outside vitest
   * (VITEST unset). The environment entry never passes it.
   */
  testOverrides?: {
    resolve?: (hostname: string) => Promise<string[]>;
    /** Skip the public-address check so tests can reach a loopback fake upstream. */
    allowPrivateAddresses?: boolean;
    /** Connect here instead of the allowlisted port. */
    upstreamPort?: number;
  };
}

export interface EgressProxy {
  port: number;
  /** Client connections currently open (head being read, resolving, or tunnelling). */
  activeConnections(): number;
  /** Connections turned away because the cap was reached (counted, and answered or dropped at once). */
  refusedConnections(): number;
  close(): Promise<void>;
}

const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** A DNS name made of letter/digit/hyphen labels with at least one dot; never an IP literal, never empty labels. */
function isPlainHostname(h: string): boolean {
  if (h.length === 0 || h.length > 253) return false;
  if (net.isIP(h) !== 0) return false;
  const labels = h.split(".");
  if (labels.length < 2) return false;
  // An all-numeric last label would make this an IPv4 shorthand (e.g. 127.1, 0x7f.1 handled by the label regex).
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return false;
  return labels.every((l) => l.length <= 63 && HOSTNAME_LABEL.test(l));
}

/** Parse and validate the allowlist. Throws on anything that is not an exact `hostname:443`. */
export function parseAllowlist(entries: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase();
    const m = /^([^:]+):443$/.exec(entry);
    if (!m || !isPlainHostname(m[1]!)) throw new Error(`invalid egress allowlist entry ${JSON.stringify(raw)}: want exact hostname:443`);
    out.add(entry);
  }
  if (out.size === 0) throw new Error("egress allowlist is empty");
  return out;
}

const PUBLIC_V6 = new net.BlockList();
PUBLIC_V6.addSubnet("2000::", 3, "ipv6"); // global unicast
const NON_PUBLIC = new net.BlockList();
for (const [addr, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
] as const)
  NON_PUBLIC.addSubnet(addr, bits, "ipv4");
for (const [addr, bits] of [
  ["2001::", 23], // Teredo and IETF protocol assignments
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (embeds an arbitrary IPv4)
] as const)
  NON_PUBLIC.addSubnet(addr, bits, "ipv6");

/** True only for a globally routable unicast address. Everything unrecognised is refused. */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return !NON_PUBLIC.check(ip, "ipv4");
  if (family === 6) return PUBLIC_V6.check(ip, "ipv6") && !NON_PUBLIC.check(ip, "ipv6");
  return false;
}

type Refusal = { status: number; reason: string; target?: string };

interface ParsedTarget {
  host: string;
  key: string;
}

/** Validate the request head. Returns the target to dial or a refusal. Pure so the table of cases stays testable. */
function parseRequestLine(line: string): { target: string } | Refusal {
  if (!/^[\x21-\x7e ]*$/.test(line)) return { status: 400, reason: "malformed-request-line" };
  const parts = line.split(" ");
  if (parts.length !== 3) return { status: 400, reason: "malformed-request-line" };
  const [method, target, version] = parts as [string, string, string];
  if (version !== "HTTP/1.1" && version !== "HTTP/1.0") return { status: 400, reason: "bad-http-version" };
  if (method !== "CONNECT") return { status: 405, reason: "method-not-allowed", target };
  return { target };
}

function parseTarget(target: string): ParsedTarget | Refusal {
  // authority-form only: host ":" port. No scheme, path, userinfo, brackets (IPv6 literals) or extra colons.
  const m = /^([A-Za-z0-9.-]+):([0-9]+)$/.exec(target);
  if (!m) return { status: 403, reason: "bad-target", target };
  const host = m[1]!.toLowerCase();
  if (net.isIP(host) !== 0 || /^[0-9.]+$/.test(host)) return { status: 403, reason: "ip-literal", target };
  return { host, key: `${host}:${m[2]}` };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const limit = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error("timeout")), ms)));
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

function respond(socket: net.Socket, status: number, extra = "") {
  const text = ({ 200: "Connection Established", 400: "Bad Request", 403: "Forbidden", 405: "Method Not Allowed", 408: "Request Timeout", 431: "Request Header Fields Too Large", 502: "Bad Gateway", 503: "Service Unavailable" } as Record<number, string>)[status] ?? "Error";
  socket.end(`HTTP/1.1 ${status} ${text}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`);
  // The socket may be paused: resume it so the peer's FIN is observed and the fd is released, and
  // force-close after a short grace period if the peer never hangs up.
  socket.resume();
  socket.setTimeout(2000, () => socket.destroy());
}

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  if (options.testOverrides && !process.env.VITEST) throw new Error("egress proxy: testOverrides is a test-only seam and is refused outside vitest");
  const allow = parseAllowlist(options.allow);
  const cfg = {
    maxConnections: options.maxConnections ?? DEFAULTS.maxConnections,
    maxHeaderBytes: options.maxHeaderBytes ?? DEFAULTS.maxHeaderBytes,
    headerTimeoutMs: options.headerTimeoutMs ?? DEFAULTS.headerTimeoutMs,
    connectTimeoutMs: options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs,
    idleTimeoutMs: options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
  };
  const log = options.log ?? ((l: string) => console.log(l));
  const emit = (event: string, fields: Record<string, unknown> = {}) => log(JSON.stringify({ event, ...fields }));
  const over = options.testOverrides ?? {};
  const resolve =
    over.resolve ??
    (async (hostname: string) => {
      const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
      // IPv4 first: the sidecar's pasta egress is not guaranteed to carry IPv6.
      return answers.sort((a, b) => a.family - b.family).map((a) => a.address);
    });

  const open = new Set<net.Socket>();
  let active = 0;
  let refused = 0;
  /** Over-cap sockets still being answered. Bounded so a flood cannot hold unbounded file descriptors. */
  let refusing = 0;

  const deny = (client: net.Socket, r: Refusal, method?: string) => {
    emit("denied", { reason: r.reason, status: r.status, ...(method ? { method } : {}), ...(r.target !== undefined ? { target: r.target.slice(0, 120) } : {}) });
    respond(client, r.status, r.status === 405 ? "Allow: CONNECT\r\n" : "");
  };

  // allowHalfOpen on purpose: a TLS client may send its last bytes and FIN while the reply is still
  // in flight, and auto-closing on that FIN would truncate the reply. Idle and header timeouts bound it.
  const server = net.createServer({ pauseOnConnect: false, allowHalfOpen: true }, (client) => {
    if (active >= cfg.maxConnections) {
      refused++;
      client.on("error", () => {});
      if (refusing >= cfg.maxConnections) {
        // Past the bound: no answer, release the fd now. The first refusal of a burst is logged.
        client.destroy();
        return;
      }
      refusing++;
      client.once("close", () => refusing--);
      emit("denied", { reason: "too-many-connections", status: 503 });
      respond(client, 503);
      return;
    }
    active++;
    open.add(client);
    client.on("close", () => {
      active--;
      open.delete(client);
    });
    client.on("error", () => {});
    handle(client);
  });

  function handle(client: net.Socket) {
    let head = Buffer.alloc(0);
    let handled = false;
    const headerTimer = setTimeout(() => {
      if (handled) return;
      handled = true;
      client.removeListener("data", onData);
      deny(client, { status: 408, reason: "header-timeout" });
    }, cfg.headerTimeoutMs);
    client.once("close", () => clearTimeout(headerTimer));

    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      // The cap applies to the head only; bytes pipelined after it are bounded by one socket read.
      if ((end === -1 ? head.length : end + 4) > cfg.maxHeaderBytes) {
        handled = true;
        clearTimeout(headerTimer);
        client.removeListener("data", onData);
        deny(client, { status: 431, reason: "header-too-large" });
        return;
      }
      if (end === -1) return;
      handled = true;
      clearTimeout(headerTimer);
      client.removeListener("data", onData);
      client.pause();
      void route(client, head.subarray(0, end).toString("latin1"), head.subarray(end + 4));
    };
    client.on("data", onData);
    // A FIN before the head is complete can never become a request; once the head is in, a half-close is legitimate.
    client.once("end", () => {
      if (!handled) client.destroy();
    });
  }

  async function route(client: net.Socket, headText: string, leftover: Buffer) {
    const requestLine = headText.split("\r\n", 1)[0] ?? "";
    const method = requestLine.split(" ", 1)[0]?.slice(0, 16);
    const line = parseRequestLine(requestLine);
    if ("status" in line) return deny(client, line, method);
    const parsed = parseTarget(line.target);
    if ("status" in parsed) return deny(client, parsed, "CONNECT");
    if (!allow.has(parsed.key)) {
      const port = parsed.key.slice(parsed.host.length + 1);
      return deny(client, { status: 403, reason: port !== "443" ? "port-not-allowed" : "host-not-allowed", target: line.target }, "CONNECT");
    }

    let addresses: string[];
    try {
      addresses = await withTimeout(resolve(parsed.host), cfg.connectTimeoutMs);
    } catch {
      emit("denied", { reason: "resolve-failed", status: 502, target: parsed.key });
      return respond(client, 502);
    }
    if (client.destroyed) return;
    if (addresses.length === 0) {
      emit("denied", { reason: "resolve-failed", status: 502, target: parsed.key });
      return respond(client, 502);
    }
    // Refuse the whole name if any answer is non-public: a mixed answer is a rebinding signal.
    if (!over.allowPrivateAddresses && !addresses.every(isPublicAddress)) {
      emit("denied", { reason: "private-address", status: 403, target: parsed.key });
      return respond(client, 403);
    }

    const upstream = await dialAny(addresses, over.upstreamPort ?? 443, cfg.connectTimeoutMs, client);
    if (!upstream) {
      if (!client.destroyed) {
        emit("denied", { reason: "upstream-unreachable", status: 502, target: parsed.key });
        respond(client, 502);
      }
      return;
    }
    if (client.destroyed) {
      upstream.destroy();
      return;
    }

    emit("allowed", { target: parsed.key, address: upstream.remoteAddress });
    open.add(upstream);
    upstream.on("close", () => open.delete(upstream));
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    const onIdle = () => {
      emit("closed", { reason: "idle-timeout", target: parsed.key });
      client.destroy();
      upstream.destroy();
    };
    client.setTimeout(cfg.idleTimeoutMs, onIdle);
    upstream.setTimeout(cfg.idleTimeoutMs, onIdle);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (leftover.length > 0) upstream.write(leftover);
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  }

  /** Try each validated address in order, by IP, each with its own deadline. Aborts if the client goes away. */
  function dialAny(addresses: string[], port: number, timeoutMs: number, client: net.Socket): Promise<net.Socket | null> {
    return new Promise((done) => {
      let current: net.Socket | undefined;
      let timer: NodeJS.Timeout | undefined;
      let finished = false;
      const finish = (s: net.Socket | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        client.removeListener("close", onClientGone);
        if (!s) current?.destroy();
        done(s);
      };
      const onClientGone = () => finish(null);
      client.once("close", onClientGone);
      const tryNext = (i: number) => {
        if (finished) return;
        if (i >= Math.min(addresses.length, MAX_DIAL_ADDRESSES)) return finish(null);
        const s = net.connect({ host: addresses[i]!, port, allowHalfOpen: true });
        current = s;
        let moved = false;
        const next = () => {
          if (moved || finished) return;
          moved = true;
          clearTimeout(timer);
          s.destroy();
          tryNext(i + 1);
        };
        timer = setTimeout(next, timeoutMs);
        s.once("connect", () => {
          if (!moved) finish(s);
        });
        s.once("error", next);
      };
      tryNext(0);
    });
  }

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(options.port ?? 3128, options.host ?? "0.0.0.0", () => {
      server.off("error", fail);
      ok();
    });
  });
  // After listen an error would otherwise be an unhandled 'error' event; log it (the proxy fails closed).
  server.on("error", (err) => emit("server-error", { message: err.message.slice(0, 200) }));
  const port = (server.address() as net.AddressInfo).port;
  emit("listening", { port, allow: [...allow] });

  return {
    port,
    activeConnections: () => active,
    refusedConnections: () => refused,
    close: () =>
      new Promise<void>((ok) => {
        for (const s of open) s.destroy();
        server.close(() => ok());
      }),
  };
}
