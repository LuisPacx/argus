import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Datastore } from "../packages/core/src/index.ts";
import { tempDir } from "../packages/core/src/testing/temp.ts";
// @ts-expect-error plain .mjs script, no types
import { main, parseArgs, slugFor } from "./page-check.mjs";
// @ts-expect-error plain .mjs script, no types
import { LIVE_PORT, SEED_DEFAULT_PORT, seedBase, seedDbProblem, seedPortProblem, seedProbePath, startSeededServer } from "./page-check-server.mjs";
// @ts-expect-error plain .mjs script, no types
import { HOSTILE_ANGLE, HOSTILE_NAME, HOSTILE_SOURCE, STANDARD_PATHS, expandTokens, pathProblem, seedDatastore } from "./page-seed.mjs";

const NOW = new Date("2026-11-16T12:00:00.000Z");
const fresh = () => Datastore.open(path.join(tempDir("page-seed-"), "argus.db"));

describe("the seed fixture", () => {
  it("writes a row of each kind through the Datastore and returns the Proposal ids", async () => {
    const store = fresh();
    const { ids, counts } = await seedDatastore(store, NOW);
    const { narrative, moment, trend, ...proposalIds } = ids;
    expect(new Set(Object.values(proposalIds)).size).toBe(5);
    // The trend radar (trend radar ticket 01): an untokenized Trend with a drained-pool lookalike, a taken one, a not-traced one that keeps its last
    // good trace, one being tokenized, a hostile term, and every source status (two over the hour, so the banner shows).
    const radar = store.radarView(NOW);
    const bySide = Object.fromEntries(radar.trends.map((t: { term: string; side: string }) => [t.term, t.side]));
    expect(bySide).toMatchObject({ "SEED Glass Whale": "untokenized", "SEED Iron Moth": "taken", "SEED Quiet Falcon": "not traced", "SEED Copper Heron": "tokenizing" });
    expect(radar.trends).toHaveLength(7);
    expect(radar.enabled).toBe(true); // the worker's own word, written by the seed
    expect(radar.trends.find((t: { term: string }) => t.term === "SEED Crystal Fox")).toMatchObject({ score: 80, side: "contested", why: { geos: ["CA", "GB", "US"] } });
    expect(radar.trends.find((t: { id: number }) => t.id === trend)).toMatchObject({ term: "SEED Glass Whale", lookalikeCount: 1, localCreators: 2 });
    expect(radar.trends.find((t: { term: string }) => t.term === "SEED Quiet Falcon")).toMatchObject({ liveCount: 1, side: "not traced" });
    expect(radar.trends.find((t: { term: string }) => t.term.includes("hostile"))!.term).toContain("<img");
    expect(radar.sources.map((s: { source: string; status: string }) => [s.source, s.status])).toEqual([
      ["radar:evil", "ok"], ["radar:gamespot", "format changed"], ["radar:google:AU", "down"], ["radar:google:CA", "format changed"], ["radar:google:GB", "backing off"], ["radar:google:US", "ok"],
      ["radar:ign", "ok"], ["radar:kotaku", "backing off"], ["radar:polygon", "down"], ["radar:vgc", "ok"],
    ]);
    expect(radar.alerts.map((a: { source: string }) => a.source)).toEqual(["radar:google:CA", "radar:google:GB"]);
    expect(radar.counts).toEqual({ shown: 7, untokenized: 1 });
    // The Moment scanner (moment scanner ticket 01): the rising clip's status ID, a hostile post and the X session stopped by a login wall.
    const view = store.momentsView(NOW);
    expect(view.topic).toBe("SEED Moments topic");
    expect(view.rising.map((p: { statusId: string }) => p.statusId)).toEqual([moment, expect.any(String)]);
    expect(view.rising[0]).toMatchObject({ handle: "seed_clip", views: 310_000 });
    expect(view.rising[0]!.recentRate).toBeGreaterThan(50_000);
    expect(view.rising.find((p: { handle: string }) => p.handle === "seed_hostile")!.text).not.toMatch(/[<>]/);
    expect(view.session).toMatchObject({ status: "stopped", reason: "login_wall", probeDue: false });
    // The Operator's verdicts (ticket 19): a history on the Tech Narrative (the newest, good, is the current one), one on the news Narrative.
    expect(store.verdictsFor(narrative).map((v: { verdict: string; scoreId: number | null }) => [v.verdict, v.scoreId !== null])).toEqual([["good", true], ["bad", true]]);
    expect(store.queryNarratives({ verdict: "bad" })).toHaveLength(1);
    expect(store.getProposal(ids.tech)!.narrativeId).toBe(narrative);

    const tech = store.getProposal(ids.tech)!;
    expect(tech).toMatchObject({ kind: "narrative", status: "new", name: "SEED Invoice Tool" });
    expect(tech.scoreId).not.toBeNull();

    const metaMeme = store.getProposal(ids.metaMeme)!;
    expect(metaMeme).toMatchObject({ kind: "meme", status: "new", metaKey: "seed-chair" });
    expect(metaMeme.metaSnapshot).toMatchObject({ version: 2 });

    const newsMeme = store.getProposal(ids.newsMeme)!;
    expect(newsMeme).toMatchObject({ kind: "meme", status: "new" });
    expect(newsMeme.narrativeId).not.toBeNull();
    expect(newsMeme.metaKey).toBe(`narrative:${newsMeme.narrativeId}`);
    expect(newsMeme.metaSnapshot).toMatchObject({ version: 3, kind: "narrative" });

    const hostile = store.getProposal(ids.hostile)!;
    expect(hostile.name).toBe(HOSTILE_NAME);
    expect(hostile.name).toContain("<script>");
    expect(hostile.ticker.length).toBeGreaterThan(100);
    expect(hostile.ticker).not.toMatch(/\s/);

    // The Operator's angle (ticket 11): a trio with a hostile angle and a source that is not a link, and a request each of done, capped and pending.
    const angle = store.getProposal(ids.angle)!;
    expect(angle).toMatchObject({ kind: "meme", metaKey: "seed-chair", operatorAngle: { requestId: 1, sourceUrl: HOSTILE_SOURCE, urlDropped: false } });
    expect(angle.operatorAngle!.angle).toBe(HOSTILE_ANGLE);
    expect(angle.operatorAngle!.angle).toContain("<img");
    expect(angle.metaSnapshot).toMatchObject({ version: 2, trigger: { kind: "operator-angle" } });
    expect(store.memeAngleRequests().map((r) => [r.metaKey, r.status])).toEqual([["seed-cloud", "pending"], ["seed-lobster", "capped"], ["seed-chair", "done"]]);
    expect(store.memeAngleRequests()[2]!.proposalIds).toHaveLength(3);

    expect(store.liveMemeProposals()).toHaveLength(9);
    const current = store.currentMetas(NOW.toISOString())!;
    expect(current.metas.map((m: { key: string; holding: boolean }) => [m.key, m.holding])).toEqual([
      ["seed-chair", false],
      ["seed-lobster", true],
    ]);
    expect(current.watching).toHaveLength(2);
    // merged themes (ticket 07), read back through the Datastore: 3 with a long and a markup label, 7, and none
    expect(current.metas[0]!.themes!.map((t: { label: string }) => t.label)).toEqual(["SEED Empty Chair", `SEED${"Z".repeat(116)}`, "<b>SEED</b> <img src=x onerror=alert(1)> chair"]);
    expect(current.metas[1]!.themes).toHaveLength(7);
    expect(current.metas[0]!.namedBy).toBe("ai");
    expect(current.watching.map((w: { themes?: unknown[] }) => w.themes)).toEqual([[], []]);
    expect(store.newMetaEvents(new Date(NOW.getTime() - 3_600_000).toISOString())).toHaveLength(1);

    expect(counts).toEqual({ source_polls: 1, signals: 2, narratives: 2, scores: 2, meta_runs: 1, new_meta_events: 1, proposals: 10, brain_runs: 9, angle_requests: 3, verdicts: 3, moment_scans: 3, moment_posts: 3, moment_readings: 6, x_session_stops: 1, radar_trends: 7, radar_sources: 10, picks: 4, research_requests: 5 });
    // The Operator's topic research (human researcher ticket 05): a done brief, a failed, a capped, a hostile one and one waiting, each with its cost.
    expect(store.researchRequests().map((r) => [r.status, r.runs, r.brief !== null])).toEqual([["pending", 0, false], ["done", 1, true], ["capped", 0, false], ["failed", 2, false], ["done", 1, true]]);
    expect(store.researchRequests().find((r) => r.status === "failed")!.costUsd).toBeCloseTo(0.7999, 4);
    expect(store.listPicks().map((p: { name: string }) => p.name.slice(0, 12))).toEqual(["SEED <img sr", "SEED Unknown", "SEED Bonded ", "SEED Iguana "]);
    // One run of each cost kind, so the pages show exact, estimated and unknown (hardening ticket 10).
    expect(store.brainRunsFor(ids.tech).map((r) => [r.task, r.costSource])).toEqual([["spec", "exact"], ["build", "estimated"], ["build", "unknown"]]);
    expect(store.getProposal(ids.tech)).toMatchObject({ agentCostKind: "unknown" });
    store.close();
  });

  it("marks every name as sample data", async () => {
    const store = fresh();
    await seedDatastore(store, NOW);
    for (const p of store.liveMemeProposals()) expect(`${p.name} ${p.metaLabel}`, p.name).toMatch(/SEED/);
    store.close();
  });

  it("is deterministic for a fixed now", async () => {
    const a = fresh();
    const b = fresh();
    const ra = await seedDatastore(a, NOW);
    const rb = await seedDatastore(b, NOW);
    expect(ra).toEqual(rb);
    const { narrative, moment, trend: _trend, ...proposalIds } = ra.ids;
    expect(a.getNarrative(narrative)).toEqual(b.getNarrative(narrative));
    expect(a.momentsView(NOW)).toEqual(b.momentsView(NOW));
    expect(a.radarView(NOW)).toEqual(b.radarView(NOW));
    expect(moment).toBe(rb.ids.moment);
    for (const id of Object.values(proposalIds) as number[]) expect(a.getProposal(id)).toEqual(b.getProposal(id));
    a.close();
    b.close();
  });
});

