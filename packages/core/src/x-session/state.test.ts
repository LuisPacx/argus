import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import { applyXSessionResumes, createMomentJob, probePlan } from "../moments/job.ts";
import { momentQueries, type MomentTopic } from "../moments/query.ts";
import type { MomentRunner, PageResult, RunnerResult } from "../moments/scan-runner.ts";
import type { MomentSettings } from "../moments/settings.ts";
// @ts-expect-error plain .mjs module, no types
import { isAllowedXUrl } from "../x-capture/urls.mjs";
import { isXStopSignal, nextUtcMidnight, runXJob, X_STOP_SIGNALS, xStopText, XSessionRefusedError } from "./state.ts";

// Fake clock throughout: every call is given its time.
const DAY = 24 * 3_600_000;
const D0 = new Date("2026-11-19T15:00:00Z");
const at = (ms: number) => new Date(D0.getTime() + ms);
const TOPIC: MomentTopic = { label: "GTA VI", startsAt: "2026-11-19T05:00:00Z", spellings: ["GTA VI", "GTA 6", "GTA6"] };
const SETTINGS: MomentSettings = { enabled: true, intervalMinutes: 30, loadsPerDay: 100, topic: TOPIC };

const page = (id: string, status = "ok", posts: PageResult["posts"] = []): PageResult => ({ id, status, signals: status === "ok" ? [] : [status], posts, error: "" });
const ran = (pages: PageResult[], stopped: string | null = null): RunnerResult => ({ kind: "ran", pages, stopped, selectorsFoundNothing: false, reason: "" });
const clean = () => ran([page("top"), page("live")]);
const wall = (signal: string) => ran([page("top", signal)], signal);

function rig(answer: (plan: Array<{ id: string; url: string }>, call: number) => RunnerResult) {
  const store = Datastore.open(":memory:");
  const plans: Array<Array<{ id: string; url: string }>> = [];
  const sent: string[] = [];
  const runner: MomentRunner = async (plan) => {
    plans.push([...plan]);
    return answer([...plan], plans.length - 1);
  };
  const job = (now: Date) => createMomentJob({ store, settings: SETTINGS, runner, notifier: { notify: (t) => void sent.push(t) }, now: () => now })();
  return { store, plans, sent, job };
}

