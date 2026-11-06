import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PumpPortalSource, type SocketLike } from "./pumpportal.ts";

const MOON = `${"MoonCat".padEnd(40, "1")}pump`;
const BOT = `${"RocketBot".padEnd(40, "2")}pump`;
const create = (mint: string, extra: Record<string, unknown> = {}) => JSON.stringify({ txType: "create", mint, name: "Moon Cat", symbol: "MCAT", signature: "sig", ...extra });
const migrate = (mint: string, extra: Record<string, unknown> = {}) => JSON.stringify({ txType: "migrate", mint, pool: "pump-amm", ...extra });

/** A loopback websocket server, just enough of RFC 6455 for text frames. Records what clients send and which sockets are open. */
class LoopbackServer {
  readonly received: string[] = [];
  readonly sockets: Socket[] = [];
  connections = 0;
  private readonly server: Server;

  constructor() {
    this.server = createServer((_req, res) => res.writeHead(426).end());
    this.server.on("upgrade", (req, socket: Socket) => {
      this.connections++;
      this.sockets.push(socket);
      const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.on("data", (buf) => {
        // Client frames are masked and short; several can share one chunk, and each arrives whole in these tests.
        for (let at = 0; at < buf.length; ) {
          const len = buf[at + 1]! & 0x7f;
          const mask = buf.subarray(at + 2, at + 6);
          const payload = Buffer.from(buf.subarray(at + 6, at + 6 + len));
          for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
          if ((buf[at]! & 0x0f) === 1) this.received.push(payload.toString("utf8"));
          if ((buf[at]! & 0x0f) === 8) socket.end(Buffer.from([0x88, 0])); // answer a close with a close, then hang up
          at += 6 + len;
        }
      });
      socket.on("error", () => {});
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  send(socket: Socket, text: string): void {
    const body = Buffer.from(text, "utf8");
    const head = body.length < 126 ? Buffer.from([0x81, body.length]) : body.length < 65536 ? Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]) : Buffer.concat([Buffer.from([0x81, 127]), Buffer.alloc(8)]);
    if (body.length >= 65536) head.writeBigUInt64BE(BigInt(body.length), 2);
    socket.write(Buffer.concat([head, body]));
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

async function until(cond: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A clock that only moves when the test says so. */
function fakeClock() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  return {
    schedule: (fn: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return () => void pending.delete(id);
    },
    waits: () => [...pending.values()].map((p) => p.ms),
    /** Fires every pending timer once. */
    fire: () => {
      const due = [...pending.entries()];
      for (const [id, p] of due) {
        pending.delete(id);
        p.fn();
      }
    },
  };
}

let server: LoopbackServer | undefined;
let source: PumpPortalSource | undefined;
afterEach(async () => {
  source?.close();
  await server?.close();
  source = server = undefined;
});

async function connected(opts: ConstructorParameters<typeof PumpPortalSource>[0] = {}) {
  server = new LoopbackServer();
  const url = await server.listen();
  const clock = fakeClock();
  source = new PumpPortalSource({ url, schedule: clock.schedule, now: () => Date.parse("2026-01-02T03:04:05Z"), ...opts });
  source.start();
  await until(() => server!.sockets.length === 1 && server!.received.length === 2, "the subscription");
  return { server, source, clock, socket: () => server!.sockets[server!.sockets.length - 1]! };
}

describe("PumpPortalSource", () => {
  it("subscribes to new tokens and migrations on connect", async () => {
    const { server } = await connected();
    expect(server.received.map((m) => JSON.parse(m))).toEqual([{ method: "subscribeNewToken" }, { method: "subscribeMigration" }]);
  });

  it("turns launch and bonding events into Signals labelled by the Source, and drains them on poll", async () => {
    const { server, source, socket } = await connected();
    server.send(socket(), create(MOON));
    server.send(socket(), migrate(BOT, { name: "Rocket Bot", symbol: "RBOT" }));
    await until(() => (source as unknown as { buffer: Map<string, unknown> }).buffer.size === 2, "two events");
    const signals = await source.poll();
    expect(signals).toEqual([
      {
        id: `pumpportal:events:create:${MOON}`,
        sourceId: "pumpportal:events",
        sourceLabel: "PumpPortal",
        title: "New token on pump.fun: Moon Cat ($MCAT)",
        summary: `Moon Cat ($MCAT) was just launched on pump.fun. Mint ${MOON}.`,
        url: `https://pump.fun/coin/${MOON}`,
        publishedAt: "2026-01-02T03:04:05.000Z",
      },
      expect.objectContaining({ id: `pumpportal:events:migrate:${BOT}`, title: "Bonded on pump.fun: Rocket Bot ($RBOT)" }),
    ]);
    expect(await source.poll()).toEqual([]);
  });

  it("holds an event delivered twice once, and keeps launch and bonding of one token apart", async () => {
    const { server, source, socket } = await connected();
    for (const m of [create(MOON), create(MOON), migrate(MOON)]) server.send(socket(), m);
    await until(() => (source as unknown as { buffer: Map<string, unknown> }).buffer.size === 2, "events");
    await new Promise((r) => setTimeout(r, 50));
    expect((await source.poll()).map((s) => s.id)).toEqual([`pumpportal:events:create:${MOON}`, `pumpportal:events:migrate:${MOON}`]);
  });

  it("ignores acks, bad JSON, non-objects, unknown events and bad mints, and cleans the text fields", async () => {
    const { server, source, socket } = await connected();
    const junk = [
      JSON.stringify({ message: "Successfully subscribed to keep alive" }),
      "not json",
      "[1,2]",
      "null",
      JSON.stringify({ txType: "buy", mint: MOON }),
      create("short"),
      create(`${MOON.slice(0, 40)}/../x`),
      create(`${MOON.slice(0, 40)}O0Il`),
      JSON.stringify({ txType: "create" }),
      JSON.stringify({ txType: "create", mint: 12 }),
    ];
    for (const m of junk) server.send(socket(), m);
    server.send(socket(), create(BOT, { name: `<b>Bold</b> ${"x".repeat(500)}`, symbol: "<i>S</i>" }));
    await until(() => (source as unknown as { buffer: Map<string, unknown> }).buffer.size === 1, "the one good event");
    const [signal] = await source.poll();
    expect(signal!.id).toBe(`pumpportal:events:create:${BOT}`);
    expect(signal!.title.length).toBeLessThan(160);
    expect(signal!.title).not.toContain("<");
    expect(signal!.title).toContain("($S)");
  });

  it("falls back to a shortened mint when the event has no name", async () => {
    const { server, source, socket } = await connected();
    server.send(socket(), migrate(BOT));
    await until(() => (source as unknown as { buffer: Map<string, unknown> }).buffer.size === 1, "event");
    expect((await source.poll())[0]!.title).toBe("Bonded on pump.fun: Rock...pump");
  });

  it("drops an oversized message and resets the connection", async () => {
    const { server, source, socket, clock } = await connected({ maxMessageChars: 300 });
    server.send(socket(), create(MOON, { name: "a", padding: "p".repeat(400) }));
    await until(() => clock.waits().length === 1, "the retry after the reset");
    expect(await source.poll()).toEqual([]);
  });

  it("keeps only the newest events when more arrive than the buffer holds", async () => {
    const { server, source, socket } = await connected({ maxBuffered: 3 });
    const mints = [1, 2, 3, 4, 5].map((n) => `Mint${n}`.padEnd(40, "z"));
    for (const m of mints) server.send(socket(), create(m));
    await until(() => (source as unknown as { buffer: Map<string, Signal> }).buffer.has(`pumpportal:events:create:${mints[4]}`), "the last event");
    expect((await source.poll()).map((s) => s.id.slice(-40))).toEqual(mints.slice(2));
  });

  it("reconnects after a drop, waiting 1s first, and resubscribes", async () => {
    const { server, source, clock, socket } = await connected();
    socket().destroy();
    await until(() => clock.waits().length === 1, "the retry timer");
    expect(clock.waits()).toEqual([1_000]);
    clock.fire();
    await until(() => server.connections === 2 && server.received.length === 4, "the second connection");
    server.send(socket(), create(MOON));
    await until(() => (source as unknown as { buffer: Map<string, unknown> }).buffer.size === 1, "an event on the new connection");
  });

  it("doubles the wait while the server stays unreachable, up to a cap, and starts over after a message", async () => {
    const clock = fakeClock();
    // A closed port: every attempt fails.
    const closed = new LoopbackServer();
    const url = await closed.listen();
    await closed.close();
    source = new PumpPortalSource({ url, schedule: clock.schedule });
    source.start();
    const seen: number[] = [];
    for (let i = 0; i < 11; i++) {
      await until(() => clock.waits().length === 1, "a retry timer");
      seen.push(clock.waits()[0]!);
      clock.fire();
    }
    expect(seen).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000]);
  }, 20_000);

  it("starts the wait over once a connection has delivered a message", async () => {
    const { server, source, clock, socket } = await connected();
    socket().destroy(); // dropped before saying anything
    await until(() => clock.waits().length === 1, "retry");
    clock.fire();
    await until(() => server.connections === 2, "second connection");
    socket().destroy(); // dropped again without a message: the wait doubles
    await until(() => clock.waits().length === 1, "retry 2");
    expect(clock.waits()).toEqual([2_000]);
    clock.fire();
    await until(() => server.connections === 3, "third connection");
    server.send(socket(), create(MOON));
    await until(() => (source as unknown as { buffer: Map<string, unknown> }).buffer.size === 1, "a message");
    socket().destroy();
    await until(() => clock.waits().length === 1, "retry 3");
    expect(clock.waits()).toEqual([1_000]);
  });

  it("survives a socket that cannot even be created, and retries", async () => {
    const clock = fakeClock();
    let attempts = 0;
    const lines: string[] = [];
    source = new PumpPortalSource({
      schedule: clock.schedule,
      log: (l) => lines.push(l),
      createSocket: (): SocketLike => {
        attempts++;
        throw new Error("bad url");
      },
    });
    source.start();
    expect(clock.waits()).toEqual([1_000]);
    clock.fire();
    expect(attempts).toBe(2);
    expect(lines[0]).toContain("bad url");
    expect(await source.poll()).toEqual([]);
  });

  it("close() ends the connection, cancels a pending retry, and never reconnects", async () => {
    const { server, source, clock } = await connected();
    const sock = server.sockets[0]!;
    const closed = new Promise<void>((resolve) => sock.on("close", () => resolve()));
    source.close();
    await closed;
    expect(clock.waits()).toEqual([]);

    // A retry that is already waiting is cancelled too.
    const clock2 = fakeClock();
    const dead = new PumpPortalSource({ schedule: clock2.schedule, createSocket: () => { throw new Error("x"); } });
    dead.start();
    expect(clock2.waits()).toEqual([1_000]);
    dead.close();
    expect(clock2.waits()).toEqual([]);
    expect(server.connections).toBe(1);
  });
});

type Signal = import("./source.ts").Signal;