describe("seed paths and arguments", () => {
  it("expands {tokens} from the fixture and refuses unknown ones", () => {
    const ids = { tech: 1, metaMeme: 2, newsMeme: 5, hostile: 3, angle: 7 };
    expect(expandTokens("/proposals/{angle}", ids)).toBe("/proposals/7");
    expect(expandTokens("/proposals/{newsMeme}", ids)).toBe("/proposals/5");
    expect(expandTokens("/proposals/{tech}?x={hostile}", ids)).toBe("/proposals/1?x=3");
    expect(expandTokens("/meta", ids)).toBe("/meta");
    // a status ID is longer than a safe integer, so the `moment` token is text
    expect(expandTokens("/moments#post-{moment}", { ...ids, moment: "2123280111864811617" })).toBe("/moments#post-2123280111864811617");
    expect(() => expandTokens("/moments#post-{moment}", { ...ids, moment: "not-an-id" })).toThrow(/has no id/);
    expect(expandTokens("/radar#trend-{trend}", { ...ids, trend: 6 })).toBe("/radar#trend-6");
    expect(() => expandTokens("/proposals/{nope}", ids)).toThrow(/unknown seed token \{nope\}/);
    expect(pathProblem("/proposals/{nope}")).toContain("{nope}");
    expect(pathProblem("/proposals/{tech")).toContain("unmatched");
    expect(pathProblem("/proposals/{tech}")).toBeNull();
    for (const p of STANDARD_PATHS) expect(pathProblem(p), p).toBeNull();
  });

  it("parses --seed, --all and the default seed port, and keeps the plain one-path rule", () => {
    expect(parseArgs(["--seed", "--all"])).toMatchObject({ seed: true, port: SEED_DEFAULT_PORT, paths: STANDARD_PATHS });
    expect(parseArgs(["--seed", "/meta", "/proposals/{tech}", "--port", "3300"])).toMatchObject({ seed: true, port: 3300, paths: ["/meta", "/proposals/{tech}"] });
    expect(parseArgs(["/meta"])).toMatchObject({ seed: false, port: 3100, paths: ["/meta"] });
    expect(() => parseArgs(["/a", "/b"])).toThrow(/one path only/);
    expect(() => parseArgs(["--seed"])).toThrow(/needs/);
    expect(() => parseArgs(["--seed", "--all", "/meta"])).toThrow(/not both/);
    expect(() => parseArgs(["--all"])).toThrow(/needs --seed/);
    expect(() => parseArgs(["--seed", "--all", "--port", "3100"])).toThrow(/live/);
  });

  it("names seeded screenshots with the query so / and /?kind=meme do not overwrite each other", () => {
    expect(slugFor("/")).toBe(slugFor("/?kind=meme"));
    expect(slugFor("/", true)).toBe("home");
    expect(slugFor("/?kind=meme", true)).toBe("kind-meme");
    expect(slugFor("/meta#all-launch-themes", true)).toBe("meta-all-launch-themes");
    expect(new Set(STANDARD_PATHS.map((p: string) => slugFor(p, true))).size).toBe(STANDARD_PATHS.length);
  });
});

