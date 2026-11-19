import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Datastore, MemeAngleRefusedError, type WarRoomStore } from "../datastore.ts";
import { aMeta, saveCurrentRun } from "../testing/meta-current.ts";
import { tempDir } from "../testing/temp.ts";
import { ANGLE_MAX_CHARS, MAX_MEME_ANGLE_PER_DAY, memeAngleConfigFromEnv, parseAngle } from "./angle.ts";
import type { MetaSnapshot, NewMemeIdea, NewMemeTrio } from "./types.ts";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-17T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms);

/** A store whose newest run has the Meta `jensen`, the Meta `gta` and the Watching subject `watch`. */
function seeded(path = ":memory:") {
  const store = Datastore.open(path);
  saveCurrentRun(store, at(0), { metas: [aMeta("jensen", { label: "Jensen" }), aMeta("gta", { label: "GTA 6" })], watching: [aMeta("watch", { label: "Watch me", cap: 400_000 })] });
  return store;
}
const ask = (store: Datastore, over: Partial<{ metaKey: string; angle: string; sourceUrl: string | null; urlDropped: boolean }> = {}, now = at(HOUR)) =>
  store.requestMemeAngle({ metaKey: "gta", angle: "iguana in front of a mobility scooter", sourceUrl: null, ...over }, { now });
const refusal = (f: () => unknown): MemeAngleRefusedError => {
  try {
    f();
  } catch (e) {
    if (e instanceof MemeAngleRefusedError) return e;
    throw e;
  }
  throw new Error("expected a MemeAngleRefusedError");
};

