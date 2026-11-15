import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import { META_RULE } from "./config.ts";
import { hotEvents, raiseHotMetas, raiseHotMetasSafely } from "./hot.ts";
import { hotNowResponse, liveHot } from "./hot-api.ts";
import type { MetaCoverage } from "./coverage.ts";
import type { NewMetaRow, NewMetaRun } from "./store.ts";

const T0 = Date.parse("2026-11-12T00:00:00.000Z");
const at = (minutes: number) => T0 + minutes * 60_000;
const HOUR = 60;

const counts = (creators: number) => ({ tokens: creators * 2, creators, migrations: 3, migrationsAfter60s: 1 });
const row = (key: string, creators: number): NewMetaRow => ({
  key,
  label: key,
  firstSeenAt: "2026-11-11T10:00:00.000Z",
  counts: { "6h": counts(Math.ceil(creators / 2)), "24h": counts(creators) },
  topTokens: [{ mint: `${key}Mint`, name: key, symbol: key.toUpperCase() }],
});

const FULL: MetaCoverage = { "6h": { covered: 6, of: 6 }, "24h": { covered: 24, of: 24 } };
const THIN: MetaCoverage = { "6h": { covered: 1, of: 6 }, "24h": { covered: 3, of: 24 } };

/** A run whose 24 h ranking is `ranking` (best first, `[key, creators]`). */
const run = (atMs: number, ranking: Array<[string, number]>, coverage: MetaCoverage | null = FULL): NewMetaRun => ({
  computedAt: new Date(atMs).toISOString(),
  note: "n",
  rule: META_RULE,
  dexCalls: 0,
  dexFailures: 0,
  base: { "6h": { tokens: 100, migrations: 5 }, "24h": { tokens: 400, migrations: 20 } },
  rows: { "6h": [], "24h": ranking.map(([k, c]) => row(k, c)) },
  ...(coverage !== null ? { coverage } : {}),
});

/** `n` filler Metas with many creators, so a Meta placed after them has rank n + 1. */
const filler = (n: number): Array<[string, number]> => Array.from({ length: n }, (_, i) => [`filler${i}`, 500 - i]);

/** The same ten fillers always, with `x` inserted so that it holds `rank`: moving `x` never makes a filler enter the top 5 that was not there. */
const placed = (rank: number, creators = 60): Array<[string, number]> => {
  const list = filler(10);
  list.splice(rank - 1, 0, ["x", creators]);
  return list;
};

function store(runs: NewMetaRun[]): Datastore {
  const s = Datastore.open(":memory:");
  for (const r of runs) s.meta.saveRun(r);
  return s;
}

/** The events `raiseHotMetas` stores for the newest of `runs`. */
const raised = (runs: NewMetaRun[]) => raiseHotMetas(store(runs)).map((e) => ({ key: e.key, reason: e.reason, rank: e.rank }));

