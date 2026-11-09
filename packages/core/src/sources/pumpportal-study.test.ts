import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PumpPortalSource, type PumpConnectionEvent, type PumpTokenEvent, type SocketLike } from "./pumpportal.ts";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as T;
const CLOCK = Date.parse("2026-11-08T18:00:00.000Z");

/** In-memory sockets: the test plays the server. Counts how many connections were opened. */
function harness(opts: { onToken?: (e: PumpTokenEvent) => void; onConnection?: (e: PumpConnectionEvent) => void } = {}) {
  const sockets: Array<SocketLike & { sent: string[] }> = [];
  const tokens: PumpTokenEvent[] = [];
  const connections: PumpConnectionEvent[] = [];
  let now = CLOCK;
  const source = new PumpPortalSource({
    createSocket: () => {
      const ws: SocketLike & { sent: string[] } = { sent: [], onopen: null, onmessage: null, onclose: null, onerror: null, send: (d) => void ws.sent.push(d), close: () => {} };
      sockets.push(ws);
      return ws;
    },
    schedule: () => () => {},
    now: () => now,
    onToken: opts.onToken ?? ((e) => tokens.push(e)),
    onConnection: opts.onConnection ?? ((e) => connections.push(e)),
  });
  source.start();
  const ws = () => sockets[sockets.length - 1]!;
  return {
    source,
    sockets,
    tokens,
    connections,
    open: () => ws().onopen?.({}),
    send: (payload: unknown) => ws().onmessage?.({ data: typeof payload === "string" ? payload : JSON.stringify(payload) }),
    advance: (ms: number) => void (now += ms),
    drop: () => ws().onclose?.({}),
  };
}

describe("PumpPortalSource keeps what the Study needs (ticket 02)", () => {
  it("passes a pump create on with its uri, creator, signature, pool and receipt time", () => {
    const h = harness();
    h.open();
    h.send(fixture("pumpportal-create.json"));
    expect(h.tokens).toEqual([
      {
        kind: "create",
        mint: "6oKJ4MAKt3tWh6ru374ctrBMxPaMQ2qLTEGCDDNqpump",
        receivedAt: "2026-11-08T18:00:00.000Z",
        signature: "2k1xSBXHeiGXy5eQkyaWjDh8tk6CayKmZHus2X2JEv24WEYEASBLsNi2eFMbDuTn2VVWqBHkeatx69tGhgiuTHzo",
        name: "No Risk No Rari",
        symbol: "VROOM",
        creator: "FFS4aboq5WB4H8QFjzbtiwXXQgWWWAsw1YmzNUbdYZdb",
        uri: "https://ipfs.io/ipfs/bafkreictddc23key7yw5gps2prjn7tuuckwokbnjzx7qwflelxcypnomz4",
        pool: "pump",
      },
    ]);
  });

  it("keeps a bonk create without a uri, and a migrate with its pool", () => {
    const h = harness();
    h.open();
    h.send(fixture("pumpportal-create-bonk.json"));
    h.send(fixture("pumpportal-migrate.json"));
    expect(h.tokens).toMatchObject([
      { kind: "create", mint: "9GUEk6JMedHNqDdDxvwaT5qrBHCov6AN8QJf9vbfLoat", pool: "bonk", uri: "", creator: "A3hf5GWM8dLSL6Qbn2VNCUkPxT5Z6A21zKeYko6GNp9r" },
      { kind: "migrate", mint: "7rfDWhuPCB48jXP4M5ZCfEC5mvDhMEUs5qSVqJggpump", pool: "pump-amm", uri: "" },
    ]);
  });

  it("replays the recorded 9-minute stream on one connection: every create and migrate, and the uri of every pump create", () => {
    const sample = fixture<Array<{ received: string; payload: Record<string, unknown> }>>("pumpportal-stream-sample.json");
    const h = harness();
    h.open();
    for (const m of sample) h.send(m.payload);
    const creates = sample.filter((m) => m.payload.txType === "create");
    const migrates = sample.filter((m) => m.payload.txType === "migrate");
    expect(h.tokens.filter((t) => t.kind === "create")).toHaveLength(creates.length);
    expect(h.tokens.filter((t) => t.kind === "migrate")).toHaveLength(migrates.length);
    const pump = h.tokens.filter((t) => t.kind === "create" && t.pool === "pump");
    expect(pump.length).toBeGreaterThan(60);
    expect(pump.every((t) => t.uri.startsWith("https://") && t.creator !== "")).toBe(true);
    expect(h.sockets).toHaveLength(1); // still the one PumpPortal connection
  });

  it("still opens exactly one connection and subscribes once to each stream", () => {
    const h = harness();
    h.open();
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0]!.sent.map((s) => JSON.parse(s))).toEqual([{ method: "subscribeNewToken" }, { method: "subscribeMigration" }]);
  });

  it("sanitises the fields: a uri that is not http(s) is dropped, markup is stripped, a creator that is not an address is dropped", () => {
    const h = harness();
    h.open();
    const base = { ...fixture<Record<string, unknown>>("pumpportal-create.json") };
    h.send({ ...base, mint: "A".repeat(40) + "pump", uri: "javascript:alert(1)", name: "<b>Bold</b>", traderPublicKey: "<script>", signature: "nope", pool: "<i>pump</i>" });
    expect(h.tokens[0]).toMatchObject({ uri: "", name: "Bold", creator: "", signature: "", pool: "pump" });
  });

  it("does not report acks, junk or unknown events", () => {
    const h = harness();
    h.open();
    h.send({ message: "Successfully subscribed to token creation events." });
    h.send("not json");
    h.send({ txType: "buy", mint: "A".repeat(44) });
    expect(h.tokens).toEqual([]);
  });

  it("a throwing listener does not stop the Signal buffer", async () => {
    const h = harness({
      onToken: () => {
        throw new Error("db is locked");
      },
    });
    h.open();
    h.send(fixture("pumpportal-create.json"));
    expect(await h.source.poll()).toHaveLength(1);
  });

  it("reports the connection going up, down and up again, and down on close()", () => {
    const h = harness();
    h.open();
    h.advance(5_000);
    h.drop();
    h.advance(1_000);
    // the retry timer is a no-op in this harness, so reconnect by hand
    (h.source as unknown as { connect(): void }).connect();
    h.open();
    h.advance(10_000);
    h.source.close();
    expect(h.connections).toEqual([
      { state: "up", at: "2026-11-08T18:00:00.000Z" },
      { state: "down", at: "2026-11-08T18:00:05.000Z" },
      { state: "up", at: "2026-11-08T18:00:06.000Z" },
      { state: "down", at: "2026-11-08T18:00:16.000Z" },
    ]);
  });

  it("does not report a down for a connection that never came up", () => {
    const h = harness();
    h.drop();
    expect(h.connections).toEqual([]);
  });
});
