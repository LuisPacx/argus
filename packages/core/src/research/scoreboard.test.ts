import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import type { OutcomeResult } from "./pick-outcomes.ts";
import type { PickSnapshot } from "./picks.ts";
import { buildScoreboard, SCOREBOARD_MIN_PICKS, scoreTopicKey, verdictOf, type ScoreItem } from "./scoreboard.ts";

// Human researcher ticket 08: the Scoreboard. Operator against machine, bonded within 24 hours, last 7 days, each side with n; a leader is named only
// with SCOREBOARD_MIN_PICKS (20) finished Picks on each side; only like with like is compared.

const CA = (n: number) => `${String(n % 9 + 1)}${"A".repeat(30)}${String(n).padStart(3, "1")}`;
let seq = 0;
const item = (source: "operator" | "shadow", topic: string, result: OutcomeResult, ca = CA(++seq)): ScoreItem => ({ source, ca, topic, over: result !== "pending", result });
/** The topics of research requests in these tests (keys). */
const REQ: ReadonlySet<string> = new Set(["gta", "chess", "cats"].map(scoreTopicKey));
/** `n` Picks of one source on one topic with `bonded` of them bonded (the rest not bonded). */
const many = (source: "operator" | "shadow", topic: string, n: number, bonded: number): ScoreItem[] => Array.from({ length: n }, (_v, i) => item(source, topic, i < bonded ? "bonded" : "not-bonded"));
const build = (items: ScoreItem[]) => buildScoreboard(items, REQ);

describe("the verdict threshold", () => {
  it("is 20 Picks per side, in code", () => {
    expect(SCOREBOARD_MIN_PICKS).toBe(20);
  });

  it("names no winner while either side has fewer than 20 finished Picks, however lopsided the rates", () => {
    for (const [o, m] of [[19, 19], [19, 40], [40, 19], [0, 30], [20, 0]] as const) {
      const b = build([...many("operator", "GTA", o, 0), ...many("shadow", "GTA", m, m)]);
      expect(b.verdict.kind, `${o}/${m}`).toBe("not-enough");
      expect(b.verdict.text).toContain("Not enough Picks yet");
      expect(b.verdict.text).toContain(`${SCOREBOARD_MIN_PICKS} finished Picks on each side`);
    }
  });

  it("names the leader, or a tie, at 20 on each side", () => {
    const win = build([...many("operator", "GTA", 20, 5), ...many("shadow", "GTA", 20, 8)]);
    expect(win.verdict).toMatchObject({ kind: "machine" });
    expect(win.verdict.text).toContain("40% against 25%");
    expect(win.operator).toMatchObject({ finished: 20, bonded: 5, rate: 0.25 });
    expect(win.machine).toMatchObject({ finished: 20, bonded: 8, rate: 0.4 });
    expect(build([...many("operator", "GTA", 20, 9), ...many("shadow", "GTA", 20, 4)]).verdict.kind).toBe("operator");
    expect(build([...many("operator", "GTA", 20, 6), ...many("shadow", "GTA", 20, 6)]).verdict.kind).toBe("level");
  });

  it("n counts only Picks that count in the rate: pending, already-bonded and unknown ones do not reach 20", () => {
    const b = build([...many("operator", "GTA", 20, 3), ...many("shadow", "GTA", 19, 3), item("shadow", "GTA", "pending"), item("shadow", "GTA", "already-bonded"), item("shadow", "GTA", "unknown")]);
    expect(b.machine).toMatchObject({ finished: 19, pending: 1, alreadyBonded: 1, unknown: 1 });
    expect(b.verdict.kind).toBe("not-enough");
  });

  it("verdictOf draws nothing from a missing rate", () => {
    const empty = { bonded: 0, finished: 0, rate: null, alreadyBonded: 0, unknown: 0, pending: 0 };
    expect(verdictOf(empty, empty).kind).toBe("not-enough");
  });
});

describe("like with like", () => {
  it("counts every Operator Pick on a compared topic, also a coin no brief listed (a stray one), in the Operator's rate and n", () => {
    const listed = many("operator", "GTA", 3, 2);
    const stray = item("operator", "GTA", "bonded", "Z".repeat(32)); // no brief's coin list holds it: nothing here knows of lists any more
    const b = build([...listed, stray, ...many("shadow", "GTA", 2, 1)]);
    expect(b.operator).toMatchObject({ finished: 4, bonded: 3, rate: 0.75 });
    expect(b.operatorOutside.finished).toBe(0);
  });

  it("matches topics ignoring letter case and surrounding space, not a different word, and a Pick with no topic is never compared", () => {
    const b = build([item("operator", "  GtA ", "bonded"), item("shadow", "gta", "not-bonded"), item("operator", "GTA 6", "bonded"), item("shadow", "GTA 6", "bonded"), item("operator", "", "bonded"), item("shadow", "", "bonded")]);
    expect(b.topics).toEqual(["GtA"]);
    expect(b.operator.finished).toBe(1);
    expect(b.machine.finished).toBe(1);
    // "GTA 6" is no request's topic here, so the Operator's Pick on it and the no-topic Picks stay apart.
    expect(b.operatorOutside).toMatchObject({ finished: 2 });
  });

  it("compares only topics where both sides picked, and counts both sides over exactly those topics", () => {
    const b = build([...many("operator", "GTA", 3, 2), ...many("shadow", "gta", 2, 1), item("operator", "", "bonded"), ...many("operator", "Chess", 2, 2), ...many("shadow", "Cats", 2, 0)]);
    expect(b.topics).toEqual(["GTA"]);
    expect(b.operator).toMatchObject({ finished: 3, bonded: 2 });
    expect(b.machine).toMatchObject({ finished: 2, bonded: 1 });
    // The rest is shown on its own and never in the comparison.
    expect(b.operatorOutside).toMatchObject({ finished: 3, bonded: 3 });
    expect(b.machineOutside).toMatchObject({ finished: 2, bonded: 0 });
  });

  it("an already-bonded coin is left out of both sides by the one rule", () => {
    const b = build([item("operator", "GTA", "already-bonded"), item("shadow", "GTA", "already-bonded"), item("operator", "GTA", "bonded"), item("shadow", "GTA", "not-bonded")]);
    expect(b.operator).toMatchObject({ finished: 1, alreadyBonded: 1, rate: 1 });
    expect(b.machine).toMatchObject({ finished: 1, alreadyBonded: 1, rate: 0 });
  });
});

