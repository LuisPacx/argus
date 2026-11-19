import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module, no types
import { EXIT, planProblem, runScan } from "./scan.mjs";
// @ts-expect-error plain .mjs module, no types
import { loadPage } from "./session.mjs";

// The scanner's loop with fake page facts, a fake lock and a fake browser: no real Chrome. (The real child process is exercised in
// moments/scan-runner.test.ts up to the point where Chrome would open.)
const SEARCH = (f: string) => `https://x.com/search?q=gta&f=${f}`;
const ID = "2123280111864811617";

const article = (n = 0) => ({
  statusLinks: [`/alice/status/${ID.slice(0, -1)}${n}`],
  handle: "alice",
  innerText: "Alice",
  bodyText: "a clip",
  countsLabel: "1 replies, 2 reposts, 3 likes, 4 bookmarks, 50000 views",
  hasVideo: true,
  promoted: false,
});
const facts = (over: Record<string, unknown> = {}) => ({ url: "https://x.com/search?q=gta&f=top", text: "", loggedIn: true, hasLoginButton: false, hasChallengeWidget: false, articleCount: 1, emptyState: false, httpStatus: 200, articles: [article()], ...over });

const WALLS: Array<[string, Record<string, unknown>]> = [
  ["login_wall", { url: "https://x.com/i/flow/login", loggedIn: false, hasLoginButton: true, articleCount: 0, articles: [] }],
  ["challenge", { url: "https://x.com/i/flow/consent", articleCount: 0, articles: [] }],
  ["locked", { url: "https://x.com/account/access", articleCount: 0, articles: [] }],
  ["own_suspended", { url: "https://x.com/account/suspended", articleCount: 0, articles: [] }],
  ["rate_limited", { text: "Rate limit exceeded", articleCount: 0, articles: [] }],
];

function harness(pages: Array<Record<string, unknown> | Error>, over: { lock?: () => unknown; plan?: unknown } = {}) {
  const log = { opened: 0, closed: 0, loaded: [] as string[], scrolls: [] as number[], sleeps: [] as number[], emitted: [] as Array<Record<string, unknown>> };
  let i = 0;
  const run = () =>
    runScan({
      plan: over.plan ?? [{ id: "top", url: SEARCH("top") }, { id: "live", url: SEARCH("live") }, { id: "x", url: "https://x.com/someone/status/2123280111864811617" }],
      lock: over.lock ?? (() => null),
      open: async () => {
        log.opened++;
        return {
          load: async (url: string, o: { scrolls: number }) => {
            log.loaded.push(url);
            log.scrolls.push(o.scrolls);
            const p = pages[Math.min(i++, pages.length - 1)]!;
            if (p instanceof Error) throw p;
            return p;
          },
          close: async () => void log.closed++,
        };
      },
      emit: (o: Record<string, unknown>) => log.emitted.push(o),
      sleep: async (ms: number) => void log.sleeps.push(ms),
      jitter: (lo: number, hi: number) => (lo + hi) / 2,
    });
  return { log, run };
}

describe("the plan", () => {
  it("an address outside the two allowed shapes is refused before any load, any lock check and any browser", async () => {
    let lockAsked = 0;
    for (const bad of ["https://x.com/someone", "https://x.com/home", "https://evil.example/search?q=a&f=top", "javascript:alert(1)", "https://x.com/search?q=a&f=user"]) {
      const h = harness([facts()], { plan: [{ id: "a", url: SEARCH("top") }, { id: "b", url: bad }], lock: () => (lockAsked++, null) });
      const r = await h.run();
      expect(r.exit, bad).toBe(EXIT.refused);
      expect(h.log.opened, bad).toBe(0);
      expect(h.log.loaded, bad).toEqual([]);
      expect(h.log.emitted).toEqual([{ done: true, exit: EXIT.refused, loads: 0, reason: expect.stringContaining("refused") }]);
    }
    expect(lockAsked).toBe(0);
  });

  it("refuses a plan that is not a list, is empty, has an item that is not { id, url }, or is over 8 loads", () => {
    expect(planProblem("x")).toMatch(/non-empty list/);
    expect(planProblem([])).toMatch(/non-empty list/);
    expect(planProblem([{ id: 1, url: SEARCH("top") }])).toMatch(/\{ id, url \}/);
    expect(planProblem([null])).toMatch(/\{ id, url \}/);
    expect(planProblem(Array.from({ length: 9 }, () => ({ id: "a", url: SEARCH("top") })))).toMatch(/at most 8/);
    expect(planProblem(Array.from({ length: 8 }, () => ({ id: "a", url: SEARCH("top") })))).toBeNull();
  });
});

describe("the lock", () => {
  it("a held lock exits 3 with no load and no browser", async () => {
    const h = harness([facts()], { lock: () => ({ pid: 4242, alive: true, stale: false }) });
    const r = await h.run();
    expect(r).toEqual({ exit: EXIT.locked, loads: 0, stopped: null });
    expect(h.log.opened).toBe(0);
    expect(h.log.loaded).toEqual([]);
  });

  it("a stale lock (its process is gone) does not stop the scan", async () => {
    const h = harness([facts()], { lock: () => ({ pid: 1, alive: false, stale: true }) });
    expect((await h.run()).exit).toBe(EXIT.ok);
  });
});