describe("hotEvents: the trigger", () => {
  it("rank 9 to rank 4 raises 'entered top 5'", () => {
    const before = run(at(0), [...filler(8), ["x", 60]]); // rank 9
    const now = run(at(HOUR), [...filler(3), ["x", 60]]); // rank 4
    expect(raised([before, now])).toEqual([{ key: "x", reason: "entered top 5", rank: 4 }]);
  });

  it("rank 2 to rank 3 does not (it was already in the top 5)", () => {
    expect(raised([run(at(0), placed(2)), run(at(HOUR), placed(3))])).toEqual([]);
    expect(raised([run(at(0), placed(5)), run(at(HOUR), placed(1))])).toEqual([]);
  });

  it("a Meta absent an hour ago (new, or below the size floor) that is in the top 5 now raised", () => {
    expect(raised([run(at(0), filler(6)), run(at(HOUR), [...filler(2), ["fresh", 40]])]).map((e) => e.key)).toEqual(["fresh"]);
  });

  it("creators 40 to 90 inside an hour raises; 40 to 70 does not", () => {
    const before = run(at(0), [...filler(6), ["x", 40]]); // rank 7 and stays below the top 5
    expect(raised([before, run(at(HOUR), [...filler(6), ["x", 90]])])).toEqual([{ key: "x", reason: "creators 40 to 90 in 1 h", rank: 7 }]);
    expect(raised([before, run(at(HOUR), [...filler(6), ["x", 70]])])).toEqual([]);
    expect(raised([before, run(at(HOUR), [...filler(6), ["x", 80]])]).map((e) => e.key)).toEqual(["x"]); // exactly double
  });

  it("creators x2 fires only for a Meta at rank 10 or better now: rank 10 fires, rank 11 and rank 40 do not", () => {
    const b = (rank: number) => run(at(0), placed(rank, 40)); // 40 creators an hour ago, same rank
    expect(raised([b(10), run(at(HOUR), placed(10, 90))])).toEqual([{ key: "x", reason: "creators 40 to 90 in 1 h", rank: 10 }]);
    expect(raised([b(11), run(at(HOUR), placed(11, 90))])).toEqual([]);
    const deep = (creators: number) => [...filler(39), ["x", creators] as [string, number]];
    expect(raised([run(at(0), deep(3)), run(at(HOUR), deep(6))])).toEqual([]); // rank 40, 3 to 6
  });

  it("both reasons are written when both hold", () => {
    const before = run(at(0), [...filler(8), ["x", 40]]);
    const now = run(at(HOUR), [...filler(2), ["x", 90]]);
    expect(raised([before, now])).toEqual([{ key: "x", reason: "entered top 5; creators 40 to 90 in 1 h", rank: 3 }]);
  });

  it("compares with the newest run at least an hour older, not with the previous 15-minute run", () => {
    const old = run(at(0), [...filler(8), ["x", 40]]);
    const recent = run(at(50), [...filler(3), ["x", 50]]); // 10 minutes before the check: not a baseline
    const now = run(at(60), [...filler(3), ["x", 52]]);
    expect(raised([old, recent, now]).map((e) => e.key)).toEqual(["x"]);
  });

  it("a baseline too old for 'within 1 h' skips the creators rule, and the rank rule still runs", () => {
    const old = run(at(0), [...filler(8), ["x", 40]]);
    expect(raised([old, run(at(5 * HOUR), [...filler(8), ["x", 100]])])).toEqual([]);
    expect(raised([old, run(at(5 * HOUR), [...filler(2), ["x", 100]])])).toEqual([{ key: "x", reason: "entered top 5", rank: 3 }]);
  });

  it("raises nothing on the first run: with no earlier run there is nothing to compare", () => {
    expect(raised([run(at(HOUR), [...filler(2), ["x", 90]])])).toEqual([]);
    expect(raised([run(at(0), filler(2)), run(at(20), [...filler(2), ["x", 90]])])).toEqual([]); // the only older run is under an hour old
  });

  it("the thresholds come from the config object", () => {
    const s = store([run(at(0), [["a", 10], ["b", 10], ["x", 8]]), run(at(HOUR), [["a", 10], ["b", 10], ["x", 12]])]);
    const now = s.latestMetas("24h", 10)!;
    const prev = s.meta.latest("24h", 10, new Date(at(0)).toISOString())!;
    expect(hotEvents(now, prev, { ...META_RULE, hotTopRank: 2 }).map((e) => e.reason)).toEqual([]);
    expect(hotEvents(now, prev, { ...META_RULE, hotTopRank: 2, hotCreatorFactor: 1.5 }).map((e) => e.reason)).toEqual(["creators 8 to 12 in 1 h"]);
  });
});

describe("coverage: no Hot now from a thin window", () => {
  const before = run(at(0), [...filler(8), ["x", 60]]);
  const now = run(at(HOUR), [...filler(3), ["x", 60]]);

  it("a thinly covered 24 h window, in either run, raises nothing, however the ranking moved", () => {
    expect(raised([run(at(0), [...filler(8), ["x", 60]], THIN), now])).toEqual([]);
    expect(raised([before, run(at(HOUR), [...filler(3), ["x", 60]], THIN)])).toEqual([]);
  });

  it("a run from before coverage was stored (unknown) is trusted", () => {
    expect(raised([run(at(0), [...filler(8), ["x", 60]], null), run(at(HOUR), [...filler(3), ["x", 60]], null)]).map((e) => e.key)).toEqual(["x"]);
  });

  it("the same ranking move with full coverage raises", () => {
    expect(raised([before, now]).map((e) => e.key)).toEqual(["x"]);
  });
});

