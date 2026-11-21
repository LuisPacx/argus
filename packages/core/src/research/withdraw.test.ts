import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import type { PickSnapshot } from "./picks.ts";
import { PICK_WITHDRAW_MS, PickWithdrawRefusedError } from "./picks.ts";
import { PLAYBOOK_MIN_PICKS } from "./playbook.ts";

// Human researcher ticket 10: the Operator withdraws his own mistyped Pick within 10 minutes. The Pick row is never touched; the withdrawal is its own
// write-once row; a withdrawn Pick counts nowhere.

const T0 = new Date("2026-11-20T12:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const CA = (n: number) => `${String(n % 9 || 9).repeat(30)}${String(n).padStart(2, "0")}pump`;
const snap = (n: number): PickSnapshot => ({ ca: CA(n), name: `Coin ${n}`, symbol: `C${n}`, marketCapUsd: 50_000, liquidityUsd: 12_000, pairCreatedAt: null, ageMinutes: 10, bondedAtPick: false, bondedBasis: "", venue: "pumpfun" });
type Db = { prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): Record<string, unknown>[] } };
const dbOf = (store: Datastore) => (store as unknown as { db: Db }).db;
const finish = (store: Datastore, id: number, result: "bonded" | "not-bonded") =>
  store.applyPickProgress(id, { outcome: { result, bondedAt: null, bondedBasis: "", peakUsd: null, lastOkAt: null, finishedAt: at(5).toISOString() }, samples: [] });
const refusal = (fn: () => void): PickWithdrawRefusedError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PickWithdrawRefusedError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
};

describe("withdrawing a Pick", () => {
  it("within 10 minutes records one withdrawal and leaves the Pick row unchanged; the database still refuses update and delete of both", () => {
    const store = Datastore.open(":memory:");
    const p = store.recordPick({ snapshot: snap(1), reason: "typo", topic: "GTA" }, { now: T0 });
    const before = dbOf(store).prepare("SELECT * FROM picks WHERE id = ?").all(p.id);
    store.withdrawPick(p.id, at(9));
    expect(dbOf(store).prepare("SELECT * FROM picks WHERE id = ?").all(p.id)).toEqual(before);
    expect(dbOf(store).prepare("SELECT * FROM pick_withdrawals").all()).toEqual([{ pick_id: p.id, withdrawn_at: at(9).toISOString() }]);
    expect(store.listPicks()[0]).toMatchObject({ id: p.id, withdrawnAt: at(9).toISOString() });
    const db = dbOf(store);
    expect(() => db.prepare("UPDATE picks SET reason = 'x' WHERE id = ?").run(p.id)).toThrow("never changed");
    expect(() => db.prepare("DELETE FROM picks WHERE id = ?").run(p.id)).toThrow("never removed");
    expect(() => db.prepare("UPDATE pick_withdrawals SET withdrawn_at = 'x'").run()).toThrow("never changed");
    expect(() => db.prepare("DELETE FROM pick_withdrawals").run()).toThrow("never removed");
  });

  it("at 10 minutes or later it is refused and records nothing; twice is refused; an unknown id is refused", () => {
    const store = Datastore.open(":memory:");
    const p = store.recordPick({ snapshot: snap(1), reason: "", topic: "" }, { now: T0 });
    expect(PICK_WITHDRAW_MS).toBe(600_000);
    expect(refusal(() => store.withdrawPick(p.id, at(10))).code).toBe("too-late");
    expect(refusal(() => store.withdrawPick(p.id, at(90))).code).toBe("too-late");
    expect(dbOf(store).prepare("SELECT * FROM pick_withdrawals").all()).toEqual([]);
    store.withdrawPick(p.id, at(9.9));
    expect(refusal(() => store.withdrawPick(p.id, at(9.95))).code).toBe("already");
    expect(refusal(() => store.withdrawPick(999, at(1))).code).toBe("unknown");
    expect(dbOf(store).prepare("SELECT * FROM pick_withdrawals").all()).toHaveLength(1);
  });

  it("a Shadow pick cannot be withdrawn", () => {
    const store = Datastore.open(":memory:");
    const s = store.recordPick({ snapshot: snap(1), reason: "", topic: "GTA", source: "shadow" }, { now: T0 });
    expect(refusal(() => store.withdrawPick(s.id, at(1))).code).toBe("shadow");
    expect(dbOf(store).prepare("SELECT * FROM pick_withdrawals").all()).toEqual([]);
  });

  it("writes only the withdrawal row: no brain run, no request, no other table", () => {
    const store = Datastore.open(":memory:");
    const p = store.recordPick({ snapshot: snap(1), reason: "", topic: "" }, { now: T0 });
    const counts = () => {
      const db = dbOf(store);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => String(r.name));
      return Object.fromEntries(tables.map((t) => [t, Number(db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).all()[0]?.n)]));
    };
    const before = counts();
    store.withdrawPick(p.id, at(1));
    expect({ ...counts(), pick_withdrawals: 0 }).toEqual({ ...before, pick_withdrawals: 0 });
    expect(counts().pick_withdrawals).toBe(1);
  });

  it("the same coin can be picked again at once after a withdrawal", () => {
    const store = Datastore.open(":memory:");
    const p = store.recordPick({ snapshot: snap(1), reason: "", topic: "" }, { now: T0 });
    store.withdrawPick(p.id, at(1));
    expect(() => store.recordPick({ snapshot: snap(1), reason: "", topic: "" }, { now: at(2) })).not.toThrow();
  });
});

