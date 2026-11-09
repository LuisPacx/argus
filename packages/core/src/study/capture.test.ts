import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import type { PumpTokenEvent } from "../sources/pumpportal.ts";
import { captureDueSnapshots } from "./capture.ts";
import type { Resolver, Transport, TransportResponse } from "./guarded-fetch.ts";

const T0 = Date.parse("2026-11-08T10:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000);
const PUBLIC = "93.184.216.34";
const mintOf = (n: number) => `Mint${n}`.padEnd(40, "x") + "pump";
const META = (n: number) => `https://ipfs.io/ipfs/meta${n}`;

const create = (n: number, sec = 0, extra: Partial<PumpTokenEvent> = {}): PumpTokenEvent => ({
  kind: "create",
  mint: mintOf(n),
  receivedAt: at(sec).toISOString(),
  signature: "",
  name: `Token ${n}`,
  symbol: `T${n}`,
  creator: "Creator".padEnd(44, "1"),
  uri: META(n),
  pool: "pump",
  ...extra,
});

const reply = (status: number, headers: Record<string, string>, body: string): TransportResponse => ({ status, headers, body: (async function* () { yield Buffer.from(body); })(), destroy: () => {} });
const PAGE = `<html><head><title>Moon Cat</title></head><body><h1>Moon Cat</h1><p>${"The first cat on the moon, funded by memes. ".repeat(4)}</p></body></html>`;

/** The whole internet, as a map from URL to answer; records every request that reaches the wire and every DNS lookup. */
function internet(pages: Record<string, TransportResponse | (() => TransportResponse)>, dns: Record<string, string[]> = {}) {
  const requests: string[] = [];
  const lookups: string[] = [];
  const resolve: Resolver = async (host) => (lookups.push(host), dns[host] ?? [PUBLIC]);
  const transport: Transport = async (req) => {
    requests.push(req.url.href);
    const p = pages[req.url.href];
    return p ? (typeof p === "function" ? p() : p) : reply(404, {}, "");
  };
  return { resolve, transport, requests, lookups };
}
const meta = (o: unknown) => reply(200, { "content-type": "application/json" }, JSON.stringify(o));

function setup(events: PumpTokenEvent[]) {
  const store = Datastore.open(":memory:");
  for (const e of events) store.study.recordTokenEvent(e);
  return store;
}
const run = (store: Datastore, net: ReturnType<typeof internet>, sec: number, extra: Partial<Parameters<typeof captureDueSnapshots>[1]> = {}) =>
  captureDueSnapshots(store.study, { resolve: net.resolve, transport: net.transport, now: () => at(sec), ...extra });

describe("captureDueSnapshots", () => {
  it("captures a token with a website and an X link at its fixed age, with one metadata fetch and one page fetch", async () => {
    const store = setup([create(1)]);
    const net = internet({
      [META(1)]: meta({ description: "<b>The</b> first cat", image: "https://ipfs.io/ipfs/img", website: "https://mooncat.example", twitter: "https://x.com/mooncat", telegram: "https://t.me/mooncat" }),
      "https://mooncat.example/": reply(200, { "content-type": "text/html" }, PAGE),
    });
    const report = await run(store, net, 61);
    expect(report).toMatchObject({ due: 1, captured: 1 });
    expect(net.requests).toEqual([META(1), "https://mooncat.example/robots.txt", "https://mooncat.example/"]);
    const s = store.study.getSnapshot(mintOf(1))!;
    expect(s).toMatchObject({
      captureRuleVersion: 1,
      ageSec: 61,
      capturedAt: at(61).toISOString(),
      selectionReason: "population: website and X links",
      description: "The first cat",
      websiteUrl: "https://mooncat.example/",
      xUrl: "https://x.com/mooncat",
      telegramUrl: "https://t.me/mooncat",
      siteStatus: "ok",
      siteTitle: "Moon Cat",
      siteEmptyShell: false,
    });
    expect(s.siteText).toContain("first cat on the moon");
    expect(store.study.getToken(mintOf(1))).toMatchObject({ status: "captured", inPopulation: true });
  });

  it("a token with an X link only is in the population and gets a Snapshot without a website fetch", async () => {
    const store = setup([create(1)]);
    const net = internet({ [META(1)]: meta({ twitter: "https://twitter.com/mooncat" }) });
    await run(store, net, 61);
    expect(net.requests).toEqual([META(1)]);
    expect(store.study.getSnapshot(mintOf(1))).toMatchObject({ xUrl: "https://x.com/mooncat", siteStatus: "none", selectionReason: "population: X link" });
  });

  it("a token with neither link is counted and not studied: no website fetch, no Snapshot", async () => {
    const store = setup([create(1), create(2)]);
    const net = internet({ [META(1)]: meta({ description: "no links", telegram: "https://t.me/x" }), [META(2)]: meta({}) });
    const report = await run(store, net, 61);
    expect(report).toMatchObject({ due: 2, counted: 2, captured: 0 });
    expect(net.requests).toEqual([META(1), META(2)]);
    expect(store.study.getToken(mintOf(1))).toMatchObject({ status: "counted", statusReason: "no website or X link", inPopulation: false });
    expect(store.study.getSnapshot(mintOf(1))).toBeUndefined();
    expect(store.study.stats(at(70))).toMatchObject({ seen: 2, inPopulation: 0, counted: 2, captured: 0 });
  });

  it("does nothing before the Snapshot age", async () => {
    const store = setup([create(1)]);
    const net = internet({});
    expect(await run(store, net, 59)).toMatchObject({ due: 0 });
    expect(net.requests).toEqual([]);
    expect(store.study.getToken(mintOf(1))?.status).toBe("pending");
  });

  it("writes a Snapshot only once however many times the job runs", async () => {
    const store = setup([create(1)]);
    const net = internet({ [META(1)]: meta({ twitter: "https://x.com/a" }) });
    await run(store, net, 61);
    await run(store, net, 70);
    await run(store, net, 3600);
    expect(net.requests).toEqual([META(1)]);
    expect(store.study.stats(at(4000)).captured).toBe(1);
  });

  it("a create seen too late for the fixed age is marked late and never fetched or captured", async () => {
    const store = setup([create(1)]);
    const net = internet({ [META(1)]: meta({ twitter: "https://x.com/a" }) });
    // the worker was down: the first look at the token is 10 minutes after the create
    const report = await run(store, net, 600);
    expect(report).toMatchObject({ due: 1, late: 1, captured: 0 });
    expect(net.requests).toEqual([]);
    expect(store.study.getToken(mintOf(1))).toMatchObject({ status: "late" });
    expect(store.study.getSnapshot(mintOf(1))).toBeUndefined();
    await run(store, net, 700);
    expect(net.requests).toEqual([]);
  });

  it("a missed create (migrate seen, create never seen) is counted as missed and no Snapshot is ever written at a later age", async () => {
    const store = setup([{ ...create(1), kind: "migrate", receivedAt: at(100).toISOString(), uri: "", pool: "pump-amm", name: "", symbol: "", creator: "" }]);
    const net = internet({ [META(1)]: meta({ website: "https://mooncat.example" }), "https://mooncat.example/": reply(200, { "content-type": "text/html" }, PAGE) });
    for (const sec of [61, 160, 300, 3600, 86_400, 7 * 86_400]) {
      const report = await run(store, net, sec);
      expect(report.due, `at ${sec}`).toBe(0);
    }
    expect(net.requests).toEqual([]);
    expect(net.lookups).toEqual([]);
    expect(store.study.getToken(mintOf(1))?.status).toBe("missed");
    expect(store.study.getSnapshot(mintOf(1))).toBeUndefined();
    expect(store.study.stats(at(7 * 86_400))).toMatchObject({ missed: 1, captured: 0 });
  });

  describe("--dry-run", () => {
    it("fetches nothing and writes nothing, and says what it would have captured", async () => {
      const store = setup([create(1, 0), create(2, 30), create(3, -100)]);
      const net = internet({ [META(1)]: meta({ twitter: "https://x.com/a" }) });
      // token 3 is stale (late) at this time: a dry run must not even mark it
      const report = await run(store, net, 100, { dryRun: true });
      expect(report).toMatchObject({ dryRun: true, due: 3, wouldCapture: 2 });
      expect(net.requests).toEqual([]);
      expect(net.lookups).toEqual([]);
      expect(store.study.captureRunsSince(at(-86_400))).toBe(0);
      for (const n of [1, 2, 3]) expect(store.study.getToken(mintOf(n))).toMatchObject({ status: "pending", metadataAttempts: 0 });
      expect(store.study.getSnapshot(mintOf(1))).toBeUndefined();
    });
    it("counts a token past the window as not capturable", async () => {
      const store = setup([create(1, 0)]);
      expect(await run(store, internet({}), 1000, { dryRun: true })).toMatchObject({ due: 1, wouldCapture: 0 });
      expect(store.study.getToken(mintOf(1))?.status).toBe("pending");
    });
  });

  describe("run cap", () => {
    it("stops at the cap: the rest are marked capped and cost no fetch", async () => {
      const store = setup([create(1), create(2), create(3)]);
      const net = internet({ [META(1)]: meta({ twitter: "https://x.com/a" }), [META(2)]: meta({ twitter: "https://x.com/b" }), [META(3)]: meta({ twitter: "https://x.com/c" }) });
      const report = await run(store, net, 61, { runCap: 2 });
      expect(report).toMatchObject({ captured: 2, capped: 1 });
      expect(net.requests).toEqual([META(1), META(2)]);
      expect(store.study.getToken(mintOf(3))).toMatchObject({ status: "capped" });
      expect(store.study.captureRunsSince(at(-86_400))).toBe(2);
    });
  });

  describe("untrusted URLs", () => {
    it("a metadata uri that points at a private address is never connected to, and the token ends up unreadable", async () => {
      const store = setup([create(1, 0, { uri: "http://169.254.169.254/latest/meta-data/" })]);
      const net = internet({});
      await run(store, net, 61);
      expect(net.requests).toEqual([]);
      expect(store.study.getToken(mintOf(1))).toMatchObject({ status: "unreadable", metadataAttempts: 1 }); // not worth retrying
    });

    it("a website on a private address is recorded as blocked in the Snapshot and never connected to", async () => {
      const store = setup([create(1), create(2)]);
      const net = internet({ [META(1)]: meta({ website: "http://10.0.0.5/admin" }), [META(2)]: meta({ website: "https://rebind.example" }) }, { "rebind.example": ["127.0.0.1"] });
      await run(store, net, 61);
      expect(net.requests).toEqual([META(1), META(2)]);
      expect(store.study.getSnapshot(mintOf(1))).toMatchObject({ siteStatus: "blocked", siteText: "" });
      expect(store.study.getSnapshot(mintOf(2))).toMatchObject({ siteStatus: "blocked", siteText: "" });
    });

    it("a website that robots.txt disallows is recorded and not fetched", async () => {
      const store = setup([create(1)]);
      const net = internet({ [META(1)]: meta({ website: "https://mooncat.example" }), "https://mooncat.example/robots.txt": reply(200, {}, "User-agent: *\nDisallow: /"), "https://mooncat.example/": reply(200, { "content-type": "text/html" }, PAGE) });
      await run(store, net, 61);
      expect(net.requests).toEqual([META(1), "https://mooncat.example/robots.txt"]);
      expect(store.study.getSnapshot(mintOf(1))).toMatchObject({ siteStatus: "robots-disallowed" });
    });

    it("a non-HTML website is recorded with its content type and no text", async () => {
      const store = setup([create(1)]);
      const net = internet({ [META(1)]: meta({ website: "https://mooncat.example/x.pdf" }), "https://mooncat.example/x.pdf": reply(200, { "content-type": "application/pdf" }, "%PDF") });
      await run(store, net, 61);
      expect(store.study.getSnapshot(mintOf(1))).toMatchObject({ siteStatus: "non-html", siteContentType: "application/pdf", siteText: "" });
    });
  });

  describe("metadata that cannot be read", () => {
    it("is retried on the next ticks inside the window, then given up on", async () => {
      const store = setup([create(1)]);
      let calls = 0;
      const net = internet({ [META(1)]: () => (++calls, reply(502, {}, "bad gateway")) });
      await run(store, net, 61);
      expect(store.study.getToken(mintOf(1))).toMatchObject({ status: "pending", metadataAttempts: 1 });
      await run(store, net, 76);
      expect(store.study.getToken(mintOf(1))).toMatchObject({ status: "pending", metadataAttempts: 2 });
      await run(store, net, 91);
      expect(store.study.getToken(mintOf(1))).toMatchObject({ status: "unreadable", metadataAttempts: 3 });
      expect(calls).toBe(3);
    });

    it("succeeds on a retry and the Snapshot records the real (later) age", async () => {
      const store = setup([create(1)]);
      let calls = 0;
      const net = internet({ [META(1)]: () => (++calls === 1 ? reply(502, {}, "") : meta({ twitter: "https://x.com/a" })) });
      await run(store, net, 61);
      await run(store, net, 76);
      expect(store.study.getSnapshot(mintOf(1))).toMatchObject({ ageSec: 76, siteStatus: "none" });
    });
  });

  it("the recorded PumpPortal create fixture flows through: its uri is fetched, nothing else", async () => {
    const create0 = JSON.parse(readFileSync(new URL("../fixtures/pumpportal-create.json", import.meta.url), "utf8")) as Record<string, string>;
    const store = setup([create(1, 0, { mint: create0.mint, uri: create0.uri, creator: create0.traderPublicKey, name: create0.name, symbol: create0.symbol })]);
    const net = internet({ [create0.uri!]: meta({ website: "https://novelty.example", twitter: "https://x.com/vroom" }), "https://novelty.example/": reply(200, { "content-type": "text/html" }, PAGE) });
    await run(store, net, 62);
    expect(net.requests).toEqual([create0.uri, "https://novelty.example/robots.txt", "https://novelty.example/"]);
    expect(store.study.getSnapshot(create0.mint!)).toMatchObject({ name: "No Risk No Rari", symbol: "VROOM", uri: create0.uri });
  });
});
