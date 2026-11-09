import { Datastore, type PumpTokenEvent } from "@argus/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/** Endpoint-level test: the real /api/study handler, with only Nitro's auto-imported globals stubbed. */
let store: Datastore;
vi.stubGlobal("defineEventHandler", (f: unknown) => f);
vi.stubGlobal("useStore", () => store);
const study = (await import("../api/study.get.ts")).default as unknown as () => {
  allTime: Record<string, number | null>;
  last24h: Record<string, number | null>;
  rule: Record<string, number>;
};

const mintOf = (n: number) => `Mint${n}`.padEnd(40, "x") + "pump";
const create = (n: number, at: Date): PumpTokenEvent => ({ kind: "create", mint: mintOf(n), receivedAt: at.toISOString(), signature: "", name: `T${n}`, symbol: "T", creator: "", uri: `https://ipfs.io/ipfs/${n}`, pool: "pump" });
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

beforeEach(() => {
  store = Datastore.open(":memory:");
  delete process.env.ARGUS_STUDY_CAPTURES_PER_DAY;
});
afterEach(() => {
  delete process.env.ARGUS_STUDY_CAPTURES_PER_DAY;
});

it("GET /api/study is empty and well-formed before any token is seen", () => {
  const r = study();
  expect(r.allTime).toMatchObject({ seen: 0, inPopulation: 0, captured: 0, missed: 0, emptyShellShare: null, missedShare: null });
  expect(r.rule).toEqual({ version: 1, snapshotAgeSec: 60, xCaptureAgeSec: 300, fastMigrationSec: 60 });
});

it("GET /api/study counts seen, in population, captured, missed and the empty-shell share, all-time and for the last 24 hours", () => {
  // Two tokens a day ago (one captured with a shell), one token and one missed migration now.
  store.study.recordTokenEvent(create(1, hoursAgo(30)));
  store.study.recordTokenEvent(create(2, hoursAgo(30)));
  store.study.recordTokenEvent(create(3, hoursAgo(1)));
  store.study.recordTokenEvent({ ...create(4, hoursAgo(1)), kind: "migrate", uri: "", pool: "pump-amm" });
  const shell = { status: "ok" as const, detail: "", httpStatus: 200, finalUrl: "https://a.example/", contentType: "text/html", title: "", text: "", truncated: false, responseMs: 10, emptyShell: true };
  const base = { description: "", imageUrl: null, websiteUrl: "https://a.example/", xUrl: null, telegramUrl: null, selectionReason: "population: website link" };
  const t1 = Date.parse(hoursAgo(30).toISOString()) + 61_000;
  store.study.recordSnapshot({ mint: mintOf(1), ...base, website: shell }, new Date(t1));
  store.study.recordSnapshot({ mint: mintOf(2), ...base, website: { ...shell, emptyShell: false, text: "words" } }, new Date(t1));
  const r = study();
  expect(r.allTime).toMatchObject({ seen: 3, inPopulation: 2, captured: 2, missed: 1, websiteFetched: 2, emptyShell: 1, emptyShellShare: 0.5, pending: 1 });
  expect(r.last24h).toMatchObject({ seen: 1, inPopulation: 0, captured: 0, missed: 1, emptyShellShare: null });
});

it("GET /api/study reports the capture cap in force, lowered by the environment and never raised", () => {
  process.env.ARGUS_STUDY_CAPTURES_PER_DAY = "40";
  expect(study().allTime.captureRunCap).toBe(40);
  process.env.ARGUS_STUDY_CAPTURES_PER_DAY = "999999999";
  expect(study().allTime.captureRunCap).toBe(20_000);
});
