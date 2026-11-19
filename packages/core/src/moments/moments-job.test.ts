import { describe, expect, it } from "vitest";
import { Datastore } from "../datastore.ts";
import { createMomentJob } from "./job.ts";
import { momentQueries, type MomentTopic, type ScanTarget } from "./query.ts";
import type { MomentRunner, PageResult, PlanItem, RunnerResult } from "./scan-runner.ts";
import type { MomentSettings } from "./settings.ts";

// The worker's scan step with a fake runner: no child process, no Chrome, no X.
const T0 = new Date("2026-11-19T15:00:00Z");
const MIN = 60_000;
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);
const TOPIC: MomentTopic = { label: "GTA VI", startsAt: "2026-11-19T05:00:00Z", spellings: ["GTA VI", "GTA 6", "GTA6"] };
const settings = (over: Partial<MomentSettings> = {}): MomentSettings => ({ enabled: true, intervalMinutes: 30, loadsPerDay: 100, topic: TOPIC, ...over });
const idAt = (minutes: number, seq: number) => ((BigInt(T0.getTime() + minutes * MIN - 1_288_834_974_657) << 22n) | BigInt(seq)).toString();
const counts = (views: number) => ({ replies: 1, reposts: 2, likes: 30, bookmarks: 4, views });
const post = (seq: number, views: number, handle = "alice") => ({ statusId: idAt(-120, seq), handle, text: `clip ${seq}`, hasVideo: true, counts: counts(views) });
const okPage = (id: string, posts: PageResult["posts"] = []): PageResult => ({ id, status: "ok", signals: [], posts, error: "" });

function rig(answer: (plan: PlanItem[], call: number) => RunnerResult | Promise<RunnerResult>, s: MomentSettings = settings(), extra: { dryRun?: boolean; targetsOf?: (t: MomentTopic) => ScanTarget[] } = {}) {
  const store = Datastore.open(":memory:");
  const plans: PlanItem[][] = [];
  const runner: MomentRunner = async (plan) => {
    plans.push([...plan]);
    return answer([...plan], plans.length - 1);
  };
  let clock = T0;
  const sent: string[] = [];
  const job = createMomentJob({ store, settings: s, runner, notifier: { notify: (t) => void sent.push(t) }, now: () => clock, ...extra });
  return { store, plans, sent, job, setNow: (d: Date) => void (clock = d) };
}
const clean = (posts: PageResult["posts"] = []) => (plan: PlanItem[]): RunnerResult => ({ kind: "ran", pages: plan.map((p) => okPage(p.id, posts)), stopped: null, selectorsFoundNothing: false, reason: "" });

