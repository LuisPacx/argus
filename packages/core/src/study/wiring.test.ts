import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import { PumpPortalSource, type SocketLike } from "../sources/pumpportal.ts";
import { captureDueSnapshots } from "./capture.ts";
import type { Resolver, Transport, TransportResponse } from "./guarded-fetch.ts";

type Frame = { received: string; payload: Record<string, unknown> };
const sample = JSON.parse(readFileSync(new URL("../fixtures/pumpportal-stream-sample.json", import.meta.url), "utf8")) as Frame[];

const reply = (status: number, headers: Record<string, string>, body: string): TransportResponse => ({ status, headers, body: (async function* () { yield Buffer.from(body); })(), destroy: () => {} });
const PAGE = `<html><head><title>Site</title></head><body><p>${"A real page with real words on it. ".repeat(5)}</p></body></html>`;

/** The worker's wiring, offline: the recorded 9-minute PumpPortal stream replayed into the Source, which feeds the Study store as in main.ts. */
describe("PumpPortal stream -> Study store -> capture job (recorded fixtures, no network)", () => {
  it("counts seen, out of scope and missed from the recorded stream, then captures at the fixed age", async () => {
    const store = Datastore.open(":memory:");
    let clock = Date.parse(sample[0]!.received);
    let ws!: SocketLike;
    const source = new PumpPortalSource({
      createSocket: () => (ws = { onopen: null, onmessage: null, onclose: null, onerror: null, send: () => {}, close: () => {} }),
      schedule: () => () => {},
      now: () => clock,
      onToken: (e) => store.study.recordTokenEvent(e),
      onConnection: (e) => store.study.recordConnection(e),
    });
    source.start();
    ws.onopen?.({});
    for (const f of sample) {
      clock = Date.parse(f.received);
      ws.onmessage?.({ data: JSON.stringify(f.payload) });
    }

    const creates = sample.filter((f) => f.payload.txType === "create");
    const pumpCreates = creates.filter((f) => f.payload.pool === "pump");
    const migrates = sample.filter((f) => f.payload.txType === "migrate");
    const lastReceived = Date.parse(sample[sample.length - 1]!.received);
    const stats = store.studyStats(new Date(lastReceived));
    expect(stats.seen).toBe(pumpCreates.length);
    expect(stats.outOfScope).toBe(creates.length - pumpCreates.length);
    expect(stats.pending).toBe(pumpCreates.length);
    // a migrate whose create is not in the stream is missed; one whose create is in the stream is not
    const createdMints = new Set(pumpCreates.map((f) => f.payload.mint));
    const missedExpected = migrates.filter((f) => !createdMints.has(f.payload.mint)).length;
    expect(stats.missed).toBe(missedExpected);
    expect(stats.migrations).toBe(migrates.length);
    expect(stats.gapCount).toBe(0);

    // The capture job, a minute after the last create: every uri answers with a document; every other token has a website.
    const uris = new Map(pumpCreates.map((f, i) => [f.payload.uri as string, i]));
    const requests: string[] = [];
    const resolve: Resolver = async () => ["93.184.216.34"];
    const transport: Transport = async (req) => {
      requests.push(req.url.href);
      const i = uris.get(req.url.href);
      if (i !== undefined) return reply(200, { "content-type": "application/json" }, JSON.stringify(i % 3 === 0 ? { name: "x" } : i % 3 === 1 ? { website: `https://site${i}.example` } : { twitter: `https://x.com/user${i}` }));
      if (req.url.pathname === "/robots.txt") return reply(404, {}, "");
      return reply(200, { "content-type": "text/html" }, PAGE);
    };
    // Tokens are due at different times; drain them in 10 s ticks across the window, as the worker does.
    const first = Date.parse(pumpCreates[0]!.received);
    let captured = 0;
    let late = 0;
    for (let t = first + 61_000; t <= lastReceived + 62_000; t += 10_000) {
      const r = await captureDueSnapshots(store.study, { resolve, transport, now: () => new Date(t) });
      captured += r.captured;
      late += r.late;
    }
    const after = store.studyStats(new Date(lastReceived + 120_000));
    expect(late).toBe(0);
    expect(after.pending).toBe(0);
    expect(after.captured + after.counted + after.unreadable).toBe(pumpCreates.length);
    expect(after.captured).toBe(captured);
    expect(after.captured).toBeGreaterThan(0);
    expect(after.counted).toBeGreaterThan(0);
    // every Snapshot was taken at 60 to 120 s of age and carries its hash
    for (const f of pumpCreates) {
      const s = store.study.getSnapshot(f.payload.mint as string);
      if (s) expect(s.ageSec).toBeGreaterThanOrEqual(60);
      if (s) expect(s.ageSec).toBeLessThanOrEqual(120);
    }
    // a missed token has no Snapshot
    for (const f of migrates.filter((m) => !createdMints.has(m.payload.mint))) expect(store.study.getSnapshot(f.payload.mint as string)).toBeUndefined();
    source.close();
  });
});