describe("requestMemeAngle: the War Room's insert", () => {
  it("inserts one pending row for a Meta, and for a Watching subject, with the Meta's label as it was", () => {
    const store = seeded();
    const a = ask(store, { sourceUrl: "https://www.rockstargames.com/VI/only-in-leonida" });
    expect(a).toMatchObject({ id: 1, metaKey: "gta", metaLabel: "GTA 6", angle: "iguana in front of a mobility scooter", sourceUrl: "https://www.rockstargames.com/VI/only-in-leonida", status: "pending", detail: "", doneAt: null, proposalIds: [], createdAt: at(HOUR).toISOString() });
    store.resolveAngleRequest(a.id, { status: "refused", detail: "x" }, at(HOUR));
    expect(ask(store, { metaKey: "watch" }, at(2 * HOUR))).toMatchObject({ id: 2, metaKey: "watch", metaLabel: "Watch me", status: "pending" });
  });

  it("is on the War Room's allowed view and the worker's claim and resolve are not (type test)", () => {
    const store = seeded();
    const wr: WarRoomStore = store;
    expect(wr.requestMemeAngle).toBeDefined();
    expect(wr.memeAngleRequests).toBeDefined();
    // @ts-expect-error claimAngleRequest is worker-only
    expect(wr.claimAngleRequest).toBeDefined();
    // @ts-expect-error resolveAngleRequest is worker-only
    expect(wr.resolveAngleRequest).toBeDefined();
  });

  it("refuses a key that is not in the newest run, and says so", () => {
    const store = seeded();
    const e = refusal(() => ask(store, { metaKey: "nothing-like-it" }));
    expect(e.code).toBe("unknown-meta");
    expect(e.message).toMatch(/not a current Meta/);
    expect(store.memeAngleRequests()).toEqual([]);
    // a store with no run at all has no Meta either
    expect(refusal(() => ask(Datastore.open(":memory:"))).code).toBe("unknown-meta");
  });

  it("refuses the 11th request in 24 h (the allowance is 10) and frees a slot when the first is over 24 h old", () => {
    const store = seeded();
    for (let i = 0; i < 10; i++) {
      const r = ask(store, { angle: `angle number ${i}` }, at(HOUR + i * 60_000));
      store.resolveAngleRequest(r.id, { status: "done", detail: "", proposalIds: [] }, at(HOUR + i * 60_000));
    }
    const e = refusal(() => ask(store, { angle: "angle number 10" }, at(2 * HOUR)));
    expect(e.code).toBe("daily-cap");
    expect(e.message).toMatch(/10 angle requests in 24 hours is the most \(10\)/);
    expect(store.memeAngleRequests()).toHaveLength(10);
    expect(ask(store, { angle: "angle number 10" }, at(HOUR + 24 * HOUR + 1)).id).toBe(11);
  });

  it("requests that ended refused, failed or capped do not spend the allowance, but every request counts toward a hard cap of 3 times it (ticket 16)", () => {
    const store = seeded();
    // 10 refused requests (Dexter, Muscle Mommy ...) leave the allowance whole: an 11th is accepted and, once done, counts.
    for (let i = 0; i < 10; i++) {
      const r = ask(store, { angle: `refused angle ${i}` }, at(HOUR + i * 60_000));
      store.resolveAngleRequest(r.id, { status: (["refused", "failed", "capped"] as const)[i % 3]!, detail: "no" }, at(HOUR + i * 60_000));
    }
    const next = ask(store, { angle: "a real one" }, at(2 * HOUR));
    store.resolveAngleRequest(next.id, { status: "done", detail: "3 ideas" }, at(2 * HOUR));
    // 11 requests so far; 19 more refused ones make 30, and the 31st is refused whatever became of the others.
    for (let i = 0; i < 19; i++) store.resolveAngleRequest(ask(store, { angle: `more refused ${i}` }, at(3 * HOUR + i * 60_000)).id, { status: "refused", detail: "no" }, at(3 * HOUR));
    const e = refusal(() => ask(store, { angle: "one too many" }, at(4 * HOUR)));
    expect(e.code).toBe("daily-cap");
    expect(e.message).toMatch(/30 angle requests in 24 hours, refused ones included, is the most \(3 times the allowance of 10\)/);
    expect(store.memeAngleRequests()).toHaveLength(20); // the list shows the last 20
  });

  it("an allowance of 10 done requests is refused with the allowance message while refused ones are still below the hard cap", () => {
    const store = seeded();
    for (let i = 0; i < 4; i++) store.resolveAngleRequest(ask(store, { angle: `refused ${i}` }, at(HOUR + i * 60_000)).id, { status: "refused", detail: "no" }, at(HOUR));
    for (let i = 0; i < 10; i++) store.resolveAngleRequest(ask(store, { angle: `done ${i}` }, at(2 * HOUR + i * 60_000)).id, { status: "done", detail: "3 ideas" }, at(2 * HOUR));
    expect(refusal(() => ask(store, { angle: "eleventh" }, at(3 * HOUR))).message).toMatch(/10 angle requests in 24 hours is the most \(10\)/);
  });

  it("the daily cap can only be lowered: maxPerDay 2 refuses the third; a larger value stops at the ceiling of 10", () => {
    const store = seeded();
    for (let i = 0; i < 2; i++) store.resolveAngleRequest(store.requestMemeAngle({ metaKey: "gta", angle: `a${i}`, sourceUrl: null }, { now: at(HOUR), maxPerDay: 2 }).id, { status: "done", detail: "" }, at(HOUR));
    expect(refusal(() => store.requestMemeAngle({ metaKey: "gta", angle: "a2", sourceUrl: null }, { now: at(HOUR), maxPerDay: 2 })).code).toBe("daily-cap");
    const other = seeded();
    for (let i = 0; i < MAX_MEME_ANGLE_PER_DAY; i++) other.resolveAngleRequest(other.requestMemeAngle({ metaKey: "gta", angle: `a${i}`, sourceUrl: null }, { now: at(HOUR), maxPerDay: 1000 }).id, { status: "done", detail: "" }, at(HOUR));
    expect(refusal(() => other.requestMemeAngle({ metaKey: "gta", angle: "one more", sourceUrl: null }, { now: at(HOUR), maxPerDay: 1000 })).code).toBe("daily-cap");
  });

  it("allows one pending request at a time: the second is refused until the first is resolved, for any Meta", () => {
    const store = seeded();
    const first = ask(store);
    const e = refusal(() => ask(store, { metaKey: "jensen", angle: "a different angle" }));
    expect(e.code).toBe("pending");
    expect(e.message).toMatch(/One request is waiting/);
    store.claimAngleRequest(first.id); // running still counts as waiting
    expect(refusal(() => ask(store, { metaKey: "jensen", angle: "a different angle" })).code).toBe("pending");
    store.resolveAngleRequest(first.id, { status: "done", detail: "", proposalIds: [4, 5, 6] }, at(HOUR));
    expect(ask(store, { metaKey: "jensen", angle: "a different angle" }).id).toBe(2);
  });

  it("refuses the same cleaned angle for the same Meta within 24 h; a different Meta, a different angle, or 24 h later is accepted", () => {
    const store = seeded();
    const first = ask(store, { angle: "Iguana Scooter" });
    store.resolveAngleRequest(first.id, { status: "done", detail: "" }, at(HOUR));
    const e = refusal(() => ask(store, { angle: "iguana scooter" }, at(2 * HOUR)));
    expect(e.code).toBe("duplicate");
    expect(e.message).toMatch(/already asked/);
    expect(store.memeAngleRequests()).toHaveLength(1);
    expect(ask(store, { metaKey: "jensen", angle: "iguana scooter" }, at(2 * HOUR)).id).toBe(2);
    store.resolveAngleRequest(2, { status: "done", detail: "" }, at(2 * HOUR));
    expect(ask(store, { angle: "iguana scooter two" }, at(3 * HOUR)).id).toBe(3);
    store.resolveAngleRequest(3, { status: "done", detail: "" }, at(3 * HOUR));
    expect(ask(store, { angle: "iguana scooter" }, at(HOUR + 24 * HOUR + 1)).id).toBe(4);
  });

  it("an angle that is empty or over the limit is refused by the store as well", () => {
    const store = seeded();
    expect(refusal(() => ask(store, { angle: "   " })).code).toBe("invalid");
    expect(refusal(() => ask(store, { angle: "x".repeat(ANGLE_MAX_CHARS + 1) })).code).toBe("invalid");
    expect(refusal(() => ask(store, { angle: "two\nlines" })).code).toBe("invalid");
    expect(store.memeAngleRequests()).toEqual([]);
  });
});