describe("a scan", () => {
  it("loads the topic's two search pages, stores the posts and one reading each, and records the scan", async () => {
    const posts = [post(1, 130_000), post(2, 30_000, "bob")]; // 2 h old: 65,000 and 15,000 views an hour
    const r = rig(clean(posts));
    const res = await r.job();
    expect(res).toMatchObject({ status: "ok", loads: 2, newPosts: 2, readings: 2 }); // the Latest page repeats the Top page's posts: same scan, same reading
    expect(r.plans).toEqual([momentQueries(TOPIC).map((t) => ({ id: t.id, url: t.url }))]);
    expect(r.store.moments.lastScan()).toMatchObject({ at: T0.toISOString(), topic: "GTA VI", status: "ok", loads: 2, signals: [], reason: "" });
    r.setNow(at(30));
    expect(await r.job()).toMatchObject({ status: "ok", loads: 2, newPosts: 0, readings: 2 }); // a second scan adds a reading for each post and no new post
    expect(r.store.momentsView(at(31)).rising.map((p) => [p.handle, p.readings])).toEqual([["alice", 2]]);
  });

  it("a new post of a later scan is added, with the first scan's posts left alone", async () => {
    let n = 0;
    const r = rig((plan) => clean(n++ === 0 ? [post(1, 90_000)] : [post(1, 120_000), post(3, 95_000, "cara")])(plan));
    await r.job();
    r.setNow(at(30));
    expect(await r.job()).toMatchObject({ newPosts: 1, readings: 2 });
  });

  it("a scan the child could not do (it crashed, timed out) is recorded as an error with the reason, and stops no one", async () => {
    const r = rig(() => ({ kind: "failed", pages: [], stopped: null, selectorsFoundNothing: false, reason: "the scanner ran past 720 s and was stopped" }));
    expect(await r.job()).toMatchObject({ status: "error", loads: 0 });
    expect(r.store.moments.lastScan()).toMatchObject({ status: "error", reason: "the scanner ran past 720 s and was stopped" });
    expect(r.store.xSession.state(T0).status).toBe("ok");
    expect(r.sent).toEqual([]);
  });

  it("a page where the selectors found nothing is recorded as that, stops no one and sends nothing", async () => {
    const r = rig(() => ({ kind: "ran", pages: [okPage("top", [post(1, 90_000)]), { id: "live", status: "selectors_found_nothing", signals: [], posts: [], error: "" }], stopped: null, selectorsFoundNothing: true, reason: "" }));
    expect(await r.job()).toMatchObject({ status: "selectors_found_nothing", loads: 2, newPosts: 1 }); // the page before it was read fine and is kept
    expect(r.store.xSession.state(T0).status).toBe("ok");
    expect(r.sent).toEqual([]);
  });

  it("an invalid plan of the child (refused) is an error row", async () => {
    const r = rig(() => ({ kind: "refused", pages: [], stopped: null, selectorsFoundNothing: false, reason: "refused: not a search page" }));
    expect(await r.job()).toMatchObject({ status: "error" });
  });
});

describe("a locked profile", () => {
  it("records 'skipped: browser busy', loads nothing, and the next scan tries again", async () => {
    let call = 0;
    const r = rig((plan) => (call++ === 0 ? { kind: "locked", pages: [], stopped: null, selectorsFoundNothing: false, reason: "held" } : clean()(plan)));
    expect(await r.job()).toMatchObject({ status: "skipped", loads: 0, note: "browser busy" });
    expect(r.store.moments.lastScan()).toMatchObject({ status: "skipped", loads: 0, reason: "browser busy" });
    expect(r.store.moments.loadsSince(at(-60).toISOString())).toBe(0);
    r.setNow(at(30));
    expect(await r.job()).toMatchObject({ status: "ok", loads: 2 });
    expect(r.sent).toEqual([]);
    expect(r.store.xSession.state(at(30)).status).toBe("ok"); // a busy browser is not a signal
  });
});

describe("a STOP signal stops the day", () => {
  it("stores what was read before the wall, stops the account, and the next scans load nothing until the probe", async () => {
    let call = 0;
    const r = rig((plan) => (call++ === 0 ? { kind: "ran", pages: [okPage("top", [post(1, 90_000)]), { id: "live", status: "login_wall", signals: ["login_wall"], posts: [], error: "" }], stopped: "login_wall", selectorsFoundNothing: false, reason: "" } : clean()(plan)));
    expect(await r.job()).toMatchObject({ status: "stopped", loads: 2, newPosts: 1 });
    expect(r.store.xSession.state(T0)).toMatchObject({ status: "stopped", reason: "login_wall" });
    expect(r.sent).toHaveLength(1);
    for (const m of [30, 60, 120, 300]) {
      r.setNow(at(m));
      expect(await r.job()).toMatchObject({ status: "skipped", loads: 0 });
    }
    expect(r.plans).toHaveLength(1);
    // the next UTC day: one probe load (the topic's own search page), then back to normal
    r.setNow(new Date("2026-11-20T00:30:00Z"));
    expect(await r.job()).toMatchObject({ status: "ok", loads: 1 });
    expect(r.plans[1]).toHaveLength(1);
    r.setNow(new Date("2026-11-20T01:00:00Z"));
    expect(await r.job()).toMatchObject({ status: "ok", loads: 2 });
  });
});

