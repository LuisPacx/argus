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
/** `n` Picks of one source on one topic with `bonded` of them bonded (the rest not bonded); every coin is in the topic's brief list. */
function many(source: "operator" | "shadow", topic: string, n: number, bonded: number, lists: Map<string, Set<string>>): ScoreItem[] {
  return Array.from({ length: n }, (_v, i) => {
    const it = item(source, topic, i < bonded ? "bonded" : "not-bonded");
    const key = scoreTopicKey(topic);
    lists.set(key, (lists.get(key) ?? new Set()).add(it.ca));
    return it;
  });
}

describe("the verdict threshold", () => {
  it("is 20 Picks per side, in code", () => {
    expect(SCOREBOARD_MIN_PICKS).toBe(20);
  });

  it("names no winner while either side has fewer than 20 finished Picks, however lopsided the rates", () => {
    const lists = new Map<string, Set<string>>();
    for (const [o, m] of [[19, 19], [19, 40], [40, 19], [0, 30], [20, 0]] as const) {
      const b = buildScoreboard([...many("operator", "GTA", o, 0, lists), ...many("shadow", "GTA", m, m, lists)], lists);
      expect(b.verdict.kind, `${o}/${m}`).toBe("not-enough");
      expect(b.verdict.text).toContain("Not enough Picks yet");
      expect(b.verdict.text).toContain(`${SCOREBOARD_MIN_PICKS} finished Picks on each side`);
    }
  });

  it("names the leader, or a tie, at 20 on each side", () => {
    const lists = new Map<string, Set<string>>();
    const win = buildScoreboard([...many("operator", "GTA", 20, 5, lists), ...many("shadow", "GTA", 20, 8, lists)], lists);
    expect(win.verdict).toMatchObject({ kind: "machine" });
    expect(win.verdict.text).toContain("40% against 25%");
    expect(win.operator).toMatchObject({ finished: 20, bonded: 5, rate: 0.25 });
    expect(win.machine).toMatchObject({ finished: 20, bonded: 8, rate: 0.4 });
    const l2 = new Map<string, Set<string>>();
    expect(buildScoreboard([...many("operator", "GTA", 20, 9, l2), ...many("shadow", "GTA", 20, 4, l2)], l2).verdict.kind).toBe("operator");
    const l3 = new Map<string, Set<string>>();
    expect(buildScoreboard([...many("operator", "GTA", 20, 6, l3), ...many("shadow", "GTA", 20, 6, l3)], l3).verdict.kind).toBe("level");
  });

  it("n counts only Picks that count in the rate: pending, already-bonded and unknown ones do not reach 20", () => {
    const lists = new Map<string, Set<string>>();
    const items = [...many("operator", "GTA", 20, 3, lists), ...many("shadow", "GTA", 19, 3, lists), item("shadow", "GTA", "pending"), item("shadow", "GTA", "already-bonded"), item("shadow", "GTA", "unknown")];
    for (const i of items.filter((x) => x.source === "shadow")) lists.get("gta")!.add(i.ca);
    const b = buildScoreboard(items, lists);
    expect(b.machine).toMatchObject({ finished: 19, pending: 1, alreadyBonded: 1, unknown: 1 });
    expect(b.verdict.kind).toBe("not-enough");
  });

  it("verdictOf draws nothing from a missing rate", () => {
    const empty = { bonded: 0, finished: 0, rate: null, alreadyBonded: 0, unknown: 0, pending: 0 };
    expect(verdictOf(empty, empty).kind).toBe("not-enough");
  });
});

describe("like with like", () => {
  it("compares only topics where both sides picked, and an Operator Pick only when its coin was in a brief's list for that topic", () => {
    const lists = new Map<string, Set<string>>();
    const inGta = many("operator", "GTA", 3, 2, lists); // in the GTA list
    const machineGta = many("shadow", "gta", 2, 1, lists); // same topic, other case
    const stray = item("operator", "GTA", "bonded"); // the Operator's coin was never in a GTA brief
    const noTopic = item("operator", "", "bonded");
    const onlyOperatorTopic = many("operator", "Chess", 2, 2, lists); // the machine never researched Chess
    const onlyMachineTopic = many("shadow", "Cats", 2, 0, lists); // the Operator picked nothing on Cats
    const b = buildScoreboard([...inGta, ...machineGta, stray, noTopic, ...onlyOperatorTopic, ...onlyMachineTopic], lists);
    expect(b.topics).toEqual(["GTA"]);
    expect(b.operator).toMatchObject({ finished: 3, bonded: 2 });
    expect(b.machine).toMatchObject({ finished: 2, bonded: 1 });
    // The rest is shown on its own and never in the comparison.
    expect(b.operatorOutside).toMatchObject({ finished: 4, bonded: 4 });
    expect(b.machineOutside).toMatchObject({ finished: 2, bonded: 0 });
  });

  it("an already-bonded coin is left out of both sides by the one rule", () => {
    const lists = new Map<string, Set<string>>();
    const items = [item("operator", "GTA", "already-bonded"), item("shadow", "GTA", "already-bonded"), item("operator", "GTA", "bonded"), item("shadow", "GTA", "not-bonded")];
    for (const i of items) lists.set("gta", (lists.get("gta") ?? new Set()).add(i.ca));
    const b = buildScoreboard(items, lists);
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

  it("with no Picks at all the Scoreboard is empty and not enough", () => {
    const s = Datastore.open(":memory:").scoreboard(NOW);
    expect(s.operator.rate).toBeNull();
    expect(s.machine.rate).toBeNull();
    expect(s.topics).toEqual([]);
    expect(s.verdict.kind).toBe("not-enough");
  });
});