describe("a STOP signal", () => {
  it.each(X_STOP_SIGNALS.map((s) => [s]))("%s sets stopped until 00:00 UTC and sends exactly one message", async (signal) => {
    const r = rig(() => wall(signal));
    const res = await r.job(D0);
    expect(res).toMatchObject({ status: "stopped", loads: 1 });
    expect(r.store.xSession.state(D0)).toEqual({ status: "stopped", reason: signal, stoppedAt: D0.toISOString(), resumeAt: "2026-11-20T00:00:00.000Z", strikes: 1, probeDue: false });
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toContain(signal);
    expect(r.sent[0]).toContain("00:00 UTC");
    expect(r.store.moments.lastScan()).toMatchObject({ status: "stopped", signals: [signal] });
  });

  it("not_found and target_suspended pages are recorded but stop nothing and send nothing", async () => {
    for (const status of ["not_found", "suspended", "target_suspended"]) {
      const r = rig(() => ran([page("top", status), page("live")]));
      expect((await r.job(D0)).status).toBe("ok");
      expect(r.store.xSession.state(D0).status).toBe("ok");
      expect(r.sent).toEqual([]);
    }
    const store = Datastore.open(":memory:");
    for (const s of ["not_found", "target_suspended", "suspended", "ok", "error", "selectors_found_nothing", ""]) {
      expect(isXStopSignal(s), s).toBe(false);
      expect(store.xSession.recordStop(s, D0), s).toBeNull();
    }
    expect(store.xSession.state(D0).status).toBe("ok");
  });

  it("the message is plain text with nothing from X in it", () => {
    for (const s of X_STOP_SIGNALS) {
      expect(xStopText(s, "2026-11-20T00:00:00.000Z")).toContain("until 00:00 UTC");
      expect(xStopText(s, null)).toContain("press Resume");
    }
  });

  it("midnight is the next UTC midnight, also at 23:59:59 and exactly at 00:00:00", () => {
    expect(nextUtcMidnight(new Date("2026-11-19T23:59:59Z")).toISOString()).toBe("2026-11-20T00:00:00.000Z");
    expect(nextUtcMidnight(new Date("2026-11-20T00:00:00Z")).toISOString()).toBe("2026-11-21T00:00:00.000Z");
    expect(nextUtcMidnight(new Date("2026-12-31T12:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("while stopped, any X job loads nothing", () => {
  it("the scanner loads nothing and records why; a stand-in Study job is not even called", async () => {
    const r = rig(() => wall("login_wall"));
    await r.job(D0);
    expect(r.plans).toHaveLength(1);
    for (const later of [at(30 * 60_000), at(3 * 3_600_000), at(8 * 3_600_000)]) {
      expect(await r.job(later)).toMatchObject({ status: "skipped", loads: 0 });
    }
    expect(r.plans).toHaveLength(1); // the runner was never asked again
    expect(r.store.moments.lastScan()).toMatchObject({ status: "skipped", loads: 0, reason: expect.stringContaining("stopped for the day (login_wall)") });
    let studyLoads = 0;
    const study = await runXJob(r.store.xSession, at(30 * 60_000), async () => void studyLoads++);
    expect(study).toEqual({ ran: false, reason: "login_wall", resumeAt: "2026-11-20T00:00:00.000Z" });
    expect(studyLoads).toBe(0);
  });

  it("the reverse: a stop that the stand-in Study job records pauses the scanner", async () => {
    const r = rig(() => clean());
    r.store.xSession.recordStop("challenge", D0); // what the Study's capture would do on the same signal
    expect(await r.job(at(60_000))).toMatchObject({ status: "skipped", loads: 0 });
    expect(r.plans).toEqual([]);
  });

  it("an ok state lets a job through in go mode", async () => {
    const store = Datastore.open(":memory:");
    expect(await runXJob(store.xSession, D0, async (mode) => mode)).toEqual({ ran: true, mode: "go", result: "go" });
  });
});

describe("the next UTC day: one probe load", () => {
  const nextDay = at(10 * 3_600_000); // 2026-11-20 01:00 UTC

  it("makes exactly one load, the topic's own search page and never a profile page, and a clean probe clears the stop", async () => {
    const r = rig((p, call) => (call === 0 ? wall("login_wall") : ran(p.map((x) => page(x.id)))));
    await r.job(D0);
    expect(r.store.xSession.state(nextDay).probeDue).toBe(true);
    const probe = await r.job(nextDay);
    expect(probe).toMatchObject({ status: "ok", loads: 1 });
    expect(r.plans[1]).toHaveLength(1);
    const [only] = r.plans[1]!;
    expect(only).toEqual({ id: "top", url: momentQueries(TOPIC)[0]!.url });
    expect(isAllowedXUrl(only!.url)).toBe(true); // on the allowlist, which has no profile page
    expect(isAllowedXUrl("https://x.com/someone")).toBe(false);
    expect(new URL(only!.url).pathname).toBe("/search");
    expect(r.store.xSession.state(nextDay)).toMatchObject({ status: "ok", reason: "", resumeAt: null, probeDue: false });
    expect(r.store.moments.lastScan()).toMatchObject({ loads: 1, reason: expect.stringContaining("probe") });
    // the probe load is counted in the day's loads, and the scan after it is a normal one of two loads
    expect(r.store.moments.loadsSince(new Date(nextDay.getTime() - DAY).toISOString())).toBe(2);
    expect(await r.job(at(10 * 3_600_000 + 30 * 60_000))).toMatchObject({ status: "ok", loads: 2 });
    expect(r.plans[2]).toHaveLength(2);
  });

  it("a probe that is not clean spends the probe: no second load that day, one more after the next midnight", async () => {
    const r = rig((_p, call) => (call === 0 ? wall("rate_limited") : call === 1 ? ran([{ ...page("top", "error"), error: "timeout" }]) : ran([page("top")])));
    await r.job(D0);
    expect(await r.job(nextDay)).toMatchObject({ status: "error", loads: 1 });
    expect(r.store.xSession.state(nextDay)).toMatchObject({ status: "stopped", probeDue: false, resumeAt: "2026-11-21T00:00:00.000Z" });
    expect(await r.job(at(11 * 3_600_000))).toMatchObject({ status: "skipped", loads: 0 });
    expect(r.plans).toHaveLength(2);
    const dayAfter = at(34 * 3_600_000); // 2026-11-21 01:00 UTC
    expect(r.store.xSession.state(dayAfter).probeDue).toBe(true);
    expect(await r.job(dayAfter)).toMatchObject({ status: "ok", loads: 1 });
    expect(r.store.xSession.state(dayAfter).status).toBe("ok");
  });

  it("a probe that finds the browser busy is not spent: the next job can still make it", async () => {
    let calls = 0;
    const r = rig(() => {
      calls++;
      if (calls === 1) return wall("login_wall");
      if (calls === 2) return { kind: "locked", pages: [], stopped: null, selectorsFoundNothing: false, reason: "held" };
      return ran([page("top")]);
    });
    await r.job(D0);
    expect(await r.job(nextDay)).toMatchObject({ status: "skipped", loads: 0, note: "browser busy" });
    expect(r.store.xSession.state(nextDay).probeDue).toBe(true);
    expect(await r.job(at(10 * 3_600_000 + 30 * 60_000))).toMatchObject({ status: "ok", loads: 1 });
    expect(r.store.xSession.state(nextDay).status).toBe("ok");
  });

  it("a STOP signal on the probe stops again, with no resume time (second within 7 days)", async () => {
    const r = rig(() => wall("challenge"));
    await r.job(D0);
    await r.job(nextDay);
    const s = r.store.xSession.state(nextDay);
    expect(s).toMatchObject({ status: "stopped", reason: "challenge", resumeAt: null, strikes: 2, probeDue: false });
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1]).toContain("press Resume");
  });
});

describe("a second STOP within 7 days waits for the Operator", () => {
  it("stays stopped across days, with no probe, until Resume", async () => {
    const r = rig((_p, call) => (call < 2 ? wall("login_wall") : clean()));
    await r.job(D0); // first stop
    await r.job(at(DAY)); // the probe hits a wall: second stop, 1 day after the first
    for (const day of [2, 3, 5, 9]) {
      expect(r.store.xSession.state(at(day * DAY)).probeDue, `day ${day}`).toBe(false);
      expect(await r.job(at(day * DAY + 3_600_000))).toMatchObject({ status: "skipped", loads: 0 });
    }
    expect(r.plans).toHaveLength(2);
    expect(r.store.xSession.state(at(9 * DAY))).toMatchObject({ status: "stopped", resumeAt: null });
    // Resume: the press is recorded; the worker clears the state on its next tick
    const press = r.store.xSession.requestResume(at(9 * DAY));
    expect(r.store.xSession.state(at(9 * DAY)).status).toBe("stopped"); // the press alone changes nothing
    expect(r.store.xSession.pendingResumes()).toEqual([{ id: press.id, createdAt: at(9 * DAY).toISOString(), status: "pending", appliedAt: null }]);
    expect(applyXSessionResumes(r.store, at(9 * DAY + 30_000))).toBe(true);
    expect(r.store.xSession.state(at(9 * DAY + 30_000))).toMatchObject({ status: "ok", reason: "", resumeAt: null });
    expect(r.store.xSession.resumeRequests()).toEqual([{ id: press.id, createdAt: at(9 * DAY).toISOString(), status: "applied", appliedAt: at(9 * DAY + 30_000).toISOString() }]);
    expect(await r.job(at(9 * DAY + 3_600_000))).toMatchObject({ status: "ok", loads: 2 });
  });

  it("a STOP exactly 7 days after the last is still a second one; after 8 days it is a first one again", () => {
    const store = Datastore.open(":memory:");
    store.xSession.recordStop("login_wall", D0);
    store.xSession.clearOnCleanProbe();
    const seven = store.xSession.recordStop("login_wall", at(7 * DAY))!;
    expect(seven.repeated).toBe(true);
    expect(seven.state).toMatchObject({ strikes: 2, resumeAt: null });
    const fresh = Datastore.open(":memory:");
    fresh.xSession.recordStop("login_wall", D0);
    fresh.xSession.clearOnCleanProbe();
    const eight = fresh.xSession.recordStop("challenge", at(8 * DAY))!;
    expect(eight.repeated).toBe(false);
    expect(eight.state).toMatchObject({ strikes: 1, reason: "challenge", resumeAt: nextUtcMidnight(at(8 * DAY)).toISOString() });
  });

  it("a Resume does not forget the window: a STOP soon after is a second one", () => {
    const store = Datastore.open(":memory:");
    store.xSession.recordStop("login_wall", D0);
    store.xSession.recordStop("login_wall", at(DAY)); // second: manual
    store.xSession.requestResume(at(2 * DAY));
    store.xSession.applyResumes(at(2 * DAY));
    const third = store.xSession.recordStop("rate_limited", at(3 * DAY))!;
    expect(third.repeated).toBe(true);
    expect(third.state).toMatchObject({ strikes: 3, resumeAt: null });
  });
});

describe("Resume", () => {
  it("is refused unless the state is stopped, and writes nothing then", () => {
    const store = Datastore.open(":memory:");
    expect(() => store.xSession.requestResume(D0)).toThrow(XSessionRefusedError);
    expect(store.xSession.resumeRequests()).toEqual([]);
    expect(() => store.requestXSessionResume(D0)).toThrow(/not stopped/);
  });

  it("every press is a row, and one tick applies them all", () => {
    const store = Datastore.open(":memory:");
    store.xSession.recordStop("locked", D0);
    store.requestXSessionResume(at(60_000));
    store.requestXSessionResume(at(120_000));
    expect(store.xSession.resumeRequests()).toHaveLength(2);
    expect(applyXSessionResumes(store, at(150_000))).toBe(true);
    expect(store.xSession.pendingResumes()).toEqual([]);
    expect(applyXSessionResumes(store, at(180_000))).toBe(false); // nothing waiting
    expect(store.xSession.state(at(180_000)).status).toBe("ok");
  });

  it("an earlier press never clears a newer stop, the second stop that waits for Resume least of all; a press made after it does", () => {
    const store = Datastore.open(":memory:");
    store.xSession.recordStop("login_wall", D0);
    const early = store.xSession.requestResume(at(60_000)); // never applied: the worker was down
    store.xSession.clearOnCleanProbe(); // a probe cleared the first stop meanwhile
    store.xSession.recordStop("challenge", at(DAY)); // within 7 days: no resume time
    expect(store.xSession.state(at(DAY)).resumeAt).toBeNull();
    expect(applyXSessionResumes(store, at(DAY + 30_000))).toBe(false);
    expect(store.xSession.state(at(DAY + 30_000))).toMatchObject({ status: "stopped", reason: "challenge", resumeAt: null });
    expect(store.xSession.resumeRequests()[0]).toMatchObject({ id: early.id, status: "applied" }); // spent, not kept for later
    store.xSession.requestResume(at(DAY + 60_000));
    expect(applyXSessionResumes(store, at(DAY + 90_000))).toBe(true);
    expect(store.xSession.state(at(DAY + 90_000)).status).toBe("ok");
  });

  it("a press for a stop that was cleared meanwhile is marked applied and changes nothing", () => {
    const store = Datastore.open(":memory:");
    store.xSession.recordStop("locked", D0);
    store.requestXSessionResume(at(60_000));
    store.xSession.clearOnCleanProbe();
    expect(applyXSessionResumes(store, at(90_000))).toBe(false);
    expect(store.xSession.resumeRequests()[0]).toMatchObject({ status: "applied" });
  });
});

describe("probePlan", () => {
  it("is the first search address of the topic and nothing else", () => {
    const targets = momentQueries(TOPIC);
    expect(probePlan(targets)).toEqual([targets[0]]);
    expect(probePlan([])).toEqual([]);
  });
});
