import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Datastore, type Proposal } from "./datastore.ts";
import { expireStaleProposals, expiresAtFor } from "./expiry.ts";
import { dueMetas } from "./meme/pass.ts";
import type { MetaSnapshot, NewMemeIdea, NewMemeTrio } from "./meme/types.ts";
import { aMeta } from "./testing/meta-current.ts";
import { gapMsHeld, migrateWorkerGaps, recordWorkerAlive, startWorkerHeartbeat, WORKER_GAP_MS } from "./worker-gaps.ts";

const HOUR = 3_600_000;
const MIN = 60_000;
const T0 = Date.parse("2026-11-16T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms);

const snapshot = (key: string): MetaSnapshot => ({
  version: 1,
  capturedAt: at(0).toISOString(),
  meta: { key, label: key, rank: 2, firstSeenAt: at(-5 * HOUR).toISOString(), counts: { "6h": { tokens: 1, creators: 1, migrations: 0, migrationsAfter60s: 0 }, "24h": { tokens: 2, creators: 2, migrations: 0, migrationsAfter60s: 0 } }, topTokens: [] },
  run: { id: 7, computedAt: at(0).toISOString(), window: "24h", baseMigrationRate: 0.03, coverage: null },
  hot: { reason: "creators up", raisedAt: at(0).toISOString(), rank: 2, creators: 2 },
  roomLeft: { passed: true, text: "room" },
  tokens: [],
  news: [],
});
const idea = (n: number): NewMemeIdea => ({ name: `Idea ${["Alpha", "Bravo", "Charlie"][n]}`, ticker: ["AAA", "BBB", "CCC"][n]!, angle: "a", difference: "d", description: "p", hook: "gm", imageIdea: "i", riskLabels: [] });
const trio = (key: string): NewMemeTrio => ({ metaKey: key, metaLabel: key, snapshot: snapshot(key), reason: "Hot now", summary: "s", evidenceLinks: [], ideas: [idea(0), idea(1), idea(2)] });
const memeTrio = (store: Datastore, key: string, now: Date): Proposal[] => store.createMemeProposals(trio(key), { now });
/** The worker alive from `from` to `to` (ms after T0), one heartbeat every 5 minutes, as the tick writes them. */
const running = (store: Datastore, from: number, to: number) => {
  for (let t = from; t <= to; t += 5 * MIN) store.recordWorkerAlive(at(t));
};
const stateOf =(store: Datastore, p: Proposal) => store.getProposal(p.id)!.status;

describe("meme ideas count running time only (meta redesign ticket 10)", () => {
  it("a meme made at T, worker stopped T+1 h to T+14 h: none closes on the first tick after restart, it lives until T+25 h, then closes", () => {
    const store = Datastore.open(":memory:");
    const [p] = memeTrio(store, "a", at(0));
    running(store, 0, HOUR); // last tick before the stop
    expect(store.recordWorkerAlive(at(14 * HOUR))).toEqual({ start: at(HOUR).toISOString(), end: at(14 * HOUR).toISOString() });
    expect(store.getProposal(p!.id)!.expiresAt).toBe(at(25 * HOUR).toISOString());
    expect(expireStaleProposals(store, at(14 * HOUR))).toBe(0);
    expect(expireStaleProposals(store, at(25 * HOUR - MIN))).toBe(0);
    expect(stateOf(store, p!)).toBe("new");
    expect(expireStaleProposals(store, at(25 * HOUR))).toBe(3);
    expect(store.historyFor(p!.id).at(-1)).toMatchObject({ to: "closed", reason: "stale" });
  });

  it("a second stop adds a second gap", () => {
    const store = Datastore.open(":memory:");
    const [p] = memeTrio(store, "a", at(0));
    running(store, 0, HOUR);
    running(store, 3 * HOUR, 4 * HOUR); // 2 h stop
    running(store, 7 * HOUR, 7 * HOUR); // 3 h stop
    expect(store.workerGaps()).toHaveLength(2);
    expect(store.getProposal(p!.id)!.expiresAt).toBe(at(17 * HOUR).toISOString());
  });

  it("one with 12 h of running time already spent at the stop closes on the first tick after restart", () => {
    const store = Datastore.open(":memory:");
    const [p] = memeTrio(store, "a", at(0));
    running(store, 0, 12 * HOUR); // alive for the whole 12 h
    store.recordWorkerAlive(at(30 * HOUR)); // then stopped; the gap starts at its expiry
    // The gap began at the expiry instant, so it holds nothing: the idea is already due.
    expect(store.getProposal(p!.id)!.expiresAt).toBe(at(12 * HOUR).toISOString());
    expect(expireStaleProposals(store, at(30 * HOUR))).toBe(3);
    expect(store.historyFor(p!.id).at(-1)).toMatchObject({ to: "closed", actor: "system", reason: "stale" });
  });

  it("six ideas made 11 h before a 12 h stop are all live after the first tick and close about 1 h of running time later (the restart that happened)", () => {
    const store = Datastore.open(":memory:");
    const made = [...memeTrio(store, "a", at(0)), ...memeTrio(store, "b", at(0))];
    expect(made).toHaveLength(6);
    running(store, 0, 11 * HOUR);
    running(store, 23 * HOUR, 23 * HOUR); // restart
    expect(expireStaleProposals(store, at(23 * HOUR))).toBe(0);
    expect(made.every((p) => stateOf(store, p) === "new")).toBe(true);
    expect(expireStaleProposals(store, at(24 * HOUR - MIN))).toBe(0);
    expect(expireStaleProposals(store, at(24 * HOUR))).toBe(6);
  });

  it("a meme made after the gap, or a narrative Proposal, or a shortlisted meme, is not extended", () => {
    const store = Datastore.open(":memory:");
    store.recordWorkerAlive(at(0));
    store.recordWorkerAlive(at(5 * HOUR));
    const [late] = memeTrio(store, "a", at(6 * HOUR));
    expect(late!.expiresAt).toBe(at(18 * HOUR).toISOString());
    const gaps = store.workerGaps();
    expect(expiresAtFor("new", at(0).toISOString(), "narrative", gaps)).toBe(at(48 * HOUR).toISOString());
    expect(expiresAtFor("shortlisted", at(0).toISOString(), "meme", gaps)).toBe(at(7 * 24 * HOUR).toISOString());
    expect(expiresAtFor("new", at(0).toISOString(), "meme", gaps)).toBe(at(17 * HOUR).toISOString()); // no cap: the 5 h gap counts whole
  });

  it("a gap that began before the idea counts only from its creation", () => {
    const gaps = [{ start: at(0).toISOString(), end: at(10 * HOUR).toISOString() }];
    expect(expiresAtFor("new", at(4 * HOUR).toISOString(), "meme", gaps)).toBe(at(22 * HOUR).toISOString());
  });
});

describe("the heartbeat and the gap ledger", () => {
  it("a fresh database records no gap, and a gap under WORKER_GAP_MS records nothing", () => {
    const store = Datastore.open(":memory:");
    expect(WORKER_GAP_MS).toBe(10 * MIN);
    expect(store.recordWorkerAlive(at(0))).toBeNull();
    expect(store.recordWorkerAlive(at(WORKER_GAP_MS))).toBeNull(); // exactly the threshold is not over it
    expect(store.recordWorkerAlive(at(WORKER_GAP_MS + 90_000))).toBeNull();
    expect(store.workerGaps()).toEqual([]);
    const [p] = memeTrio(store, "a", at(0));
    expect(p!.expiresAt).toBe(at(12 * HOUR).toISOString());
  });

  it("two workers writing the heartbeat never record a gap that spans a time one of them was alive", () => {
    const store = Datastore.open(":memory:");
    store.recordWorkerAlive(at(0)); // the daemon
    store.recordWorkerAlive(at(8 * MIN)); // a --once run, 8 min later
    store.recordWorkerAlive(at(16 * MIN)); // the daemon again: 8 min after the --once, 16 after its own last
    store.recordWorkerAlive(at(20 * MIN)); // the --once
    expect(store.workerGaps()).toEqual([]);
  });

  it("a clock that goes backwards records no gap, does not throw, and does not move the heartbeat back", () => {
    const store = Datastore.open(":memory:");
    store.recordWorkerAlive(at(HOUR));
    expect(store.recordWorkerAlive(at(0))).toBeNull();
    expect(store.recordWorkerAlive(at(HOUR + 5 * MIN))).toBeNull();
    expect(store.workerGaps()).toEqual([]);
  });

  it("an unreadable worker_alive.at is treated as no heartbeat", () => {
    const db = new DatabaseSync(":memory:");
    migrateWorkerGaps(db);
    db.exec("INSERT INTO worker_alive (id, at) VALUES (1, 'garbage')");
    expect(recordWorkerAlive(db, at(5 * HOUR))).toBeNull();
    expect(db.prepare("SELECT at FROM worker_alive").get()).toEqual({ at: at(5 * HOUR).toISOString() });
    expect(db.prepare("SELECT COUNT(*) AS n FROM worker_gaps").get()).toEqual({ n: 0 });
  });

  it("an existing database without the tables opens and gets them", () => {
    const store = Datastore.open(":memory:");
    expect(store.workerGaps()).toEqual([]);
    expect(() => migrateWorkerGaps(new DatabaseSync(":memory:"))).not.toThrow();
  });
});

describe("the 12 h meme refresh is held by recorded downtime", () => {
  const meta = aMeta("a", { label: "a", enteredAt: at(-30 * HOUR).toISOString() });
  const last = { at: at(0).toISOString(), outcome: "stored" as const, eventAt: "x" };
  const config = { failedRetryMinutes: 30 };

  it("tried at T, stopped T+1 h to T+14 h: nothing is due at T+14 h; the refresh is due at T+25 h, with that slot", () => {
    const gaps = [{ start: at(HOUR).toISOString(), end: at(14 * HOUR).toISOString() }];
    const held = (since: string, ttl: number) => gapMsHeld(gaps, since, ttl);
    expect(dueMetas([meta], new Map(), () => last, at(14 * HOUR), config, held)).toEqual([]);
    expect(dueMetas([meta], new Map(), () => last, at(25 * HOUR - MIN), config, held)).toEqual([]);
    const due = dueMetas([meta], new Map(), () => last, at(25 * HOUR), config, held);
    expect(due.map((d) => [d.kind, d.eventAt])).toEqual([["refresh", at(25 * HOUR).toISOString()]]);
  });

  it("a New Meta event after the restart still runs", () => {
    const gaps = [{ start: at(HOUR).toISOString(), end: at(14 * HOUR).toISOString() }];
    const events = new Map([["a", { raisedAt: at(14 * HOUR).toISOString() }]]);
    const due = dueMetas([meta], events, () => last, at(14 * HOUR), config, (since, ttl) => gapMsHeld(gaps, since, ttl));
    expect(due.map((d) => d.kind)).toEqual(["new-meta"]);
  });

  it("without gaps the refresh is due at 12 h as before", () => {
    expect(dueMetas([meta], new Map(), () => last, at(12 * HOUR), config)).toHaveLength(1);
  });
});

describe("the heartbeat timer", () => {
  /** A fake clock and a fake setInterval: `advance(ms)` moves time and fires the timers due, so no real time passes. */
  const fakeTime = () => {
    let now = T0;
    const timers: Array<{ fn: () => void; every: number; next: number; live: boolean }> = [];
    return {
      deps: {
        now: () => new Date(now),
        setInterval: (fn: () => void, every: number) => {
          const t = { fn, every, next: now + every, live: true };
          timers.push(t);
          return t;
        },
        clearInterval: (h: unknown) => {
          (h as { live: boolean }).live = false;
        },
      },
      advance: (ms: number) => {
        const end = now + ms;
        for (;;) {
          const due = timers.filter((t) => t.live && t.next <= end).sort((a, b) => a.next - b.next)[0];
          if (!due) break;
          now = due.next;
          due.next += due.every;
          due.fn();
        }
        now = end;
      },
      at: () => new Date(now),
    };
  };

  it("a tick that runs longer than WORKER_GAP_MS records no gap while the heartbeat timer runs", () => {
    const store = Datastore.open(":memory:");
    const time = fakeTime();
    store.recordWorkerAlive(time.at()); // boot
    const stop = startWorkerHeartbeat(store, 30_000, () => {}, () => {}, time.deps);
    time.advance(WORKER_GAP_MS + 5 * MIN); // one tick waiting 15 min on a Spec run
    store.recordWorkerAlive(time.at()); // the next tick's own write
    expect(store.workerGaps()).toEqual([]);
    stop();
  });

  it("without the timer the same long tick is a gap, and a stopped timer writes nothing", () => {
    const store = Datastore.open(":memory:");
    const time = fakeTime();
    store.recordWorkerAlive(time.at());
    time.advance(WORKER_GAP_MS + 5 * MIN);
    expect(store.recordWorkerAlive(time.at())).not.toBeNull();
    const stop = startWorkerHeartbeat(store, 30_000, () => {}, () => {}, time.deps);
    stop();
    time.advance(HOUR);
    expect(store.workerGaps()).toHaveLength(1); // only the one above
  });

  it("a failed write goes to onError and does not throw", () => {
    const time = fakeTime();
    const errors: unknown[] = [];
    startWorkerHeartbeat({ recordWorkerAlive: () => { throw new Error("locked"); } }, 1000, () => {}, (e) => errors.push(e), time.deps);
    expect(() => time.advance(3000)).not.toThrow();
    expect(errors).toHaveLength(3);
  });
});