describe("the Scoreboard from the database", () => {
  const NOW = new Date("2026-11-20T12:00:00.000Z");
  const DAY = 24 * 3_600_000;
  const snap = (ca: string): PickSnapshot => ({ ca, name: "Coin", symbol: "CN", marketCapUsd: 50_000, liquidityUsd: 12_000, pairCreatedAt: null, ageMinutes: 10, bondedAtPick: false, bondedBasis: "", venue: "pumpfun" });
  const finish = (store: Datastore, id: number, result: "bonded" | "not-bonded") => store.applyPickProgress(id, { outcome: { result, bondedAt: null, bondedBasis: "", peakUsd: 1, lastOkAt: null, finishedAt: NOW.toISOString() }, samples: [] });
  const brief = (coins: string[]) => ({ story: "s", sources: [], coins: coins.map((ca) => ({ ca, name: "n", symbol: "S", marketCapUsd: 1, liquidityUsd: 1, bonded: "no" as const, note: "" })), freeNames: [], xNote: "", createdAt: NOW.toISOString() });

  it("reads Picks of both sources over the last 7 days, scored by the same outcome rows, and ignores older ones", () => {
    const store = Datastore.open(":memory:");
    const a = CA(1);
    const b = CA(2);
    const old = CA(3);
    const req = store.requestResearch("GTA", { now: new Date(NOW.getTime() - 3 * DAY) });
    store.saveResearchBrief(req.id, brief([a, b]), new Date(NOW.getTime() - 3 * DAY), [{ snapshot: snap(b), reason: "r", topic: "GTA", playbookVersion: null }]);
    const mine = store.recordPick({ snapshot: snap(a), reason: "mine", topic: "gta" }, { now: new Date(NOW.getTime() - 2 * DAY) });
    const ancient = store.recordPick({ snapshot: snap(old), reason: "old", topic: "GTA" }, { now: new Date(NOW.getTime() - 9 * DAY) });
    finish(store, mine.id, "bonded");
    finish(store, ancient.id, "bonded");
    finish(store, store.listShadowPicks()[0]!.id, "not-bonded");
    const s = store.scoreboard(NOW);
    expect(s).toMatchObject({ windowDays: 7, minPicks: 20, topics: ["gta"] });
    expect(s.operator).toMatchObject({ finished: 1, bonded: 1, rate: 1 });
    expect(s.machine).toMatchObject({ finished: 1, bonded: 0, rate: 0 });
    expect(s.operatorOutside.finished + s.operatorOutside.pending).toBe(0); // the 9 day old Pick is outside the window altogether
    expect(s.verdict.kind).toBe("not-enough");
  });

  it("counts an Operator Pick of a coin in no brief list, matches the topic by cleaned text and case, skips a withdrawn Pick, and is read only", () => {
    const store = Datastore.open(":memory:");
    const req = store.requestResearch("GTA", { now: new Date(NOW.getTime() - 3 * DAY) });
    store.saveResearchBrief(req.id, brief([CA(2)]), new Date(NOW.getTime() - 3 * DAY), [{ snapshot: snap(CA(2)), reason: "r", topic: "GTA", playbookVersion: null }]);
    const stray = store.recordPick({ snapshot: snap(CA(5)), reason: "stray", topic: "  gta " }, { now: new Date(NOW.getTime() - DAY) }); // in no brief's list
    const withdrawn = store.recordPick({ snapshot: snap(CA(6)), reason: "typo", topic: "GTA" }, { now: new Date(NOW.getTime() - DAY) });
    store.withdrawPick(withdrawn.id, new Date(NOW.getTime() - DAY + 60_000));
    store.recordPick({ snapshot: snap(CA(7)), reason: "other word", topic: "GTA 6" }, { now: new Date(NOW.getTime() - DAY) });
    finish(store, stray.id, "bonded");
    finish(store, withdrawn.id, "bonded");
    finish(store, store.listShadowPicks()[0]!.id, "not-bonded");
    const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    const before = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const s = store.scoreboard(NOW);
    expect((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(before);
    expect(s.operator).toMatchObject({ finished: 1, bonded: 1 });
    expect(s.machine).toMatchObject({ finished: 1, bonded: 0 });
    expect(s.operatorOutside.finished + s.operatorOutside.pending).toBe(1); // "GTA 6" only
  });

  it("with no Picks at all the Scoreboard is empty and not enough", () => {
    const s = Datastore.open(":memory:").scoreboard(NOW);
    expect(s.operator.rate).toBeNull();
    expect(s.machine.rate).toBeNull();
    expect(s.topics).toEqual([]);
    expect(s.verdict.kind).toBe("not-enough");
  });
});