describe("the loop", () => {
  it("loads each address once, serially, with the browser opened once and closed once, and prints one line per page and a last line", async () => {
    const h = harness([facts(), facts({ url: SEARCH("live") }), facts()]);
    const r = await h.run();
    expect(r).toEqual({ exit: EXIT.ok, loads: 3, stopped: null });
    expect(h.log.loaded).toEqual([SEARCH("top"), SEARCH("live"), "https://x.com/someone/status/2123280111864811617"]);
    expect(h.log.opened).toBe(1);
    expect(h.log.closed).toBe(1);
    expect(h.log.emitted).toHaveLength(4);
    expect(h.log.emitted[0]).toMatchObject({ id: "top", status: "ok", signals: [], articleCount: 1, posts: [{ handle: "alice", counts: { views: 50000 } }] });
    expect(h.log.emitted[3]).toEqual({ done: true, exit: EXIT.ok, loads: 3, stopped: null });
  });

  it("paces the loads: no wait before the first, one jittered 9 to 22 s wait between loads, and at most 3 scrolls a page", async () => {
    const h = harness([facts(), facts(), facts()]);
    await h.run();
    expect(h.log.sleeps).toEqual([15_500, 15_500]); // the fake jitter returns the middle of 9 s and 22 s, once between each pair
    expect(h.log.scrolls).toEqual([3, 3, 3]);
  });

  it.each(WALLS)("%s stops the scan at that page: no further load, no retry, the browser closed, exit 2", async (signal, over) => {
    const h = harness([facts(), facts(over), facts()]);
    const r = await h.run();
    expect(r).toEqual({ exit: EXIT.stopped, loads: 2, stopped: signal });
    expect(h.log.loaded).toHaveLength(2);
    expect(h.log.closed).toBe(1);
    expect(h.log.emitted[1]).toMatchObject({ id: "live", status: signal, posts: [] });
    expect(h.log.emitted[2]).toEqual({ done: true, exit: EXIT.stopped, loads: 2, stopped: signal });
  });

  it("a wall on the very first page stops everything after one load", async () => {
    const h = harness([facts(WALLS[0]![1])]);
    expect(await h.run()).toEqual({ exit: EXIT.stopped, loads: 1, stopped: "login_wall" });
    expect(h.log.sleeps).toEqual([]);
  });

  it("a post saying 'sign in to X' is not a wall: only the page's own text is classified", async () => {
    const h = harness([facts({ text: "" })]);
    expect((await h.run()).exit).toBe(EXIT.ok);
  });

  it("a page where the selectors found nothing stops the scan with its own exit code (5) and is not a STOP signal", async () => {
    const h = harness([facts(), facts({ articleCount: 0, articles: [] }), facts()]);
    const r = await h.run();
    expect(r).toEqual({ exit: EXIT.selectorsFoundNothing, loads: 2, stopped: null });
    expect(h.log.emitted[1]).toMatchObject({ status: "selectors_found_nothing", posts: [] });
    expect(h.log.loaded).toHaveLength(2);
  });

  it("an empty result page that says so is ok with zero posts and the scan goes on", async () => {
    const h = harness([facts({ articleCount: 0, articles: [], emptyState: true }), facts(), facts()]);
    const r = await h.run();
    expect(r.exit).toBe(EXIT.ok);
    expect(h.log.emitted[0]).toMatchObject({ status: "ok", posts: [] });
  });

  it("a load that throws is an error record: not retried, the scan goes on, exit 1", async () => {
    const h = harness([new Error("page.goto: Timeout 45000ms exceeded\n  call log: ..."), facts(), facts()]);
    const r = await h.run();
    expect(r.exit).toBe(EXIT.error);
    expect(h.log.loaded).toHaveLength(3);
    expect(h.log.emitted[0]).toMatchObject({ id: "top", status: "error", error: "page.goto: Timeout 45000ms exceeded" });
  });

  it("never loads more than the plan's 8", async () => {
    const plan = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, url: SEARCH("top") }));
    const h = harness([facts()], { plan });
    expect((await h.run()).loads).toBe(8);
  });
});

describe("loadPage (the real page step, over a fake page)", () => {
  function fakePage() {
    const calls = { goto: [] as string[], wheel: 0, evaluate: [] as string[], other: [] as string[] };
    const page = {
      goto: async (url: string) => (calls.goto.push(url), { status: () => 200 }),
      waitForSelector: async () => {},
      url: () => "https://x.com/search?q=gta&f=top",
      mouse: { wheel: async () => void calls.wheel++ },
      evaluate: async (fn: { name: string }) => {
        calls.evaluate.push(fn.name);
        if (fn.name === "collectArticles") return [article(calls.wheel)];
        return facts({ articleCount: 1 });
      },
    };
    return { page, calls };
  }
  const opts = { scrolls: 10, sleep: async () => {}, jitter: (lo: number) => lo };

  it("uses goto once, at most 3 wheel scrolls however many are asked for, and reads only; the posts of every step are merged", async () => {
    const { page, calls } = fakePage();
    const r = await loadPage(page, SEARCH("top"), opts);
    expect(calls.goto).toEqual([SEARCH("top")]);
    expect(calls.wheel).toBe(3);
    expect(new Set(calls.evaluate)).toEqual(new Set(["collectArticles", "gatherFacts"]));
    expect(calls.evaluate.filter((n) => n === "collectArticles")).toHaveLength(4); // after the load and after each scroll
    expect(r.articles).toHaveLength(4); // four different first links, merged
    expect(r.httpStatus).toBe(200);
  });

  it("scrolls fewer times when asked for fewer", async () => {
    const { page, calls } = fakePage();
    await loadPage(page, SEARCH("top"), { ...opts, scrolls: 1 });
    expect(calls.wheel).toBe(1);
    const zero = fakePage();
    await loadPage(zero.page, SEARCH("top"), { ...opts, scrolls: 0 });
    expect(zero.calls.wheel).toBe(0);
  });
});