describe("claim, resolve and the list", () => {
  it("claims a pending request once, resolves it with a status, a reason and the Proposal ids, and lists newest first with only the shown columns", () => {
    const store = seeded();
    const r = ask(store, { sourceUrl: "https://example.com/a" });
    expect(store.pendingAngleRequests().map((x) => x.id)).toEqual([r.id]);
    expect(store.claimAngleRequest(r.id)).toMatchObject({ id: r.id, status: "running" });
    expect(store.claimAngleRequest(r.id)).toBeUndefined(); // not twice
    expect(store.pendingAngleRequests()).toEqual([]);
    store.resolveAngleRequest(r.id, { status: "done", detail: "3 ideas", proposalIds: [7, 8, 9] }, at(2 * HOUR));
    expect(store.getAngleRequest(r.id)).toMatchObject({ status: "done", detail: "3 ideas", proposalIds: [7, 8, 9], doneAt: at(2 * HOUR).toISOString() });
    const [row, ...rest] = store.memeAngleRequests();
    expect(rest).toEqual([]);
    expect(row).toEqual({ id: r.id, metaKey: "gta", status: "done", detail: "3 ideas", createdAt: at(HOUR).toISOString(), doneAt: at(2 * HOUR).toISOString(), proposalIds: [7, 8, 9], urlDropped: false });
  });

  it("lists at most 20, newest first", () => {
    const store = seeded();
    for (let i = 0; i < 25; i++) {
      // 25 h apart, so none counts against the daily cap of another
      const r = store.requestMemeAngle({ metaKey: "gta", angle: `angle ${i}`, sourceUrl: null }, { now: at(HOUR + i * 25 * HOUR) });
      store.resolveAngleRequest(r.id, { status: "done", detail: "" }, at(HOUR + i * 25 * HOUR));
    }
    const rows = store.memeAngleRequests();
    expect(rows).toHaveLength(20);
    expect(rows[0]!.id).toBe(25);
    expect(rows[19]!.id).toBe(6);
  });

  it("a request left running by a worker that died goes back to pending", () => {
    const store = seeded();
    const r = ask(store);
    store.claimAngleRequest(r.id);
    expect(store.requeueRunningAngleRequests()).toBe(1);
    expect(store.getAngleRequest(r.id)!.status).toBe("pending");
    expect(store.requeueRunningAngleRequests()).toBe(0);
  });

  it("a resolved request is not resolved again", () => {
    const store = seeded();
    const r = ask(store);
    store.resolveAngleRequest(r.id, { status: "refused", detail: "first" }, at(HOUR));
    store.resolveAngleRequest(r.id, { status: "done", detail: "second" }, at(HOUR));
    expect(store.getAngleRequest(r.id)).toMatchObject({ status: "refused", detail: "first" });
  });
});