describe("a withdrawn Pick counts nowhere", () => {
  it("is out of the bonding rate but still listed, and no outcome job looks at it", () => {
    const store = Datastore.open(":memory:");
    const a = store.recordPick({ snapshot: snap(1), reason: "", topic: "" }, { now: T0 });
    const b = store.recordPick({ snapshot: snap(2), reason: "", topic: "" }, { now: at(1) });
    const c = store.recordPick({ snapshot: snap(3), reason: "", topic: "" }, { now: at(2) });
    finish(store, a.id, "bonded");
    finish(store, b.id, "bonded");
    finish(store, c.id, "not-bonded");
    expect(store.pickOutcomes(at(60)).all).toMatchObject({ finished: 0, pending: 3 });
    store.withdrawPick(b.id, at(3));
    expect(store.openPickOutcomes().map((o) => o.pick.id)).toEqual([]);
    const d = store.recordPick({ snapshot: snap(4), reason: "", topic: "" }, { now: at(4) });
    store.withdrawPick(d.id, at(5));
    expect(store.openPickOutcomes().map((o) => o.pick.id)).toEqual([]); // nothing open: d is withdrawn, the rest are finished
    const e = store.recordPick({ snapshot: snap(5), reason: "", topic: "" }, { now: at(4) });
    expect(store.openPickOutcomes().map((o) => o.pick.id)).toEqual([e.id]);
    const v = store.pickOutcomes(at(60 * 25));
    expect(v.all).toMatchObject({ bonded: 1, finished: 2, rate: 0.5 });
    expect(v.outcomes.map((o) => o.pickId)).toContain(b.id);
    expect(store.listPicks().map((p) => p.id)).toContain(b.id);
  });

  it("is out of the Scoreboard counts", () => {
    const store = Datastore.open(":memory:");
    const a = store.recordPick({ snapshot: snap(1), reason: "", topic: "GTA" }, { now: at(-60) });
    const b = store.recordPick({ snapshot: snap(2), reason: "", topic: "GTA" }, { now: at(-59) });
    finish(store, a.id, "bonded");
    finish(store, b.id, "bonded");
    const all = (x: { finished: number; pending: number; alreadyBonded: number; unknown: number }) => x.finished + x.pending + x.alreadyBonded + x.unknown;
    const sum = (s: ReturnType<Datastore["scoreboard"]>) => all(s.operator) + all(s.operatorOutside);
    expect(sum(store.scoreboard(at(0)))).toBe(2);
    store.withdrawPick(b.id, at(-55));
    expect(sum(store.scoreboard(at(0)))).toBe(1);
  });

  it("is out of the Playbook inputs and of the 10-Pick minimum", () => {
    const store2 = Datastore.open(":memory:");
    for (let i = 0; i < PLAYBOOK_MIN_PICKS; i++) finish(store2, store2.recordPick({ snapshot: snap(i + 1), reason: `r${i}`, topic: "GTA" }, { now: at(-5000 + i) }).id, "bonded");
    const fresh = store2.recordPick({ snapshot: snap(50), reason: "typo", topic: "GTA" }, { now: at(0) });
    finish(store2, fresh.id, "bonded");
    expect(store2.countFinishedPicks()).toBe(PLAYBOOK_MIN_PICKS + 1);
    store2.withdrawPick(fresh.id, at(1));
    expect(store2.countFinishedPicks()).toBe(PLAYBOOK_MIN_PICKS);
    expect(store2.playbookPicks().map((p) => p.id)).not.toContain(fresh.id);
    expect(store2.playbookPicks()).toHaveLength(PLAYBOOK_MIN_PICKS);
    // One short of the minimum once a withdrawn one is among them.
    const store3 = Datastore.open(":memory:");
    for (let i = 0; i < PLAYBOOK_MIN_PICKS - 1; i++) finish(store3, store3.recordPick({ snapshot: snap(i + 1), reason: "", topic: "GTA" }, { now: at(-5000 + i) }).id, "bonded");
    const w = store3.recordPick({ snapshot: snap(60), reason: "", topic: "GTA" }, { now: at(0) });
    finish(store3, w.id, "bonded");
    store3.withdrawPick(w.id, at(1));
    expect(() => store3.requestPlaybook({ now: at(2) })).toThrow("you have 9");
  });
});