describe("the daily load cap", () => {
  const eight = (topic: MomentTopic): ScanTarget[] => Array.from({ length: 8 }, (_, i) => ({ ...momentQueries(topic)[i % 2]!, id: i % 2 === 0 ? "top" : "live" }));

  it("is never exceeded: 12 scans of 8 loads use 96 and the 13th is cut to the 4 loads left; then none", async () => {
    const r = rig(clean(), settings(), { targetsOf: eight });
    let total = 0;
    for (let i = 0; i < 13; i++) {
      r.setNow(at(i * 30));
      const res = await r.job();
      total += res.loads;
      if (i < 12) expect(res.loads, `scan ${i + 1}`).toBe(8);
    }
    expect(r.plans[12]).toHaveLength(4);
    expect(total).toBe(100);
    r.setNow(at(13 * 30));
    expect(await r.job()).toMatchObject({ status: "skipped", loads: 0, note: expect.stringContaining("daily load cap reached (100") });
    expect(r.plans).toHaveLength(13);
    expect(r.store.moments.loadsSince(at(-1).toISOString())).toBe(100);
  });

  it("is a rolling 24 hours: loads from a day ago stop counting", async () => {
    const r = rig(clean(), settings({ loadsPerDay: 4 }));
    await r.job();
    r.setNow(at(30));
    await r.job();
    r.setNow(at(60));
    expect(await r.job()).toMatchObject({ status: "skipped" });
    r.setNow(at(24 * 60 + 1)); // the first scan is more than a day old
    expect(await r.job()).toMatchObject({ status: "ok", loads: 2 });
  });

  it("a cap lowered by ARGUS_MOMENT_LOADS_PER_DAY (50) holds the same way", async () => {
    const r = rig(clean(), settings({ loadsPerDay: 50 }));
    let total = 0;
    for (let i = 0; i < 40; i++) {
      r.setNow(at(i * 30));
      total += (await r.job()).loads;
    }
    expect(total).toBe(50);
  });

  it("the default scan of two pages is cut to one when one load is left", async () => {
    const r = rig(clean(), settings({ loadsPerDay: 3 }));
    await r.job();
    r.setNow(at(30));
    expect(await r.job()).toMatchObject({ status: "ok", loads: 1 });
    expect(r.plans[1]).toEqual([{ id: "top", url: momentQueries(TOPIC)[0]!.url }]);
  });
});

describe("off, dry run and overlap", () => {
  it("the switch off spawns nothing and writes nothing", async () => {
    const r = rig(clean(), settings({ enabled: false, topic: null }));
    expect(await r.job()).toMatchObject({ status: "off", loads: 0 });
    expect(r.plans).toEqual([]);
    expect(r.store.moments.scans()).toEqual([]);
  });

  it("a dry run spawns nothing and writes nothing", async () => {
    const r = rig(clean(), settings(), { dryRun: true });
    expect(await r.job()).toMatchObject({ status: "dry-run", loads: 0 });
    expect(r.plans).toEqual([]);
    expect(r.store.moments.scans()).toEqual([]);
    expect(r.store.xSession.state(T0).status).toBe("ok");
  });

  it("two scans never overlap: one that starts while another runs does nothing", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const r = rig(async (plan) => {
      await held;
      return clean()(plan);
    });
    const first = r.job();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await r.job()).toMatchObject({ status: "overlap", loads: 0 });
    release();
    expect(await first).toMatchObject({ status: "ok", loads: 2 });
    expect(r.plans).toHaveLength(1);
    expect(r.store.moments.scans()).toHaveLength(1);
    expect(await r.job()).toMatchObject({ status: "ok" }); // and the next one can run
  });

  it("a topic that cannot be searched is an error row and no load", async () => {
    const r = rig(clean(), settings({ topic: { label: "x", startsAt: "2026-11-19T05:00:00Z", spellings: ["---"] } }));
    expect(await r.job()).toMatchObject({ status: "error", loads: 0 });
    expect(r.plans).toEqual([]);
  });
});