describe("the schema", () => {
  it("is idempotent on a second open, and an old database without the table or the column opens, reads and gets them", () => {
    const path = join(tempDir("argus-angle-"), "old.db");
    const first = seeded(path);
    const idea = (n: number): NewMemeIdea => ({ name: `Old Idea ${["Alpha", "Bravo", "Charlie"][n]}`, ticker: ["OAA", "OBB", "OCC"][n]!, angle: "joke", difference: "d", description: "p", hook: "h", imageIdea: "i", riskLabels: [] });
    const snapshot: MetaSnapshot = { version: 1, capturedAt: at(0).toISOString(), meta: { key: "gta", label: "GTA 6", rank: 1, firstSeenAt: at(0).toISOString(), counts: { "6h": { tokens: 1, creators: 1, migrations: 0, migrationsAfter60s: 0 }, "24h": { tokens: 1, creators: 1, migrations: 0, migrationsAfter60s: 0 } }, topTokens: [] }, run: { id: 1, computedAt: at(0).toISOString(), window: "24h", baseMigrationRate: null, coverage: null }, hot: { reason: "r", raisedAt: at(0).toISOString(), rank: 1, creators: 1 }, roomLeft: { passed: true, text: "t" }, tokens: [], news: [] };
    const trio: NewMemeTrio = { metaKey: "gta", metaLabel: "GTA 6", snapshot, reason: "Hot now: r", summary: "s", evidenceLinks: [], ideas: [idea(0), idea(1), idea(2)] };
    const made = first.createMemeProposals(trio, { now: at(0) });
    first.close();
    // Make it the database of before this change: no table, no column.
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE meme_angle_requests");
    raw.exec("ALTER TABLE proposals DROP COLUMN operator_angle");
    raw.close();
    const reopened = Datastore.open(path);
    expect(reopened.memeAngleRequests()).toEqual([]);
    expect(reopened.getProposal(made[0]!.id)).toMatchObject({ name: "Old Idea Alpha", operatorAngle: null });
    expect(reopened.liveMemeProposals().map((p) => p.operatorAngle)).toEqual([null, null, null]);
    expect(ask(reopened).status).toBe("pending");
    reopened.close();
    const again = Datastore.open(path); // a second open changes nothing
    expect(again.memeAngleRequests()).toHaveLength(1);
    again.close();
  });
});

describe("parseAngle: what the form's text becomes", () => {
  it("cleans the text to one line, splits the first http(s) link out and replaces it by its host", () => {
    const r = parseAngle("GTA 6 iguana: official screenshot https://www.rockstargames.com/VI/only-in-leonida shows an iguana\n walking in front of a mobility scooter");
    expect(r).toEqual({ ok: true, angle: "GTA 6 iguana: official screenshot www.rockstargames.com shows an iguana walking in front of a mobility scooter", sourceUrl: "https://www.rockstargames.com/VI/only-in-leonida", urlDropped: false });
  });

  it("a trailing full stop or comma is not part of the link", () => {
    expect(parseAngle("see https://example.com/a/b.")).toMatchObject({ ok: true, angle: "see example.com.", sourceUrl: "https://example.com/a/b" });
  });

  it("a link with credentials is dropped from the stored URL and the page is told", () => {
    expect(parseAngle("see https://user:pw@example.com/x now")).toEqual({ ok: true, angle: "see example.com now", sourceUrl: null, urlDropped: true });
  });

  it("a javascript: address is no http(s) link: the text stays text, nothing is stored as a link", () => {
    expect(parseAngle("click javascript:alert(1) for the joke")).toEqual({ ok: true, angle: "click javascript:alert(1) for the joke", sourceUrl: null, urlDropped: false });
  });

  it("control characters and newlines are flattened; empty, whitespace, non-string and over-long text is refused with the reason", () => {
    expect(parseAngle("a\u0000b‮c\r\nd")).toMatchObject({ ok: true, angle: "a b c d" });
    expect(parseAngle("   ")).toMatchObject({ ok: false, problem: expect.stringMatching(/empty/) });
    expect(parseAngle(42)).toMatchObject({ ok: false });
    expect(parseAngle("x".repeat(600))).toMatchObject({ ok: true });
    expect(parseAngle("x".repeat(601))).toMatchObject({ ok: false, problem: expect.stringMatching(/600/) });
    expect(parseAngle("x".repeat(100_000))).toMatchObject({ ok: false });
  });
});

describe("ARGUS_MEME_ANGLE_MAX_PER_DAY", () => {
  it("defaults to 10, may only be lowered, and 10 is the ceiling; anything else is an error", () => {
    expect(memeAngleConfigFromEnv({}).maxPerDay).toBe(10);
    expect(memeAngleConfigFromEnv({ ARGUS_MEME_ANGLE_MAX_PER_DAY: "" }).maxPerDay).toBe(10);
    expect(memeAngleConfigFromEnv({ ARGUS_MEME_ANGLE_MAX_PER_DAY: "2" }).maxPerDay).toBe(2);
    expect(memeAngleConfigFromEnv({ ARGUS_MEME_ANGLE_MAX_PER_DAY: "10" }).maxPerDay).toBe(10);
    for (const bad of ["0", "-1", "1.5", "11", "many"]) expect(() => memeAngleConfigFromEnv({ ARGUS_MEME_ANGLE_MAX_PER_DAY: bad })).toThrow(/ARGUS_MEME_ANGLE_MAX_PER_DAY/);
  });
});