describe("raiseHotMetas: stored events and the cool-down", () => {
  it("stores one event per Meta per trigger and does not raise the same Meta twice inside the cool-down", () => {
    const s = store([run(at(0), placed(9)), run(at(HOUR), placed(4))]);
    const xEvents = () => raiseHotMetas(s).filter((e) => e.key === "x"); // a filler pushed into the top 5 by x's moves is a Meta of its own
    expect(xEvents()).toHaveLength(1); // the event, at minute 60
    expect(xEvents()).toHaveLength(0); // the same run checked twice
    // The Meta drops out of the top 5 and re-enters: a trigger each time, but not inside 6 h of the event.
    s.meta.saveRun(run(at(300), placed(9)));
    expect(xEvents()).toHaveLength(0);
    s.meta.saveRun(run(at(419), placed(4))); // enters again, 359 minutes after the event
    expect(xEvents()).toHaveLength(0);
    s.meta.saveRun(run(at(421), placed(9)));
    expect(xEvents()).toHaveLength(0);
    s.meta.saveRun(run(at(482), placed(4))); // 422 minutes after the event: past the cool-down
    expect(xEvents()).toHaveLength(1);
    expect(s.hotMetaEvents(new Date(at(0)).toISOString()).filter((e) => e.key === "x").map((e) => e.raisedAt)).toEqual([new Date(at(482)).toISOString(), new Date(at(60)).toISOString()]);
  });

  it("reads back what was stored: key, label, when, why, rank, creators and the run", () => {
    const s = store([run(at(0), [...filler(8), ["x", 60]]), run(at(HOUR), [...filler(3), ["x", 60]])]);
    raiseHotMetas(s);
    const [e] = s.hotMetaEvents(new Date(at(0)).toISOString());
    expect(e).toMatchObject({ key: "x", label: "x", raisedAt: new Date(at(HOUR)).toISOString(), reason: "entered top 5", rank: 4, creators: 60 });
    expect(e!.runId).toBe(s.latestMetas("24h", 1)!.id);
  });

  it("is context only: no Narrative, Proposal or Score is created (ADR 0012)", () => {
    const s = store([run(at(0), [...filler(8), ["x", 60]]), run(at(HOUR), [...filler(3), ["x", 60]])]);
    const snapshot = () => JSON.stringify([s.listNarratives(), s.listProposals(), s.queryNarratives({})]);
    const before = snapshot();
    expect(raiseHotMetas(s)).toHaveLength(1);
    expect(snapshot()).toBe(before);
  });

  it("news never raises it: headlines about a Meta that is not moving change nothing", () => {
    const s = store([run(at(0), [...filler(1), ["x", 60]]), run(at(HOUR), [...filler(1), ["x", 60]])]);
    s.recordSignals([{ id: "rss:1", sourceId: "rss:wired", sourceLabel: "Wired", title: "x x x x everywhere", summary: "", url: "", publishedAt: new Date(at(HOUR)).toISOString() }]);
    expect(raiseHotMetas(s)).toEqual([]);
  });
});

describe("raiseHotMetasSafely: a Hot now failure never stops the Meta tick", () => {
  it("logs and returns no events when the check throws, so the tick carries on to the summary tick", () => {
    const broken = { meta: { latest: () => { throw new Error("disk I/O error"); } } } as unknown as Datastore;
    const logged: unknown[][] = [];
    expect(() => raiseHotMetasSafely(broken, META_RULE, (...a) => logged.push(a))).not.toThrow();
    expect(raiseHotMetasSafely(broken, META_RULE, (...a) => logged.push(a))).toEqual([]);
    expect(logged[0]![0]).toBe("[worker] hot now failed");
    expect((logged[0]![1] as Error).message).toBe("disk I/O error");
  });

  it("passes the events through when nothing fails", () => {
    const s = store([run(at(0), placed(9)), run(at(HOUR), placed(4))]);
    expect(raiseHotMetasSafely(s).filter((e) => e.key === "x")).toHaveLength(1);
  });
});