describe("startSeededServer refusals write nothing", () => {
  // A base that does not exist yet: any dir, file or DB a refusal left behind would make it exist.
  const freshBase = () => path.join(tempDir("page-seed-base-"), "scratch");
  const refused = async (opts: Record<string, unknown>) => {
    const base = (opts.base as string | undefined) ?? freshBase();
    await expect(startSeededServer({ now: NOW, liveDbs: [], ...opts, base })).rejects.toMatchObject({ refusal: true });
    expect(fs.existsSync(base)).toBe(false);
    expect(fs.readdirSync(path.dirname(base))).toEqual([]);
  };

  it("refuses the live port", async () => {
    await refused({ port: LIVE_PORT });
  });
  it("refuses a bad port", async () => {
    await refused({ port: 0 });
  });
  it("refuses a seed DB path that is the live DB", async () => {
    const base = freshBase();
    await refused({ base, liveDbs: [seedProbePath(base)] });
  });
  it("refuses a busy port", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await refused({ port: (server.address() as net.AddressInfo).port });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("refusals", () => {
  const dir = seedBase();
  it("refuses the live port, a live or non-scratch DB path", () => {
    expect(seedPortProblem(LIVE_PORT)).toContain("live");
    expect(seedPortProblem(SEED_DEFAULT_PORT)).toBeNull();
    const db = path.join(dir, "page-seed-x", "argus.db");
    expect(seedDbProblem(db, [], seedBase())).toBeNull();
    expect(seedDbProblem(db, [db], seedBase())).toContain("live");
    expect(seedDbProblem(`${db}-wal`, [db], seedBase())).toContain("live");
    expect(seedDbProblem("/home/u/code/argus/.data/argus.db", [], "/home/u/.cache/argus-scratch")).toContain("live");
    expect(seedDbProblem("/tmp/x/argus.db", [], seedBase())).toContain("not under");
  });

  it.each([
    ["the live port", ["--seed", "--all", "--port", "3100"]],
    ["a // path", ["--seed", "//evil.example/x"]],
    ["an absolute URL", ["--seed", "http://evil.example/"]],
    ["an unknown token", ["--seed", "/proposals/{nope}"]],
    ["no path and no --all", ["--seed"]],
  ])("exits 2 for %s and writes nothing", async (_label, argv) => {
    const out = tempDir("page-check-out-");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await main([...argv, "--out", out])).toBe(2);
    } finally {
      error.mockRestore();
    }
    expect(fs.readdirSync(out)).toEqual([]);
  });
});