describe("the 2026-11-12 shape: jensen", () => {
  // jensen: rank 7 at 00:00Z, rank 3 at 04:07Z, rank 2 at 14:46Z, creators 28 to 58. Runs every 15 minutes in production; here the day's few.
  const runs = [
    run(Date.parse("2026-11-12T00:00:00.000Z"), [...filler(6), ["jensen", 28]]),
    run(Date.parse("2026-11-12T03:07:00.000Z"), [...filler(6), ["jensen", 30]]),
    run(Date.parse("2026-11-12T04:07:00.000Z"), [...filler(2), ["jensen", 31]]),
    run(Date.parse("2026-11-12T14:46:00.000Z"), [...filler(1), ["jensen", 58]]),
  ];

  it("raises an event at the rank-3 run at the latest", () => {
    const s = store(runs.slice(0, 3));
    const events = raiseHotMetas(s);
    expect(events.map((e) => ({ key: e.key, reason: e.reason, rank: e.rank, raisedAt: e.raisedAt }))).toEqual([{ key: "jensen", reason: "entered top 5", rank: 3, raisedAt: "2026-11-12T04:07:00.000Z" }]);
  });

  it("raises at the rank-3 run even when the older run is the 00:00 one (no run between)", () => {
    expect(raiseHotMetas(store([runs[0]!, runs[2]!])).map((e) => e.reason)).toEqual(["entered top 5"]);
  });

  it("is not raised again at the rank-2 run: it was already in the top 5, and the creators baseline is hours old", () => {
    const s = store(runs.slice(0, 3));
    raiseHotMetas(s);
    s.meta.saveRun(runs[3]!);
    expect(raiseHotMetas(s)).toEqual([]);
  });

  it("creators 28 to 58 inside an hour raises on that alone", () => {
    const events = raised([run(at(0), [...filler(6), ["jensen", 28]]), run(at(HOUR), [...filler(6), ["jensen", 58]])]);
    expect(events).toEqual([{ key: "jensen", reason: "creators 28 to 58 in 1 h", rank: 7 }]);
  });
});

describe("the Hot now read side", () => {
  const NOW = new Date(at(HOUR + 30));
  function hotStore() {
    const s = store([run(at(0), [...filler(8), ["jensen", 28]]), run(at(HOUR), [...filler(3), ["jensen", 60]])]);
    raiseHotMetas(s);
    s.recordSignals([
      { id: "rss:1", sourceId: "rss:wired", sourceLabel: "Wired", title: "Nvidia CEO jensen on stage", summary: "", url: "https://example.com/a", publishedAt: new Date(at(HOUR - 20)).toISOString() },
      { id: "rss:2", sourceId: "rss:wired", sourceLabel: "Wired", title: "Rates unchanged", summary: "", url: "https://example.com/b", publishedAt: new Date(at(HOUR - 10)).toISOString() },
    ]);
    return s;
  }

  it("the live events of the last cool-down by key, and the answer for the panel: the Meta row, the reason and the matching news", () => {
    const s = hotStore();
    expect([...liveHot(s, NOW).keys()]).toEqual(["jensen"]);
    const r = hotNowResponse(s, NOW);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ reason: "entered top 5; creators 28 to 60 in 1 h", meta: { label: "jensen", counts: { "24h": { creators: 60, migrations: 3, migrationsAfter60s: 1 } }, topTokens: [{ name: "jensen" }] }, news: [{ title: "Nvidia CEO jensen on stage", sourceLabel: "Wired", url: "https://example.com/a" }] });
  });

  it("an event is live for the cool-down only, and a Meta that left the ranking is not shown", () => {
    const s = hotStore();
    expect(hotNowResponse(s, new Date(at(HOUR + 6 * HOUR + 1))).items).toEqual([]);
    s.meta.saveRun(run(at(HOUR + 15), filler(3)));
    expect(hotNowResponse(s, NOW).items).toEqual([]);
  });

  it("before the first run the answer is empty, not an error", () => {
    expect(hotNowResponse(Datastore.open(":memory:"), NOW)).toEqual({ computedAt: null, items: [] });
  });
});
