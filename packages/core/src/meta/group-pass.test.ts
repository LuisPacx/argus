import { describe, expect, it } from "vitest";
import { BrainError, DEFAULT_ROUTING, type Brain, type BrainInput, type BrainRun } from "../brain.ts";
import { Datastore } from "../datastore.ts";
import type { DexPair } from "../sources/dexscreener.ts";
import { recomputeMetas, type MetaDexClient, type RecomputeOptions } from "./compute.ts";
import { META_RULE } from "./config.ts";
import { createGroupStep, DEFAULT_META_GROUP_CONFIG, metaGroupConfigFromEnv, type MetaGroupConfig } from "./group-pass.ts";
import type { TopDownCandidate, TopDownResult } from "./topdown.ts";

/**
 * The grouping step end to end (meta redesign ticket 06): a real datastore, the real compute step, a fake Brain and a fake clock (the tick's
 * as-of time). Nothing here spawns `claude` or reaches the network.
 */

const CFG = { ...META_RULE, minTokens: 2, minCreators: 1 };
const T0 = Date.parse("2026-11-16T10:00:00.000Z");
const T = (minutes: number) => new Date(T0 + minutes * 60_000);
const GOOD = '{"subjects":[{"name":"Alpha Story","items":["T1","H1","H2"]}]}';

let seq = 0;
const mintOf = () => `M${String(seq++).padStart(8, "0")}`.padEnd(40, "x") + "pump";
const creatorOf = (c: string) => `C${c}`.padEnd(44, "_");

/** A create, and its graduation five minutes later (a Meta is several tokens graduating: every launch here graduates). */
function launch(store: Datastore, name: string, creator: string, minutesAgo = 30, at = T0) {
  const mint = mintOf();
  const createdAt = at - minutesAgo * 60_000;
  store.study.recordTokenEvent({ kind: "create", mint, receivedAt: new Date(createdAt).toISOString(), signature: "", name, symbol: name.toUpperCase().slice(0, 8), creator: creatorOf(creator), uri: "https://ipfs.io/ipfs/x", pool: "pump" });
  store.study.recordTokenEvent({ kind: "migrate", mint, receivedAt: new Date(createdAt + 5 * 60_000).toISOString(), signature: "", name: "", symbol: "", creator: "", uri: "", pool: "pump-amm" });
}

/** Two launch themes of 12 creators each (alpha, beta), each token graduated: 12 graduations from 12 creators in the last 6 h make each a Meta. */
function seedThemes(store: Datastore) {
  for (let i = 0; i < 12; i++) {
    launch(store, "Alpha", `a${i}`);
    launch(store, "Beta", `b${i}`);
  }
}

const pair = (mint: string, marketCapUsd: number): DexPair => ({ chainId: "solana", tokenAddress: mint, name: "", symbol: "", url: "", liquidityUsd: 1_000_000, volume24hUsd: 1_000_000, priceChange24hPct: 0, marketCapUsd });

/** DexScreener answers every mint with `cap()`. */
const dexWith = (cap: () => number): MetaDexClient => ({ async tokenPairs(_chain, addresses) { return addresses.map((a) => pair(a, cap())); } });

/** One trending candidate named `Alpha Coin ($ALPHA)`; its mint is `mint()`, so a test changes the items by changing the mint. */
const trending = (mint: () => string): (() => Promise<TopDownResult>) => async () => {
  const c: TopDownCandidate = { mint: mint(), name: "Alpha Coin", symbol: "ALPHA", marketCapUsd: 5_000_000, liquidityUsd: 900_000, volume24hUsd: 900_000, sources: ["jupiter", "geckoterminal"], ranks: { jupiter: 1, geckoterminal: 2 } };
  return { candidates: [c], dropped: [], requests: 0, errors: [] };
};

/** A Brain that answers from `answer`, records every prompt and what the run table held while it ran, and charges `cost` a call. */
function fakeBrain(answer: (n: number, input: BrainInput) => string | BrainError, store: Datastore, cost = 0.002) {
  const prompts: string[] = [];
  const inFlight: number[] = [];
  const brain: Brain = {
    routeFor: (task) => ({ backend: DEFAULT_ROUTING[task].backend, model: DEFAULT_ROUTING[task].model, maxBudgetUsd: DEFAULT_ROUTING[task].maxBudgetUsd }),
    async run<R>(task: string, input: BrainInput): Promise<BrainRun<R>> {
      expect(task).toBe("meta-group");
      prompts.push(input.prompt);
      inFlight.push(store.brainRunsFor(0).filter((r) => r.task === "meta-group" && r.exitStatus === "in-flight").length);
      const a = answer(prompts.length, input);
      if (a instanceof BrainError) throw a;
      return { output: a as R, totalCostUsd: cost, backend: "claude-code", model: "haiku" };
    },
  };
  return { brain, prompts, inFlight };
}

const err = (kind: ConstructorParameters<typeof BrainError>[0], cost = 0) => new BrainError(kind, `${kind} (test)`, { backend: "claude-code", model: "haiku", totalCostUsd: cost });

function rig(over: { config?: Partial<MetaGroupConfig>; answer?: (n: number, input: BrainInput) => string | BrainError; cost?: number; brain?: (b: Brain) => Brain } = {}) {
  const store = Datastore.open(":memory:");
  seedThemes(store);
  const lines: string[] = [];
  const fake = fakeBrain(over.answer ?? (() => GOOD), store, over.cost);
  const brain = over.brain ? over.brain(fake.brain) : fake.brain;
  const step = createGroupStep(store, brain, { config: over.config, log: (l) => void lines.push(l) });
  let mint = "TRENDING1".padEnd(40, "x");
  let cap = 5_000_000;
  const tick = (minutes: number, extra: Partial<RecomputeOptions> = {}) => recomputeMetas(store, { now: T(minutes), config: CFG, dex: dexWith(() => cap), topDown: trending(() => mint), group: step, log: () => {}, ...extra });
  return { store, lines, ...fake, step, tick, newMint: (n: number) => void (mint = `TRENDING${n}`.padEnd(40, "x")), setCap: (c: number) => void (cap = c), brain };
}

const runsOf = (store: Datastore, minutes = 0) => store.metaGroupSpendSince(T(minutes - 24 * 60).toISOString());
const named = (store: Datastore) => store.currentMetas()!.metas.map((m) => [m.label, m.namedBy]);
/** By rules, each theme's own biggest token leads it (DexScreener answers every mint), so Alpha and Beta are two Metas; the AI step makes them one. */
const BY_RULES = [["Alpha", "rules"], ["Beta", "rules"]];

describe("the grouping step end to end", () => {
  it("a good answer is stored, names the Meta, and the run is recorded under meta-group with its cost and an in-flight row before the call", async () => {
    const { store, tick, prompts, inFlight, lines } = rig({ cost: 0.0123 });
    const r = await tick(0);
    expect(r.group).toEqual({ source: "ai", reused: false, subjects: 1 });
    expect(named(store)).toEqual([["Alpha Story", "ai"]]);
    const meta = store.currentMetas()!.metas[0]!;
    expect(meta).toMatchObject({ key: "alpha", leader: { marketCapUsd: 5_000_000, symbol: "ALPHA" }, counts: { "24h": { creators: 24 } } });
    expect(meta.themes!.map((t) => [t.key, t.creators])).toEqual([["alpha", 12], ["beta", 12]]);
    expect(prompts).toHaveLength(1);
    expect(inFlight).toEqual([1]);
    const g = store.meta.latestGrouping()!;
    expect(g).toMatchObject({ runId: r.runId, source: "ai", costUsd: 0.0123, computedAt: T(0).toISOString() });
    expect(g.answer.subjects).toEqual([{ name: "Alpha Story", items: ["T1", "H1", "H2"] }]);
    expect(g.answer.refs).toMatchObject({ T1: "T:" + "TRENDING1".padEnd(40, "x"), H1: "H:alpha", H2: "H:beta" });
    const brainRun = store.brainRunsFor(0).find((x) => x.task === "meta-group")!;
    expect(brainRun).toMatchObject({ task: "meta-group", exitStatus: "success", totalCostUsd: 0.0123, backend: "claude-code", model: "haiku" });
    expect(g.brainRunId).toBe(brainRun.id);
    expect(runsOf(store)).toMatchObject({ runs: 1, costUsd: 0.0123 });
    expect(lines).toEqual(["[worker] meta group: ai (called, $0.0123, 1 subjects)"]);
  });

  it("the prompt the Brain gets has the rules, the block and the ids it may use, and no mint", async () => {
    const { tick, prompts } = rig();
    await tick(0);
    const p = prompts[0]!;
    expect(p).toMatch(/T1 token name="Alpha Coin" ticker="ALPHA" market_cap=\$5M lists=jupiter\+geckoterminal/);
    expect(p).toMatch(/H1 theme key="alpha" tokens=12 creators=12 names=\["Alpha"\]/);
    expect(p).not.toContain("TRENDING1");
  });

  const failures: Array<[string, (n: number) => string | BrainError, RegExp]> = [
    ["a refused answer", () => '{"subjects":[{"name":"x","items":["T99"]}]}', /refused: subjects\[0\]\.items\[0\]/],
    ["prose around the JSON", () => `Sure! ${GOOD}`, /refused: output is not a single JSON object/],
    ["a rate limit", () => err("rate-limited"), /rules \(rate-limited\)/],
    ["a timeout", () => err("timed-out"), /rules \(timed-out\)/],
    ["a budget stop", () => err("budget-exceeded", 0.05), /rules \(budget-exceeded\)/],
    ["a thrown error", () => { throw new Error("boom"); }, /rules \(failed: boom\)/],
  ];
  it.each(failures)("%s gives named_by rules for the tick, no Meta lost, no exception, no retry in the tick, and the run recorded", async (_label, answer, line) => {
    const { store, tick, prompts, lines } = rig({ answer });
    const r = await tick(0);
    expect(r.group).toEqual({ source: "rules", reused: false, subjects: 0 });
    expect(named(store)).toEqual(BY_RULES); // the creator-voted names; no Meta lost
    expect(store.currentMetas()!.metas[0]).toMatchObject({ key: "alpha", leader: { marketCapUsd: 5_000_000 }, themes: [] });
    expect(prompts).toHaveLength(1);
    expect(lines.some((l) => line.test(l))).toBe(true);
    expect(store.meta.latestGrouping()).toBeUndefined();
    expect(runsOf(store).runs).toBe(1);
    expect(store.brainRunsFor(0).filter((x) => x.exitStatus === "in-flight")).toEqual([]);
  });

  it("a thrown error from the step itself (not the Brain) is swallowed by the tick too", async () => {
    const { store, tick } = rig();
    const r = await tick(0, { group: async () => { throw new Error("step exploded"); }, log: (l) => void lines.push(l) });
    expect(r.group.source).toBe("rules");
    expect(named(store)).toEqual(BY_RULES);
  });
  const lines: string[] = [];

  it("a step that never answers is cut off by the tick's bound and the tick groups by rules", async () => {
    const { store, tick } = rig();
    const r = await tick(0, { group: () => new Promise(() => {}), groupTimeoutMs: 20 });
    expect(r.group.source).toBe("rules");
    expect(named(store)).toEqual(BY_RULES);
  });

  it("ARGUS_META_GROUP_AI=0 makes no call; with no Brain at all there is none either", async () => {
    const off = rig({ config: metaGroupConfigFromEnv({ ARGUS_META_GROUP_AI: "0" }) });
    expect((await off.tick(0)).group.source).toBe("rules");
    expect(off.prompts).toHaveLength(0);
    expect(off.lines).toEqual(["[worker] meta group: rules (off)"]);
    const store = Datastore.open(":memory:");
    seedThemes(store);
    const none = createGroupStep(store, undefined, { log: () => {} });
    expect((await recomputeMetas(store, { now: T(0), config: CFG, group: none })).group.source).toBe("rules");
  });

  it("with the API fallback holding the research tasks on the API, nothing is spawned", async () => {
    const { tick, prompts, lines, store } = rig({ brain: (b) => ({ ...b, routeFor: (task) => ({ ...b.routeFor(task), backend: task === "judge" ? "api" : b.routeFor(task).backend }) }) });
    expect((await tick(0)).group.source).toBe("rules");
    expect(prompts).toHaveLength(0);
    expect(lines).toEqual(["[worker] meta group: rules (api-fallback hold)"]);
    expect(runsOf(store).runs).toBe(0);
  });

  it("a dry run (a Brain that answers nothing) leaves no run row behind and uses rules", async () => {
    const { tick, store } = rig({ brain: (b) => ({ ...b, run: async <R>(): Promise<BrainRun<R>> => ({ output: "" as R, totalCostUsd: 0, dryRun: true, backend: "claude-code", model: "haiku" }) }) });
    expect((await tick(0)).group.source).toBe("rules");
    expect(runsOf(store).runs).toBe(0);
  });
});

describe("the cost cap and reuse", () => {
  it("with $1.00 a day and $0.04 a call over changing inputs, call 25 is the last: the next ticks use rules and log the cap, and the first call that fits after the oldest run ages out is made", async () => {
    const { store, tick, prompts, lines, newMint } = rig({ cost: 0.04 });
    for (let i = 0; i < 25; i++) {
      newMint(i);
      expect((await tick(i * 10)).group.source).toBe("ai");
    }
    expect(prompts).toHaveLength(25);
    expect(runsOf(store, 250).costUsd).toBeCloseTo(1.0);
    for (let i = 25; i < 28; i++) {
      newMint(i);
      const r = await tick(i * 10);
      expect(r.group.source).toBe("rules");
      expect(named(store)).toEqual(BY_RULES);
    }
    expect(prompts).toHaveLength(25);
    expect(lines.filter((l) => l.includes("daily cap reached"))).toHaveLength(3);
    expect(lines.at(-1)).toMatch(/rules \(daily cap reached: \$1\.0000 of \$1\.00 in 24 h, 25 runs\)/);
    // 24 h after the first call (minute 0) is minute 1440: just before, the first run still counts; just after, it has aged out.
    // (the launches the themes are made of are a day old by now, so fresh ones are made first)
    const relaunch = (minutes: number) => {
      for (let i = 0; i < 12; i++) {
        launch(store, "Alpha", `a${i}`, 20, T(minutes).getTime());
        launch(store, "Beta", `b${i}`, 20, T(minutes).getTime());
      }
    };
    relaunch(24 * 60 - 1);
    newMint(100);
    expect((await tick(24 * 60 - 1)).group.source).toBe("rules");
    expect(lines.at(-1)).toMatch(/daily cap reached: \$1\.0000 of \$1\.00 in 24 h, 25 runs/);
    expect(prompts).toHaveLength(25);
    newMint(101);
    expect((await tick(24 * 60 + 1)).group.source).toBe("ai");
    expect(prompts).toHaveLength(26);
  });

  it("a run that reported no cost (timed out) is charged the route cap of $0.05, so twenty timeouts end the day's calls", async () => {
    const { store, tick, prompts, lines, newMint } = rig({ answer: () => err("timed-out") });
    for (let i = 0; i < 80 && prompts.length < 20; i++) {
      newMint(i);
      await tick(i * 5);
    }
    expect(prompts).toHaveLength(20);
    expect(runsOf(store, 400).costUsd).toBe(0); // nothing reported...
    expect(runsOf(store, 400).chargedUsd).toBeCloseTo(0); // ...and without the route caps nothing is charged either; the step passes them
    for (let i = 0; i < 6; i++) {
      newMint(200 + i);
      await tick(500 + i * 5);
    }
    expect(prompts).toHaveLength(20);
    expect(lines.some((l) => l.includes("daily cap reached: $1.0000 of $1.00 in 24 h, 20 runs"))).toBe(true);
  });

  it("three failures in a row skip the call for the next two ticks, and a success clears the count", async () => {
    let n = 0;
    const { tick, prompts, lines, newMint } = rig({ answer: () => (++n <= 3 ? err("rate-limited") : GOOD) });
    const sources: string[] = [];
    for (let i = 0; i < 8; i++) {
      newMint(i);
      sources.push((await tick(i * 5)).group.source);
    }
    expect(prompts).toHaveLength(6); // ticks 0-2 fail, 3-4 are skipped, 5 calls and succeeds, 6 and 7 are new inputs and call again
    expect(sources).toEqual(["rules", "rules", "rules", "rules", "rules", "ai", "ai", "ai"]);
    expect(lines.filter((l) => l.includes("backing off after failures"))).toHaveLength(2);
  });

  it("the shared research budget exhausted ends the calls too", async () => {
    const { tick, prompts, lines, store } = rig({ cost: 0.05 });
    // $6 a day of research: spend it on another research task's run.
    const id = store.startBrainRun({ proposalId: 0, task: "meta-summary", backend: "claude-code", model: "haiku" }, T(-10));
    store.finishBrainRun(id, { sessionId: null, totalCostUsd: 6.5, exitStatus: "success" });
    expect((await tick(0)).group.source).toBe("rules");
    expect(prompts).toHaveLength(0);
    expect(lines.at(-1)).toMatch(/rules \(research budget reached/);
  });

  it("an unchanged input makes no call across 8 consecutive ticks; a changed trending mint or theme key calls; caps or counts alone do not; an answer over 60 minutes old is called for again", async () => {
    const { store, tick, prompts, lines, newMint, setCap } = rig({ cost: 0.01 });
    const sources: string[] = [];
    for (let i = 0; i < 8; i++) sources.push((await tick(i * 5)).group.source);
    expect(sources).toEqual(Array.from({ length: 8 }, () => "ai"));
    expect(prompts).toHaveLength(1);
    expect(lines.filter((l) => l.includes("(reused, $0.0000, 1 subjects)"))).toHaveLength(7);
    expect(runsOf(store, 40).runs).toBe(1);
    // the reused answer still names the Meta, with its themes
    expect(store.currentMetas()!.metas[0]).toMatchObject({ label: "Alpha Story", namedBy: "ai" });
    expect((await tick(40)).group).toEqual({ source: "ai", reused: true, subjects: 1 });

    // caps and counts moving alone: no call
    setCap(7_000_000);
    for (let i = 0; i < 6; i++) launch(store, "Alpha", `extra${i}`, 5, T(45).getTime());
    expect((await tick(45)).group.reused).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(store.currentMetas()!.metas[0]).toMatchObject({ leader: { marketCapUsd: 7_000_000 }, counts: { "24h": { creators: 30 } } });

    // a new trending mint: a call
    newMint(2);
    expect((await tick(50)).group.reused).toBe(false);
    expect(prompts).toHaveLength(2);

    // a new theme key: a call
    for (let i = 0; i < 3; i++) launch(store, "Gamma", `g${i}`, 2, T(55).getTime());
    expect((await tick(55)).group.reused).toBe(false);
    expect(prompts).toHaveLength(3);

    // reused again until it is 60 minutes old, then called for again even though nothing changed
    expect((await tick(60)).group.reused).toBe(true);
    expect((await tick(55 + 59)).group.reused).toBe(true);
    expect(prompts).toHaveLength(3);
    expect((await tick(55 + 60)).group.reused).toBe(false);
    expect(prompts).toHaveLength(4);
  });

  it("a reused answer is a stored one: a Meta tick that reuses writes no second meta_groupings row", async () => {
    const { store, tick } = rig();
    await tick(0);
    const first = store.meta.latestGrouping()!;
    await tick(5);
    expect(store.meta.latestGrouping()).toEqual(first);
  });
});

describe("the grouping step's limits", () => {
  it("a fake Brain answering 'everything is one subject' cannot create a Meta whose members have under 10 real graduations, whatever the leader's cap", async () => {
    const everything = () => `{"subjects":[{"name":"Everything","items":[${["T1", "H1", "H2", "H3", "H4"].map((i) => `"${i}"`).join(",")}]}]}`;
    // Four themes of 2 graduates each: 8 real graduations in all, under the 10 a Meta needs, whatever the model grouped (and a $5M leader changes nothing).
    const small = Datastore.open(":memory:");
    for (let t = 0; t < 4; t++) for (let i = 0; i < 2; i++) launch(small, `Theme${t}`, `s${t}_${i}`);
    const fake = fakeBrain(everything, small);
    const step = createGroupStep(small, fake.brain, { log: () => {} });
    const opts = (cap: number): RecomputeOptions => ({ now: T(0), config: CFG, dex: dexWith(() => cap), topDown: trending(() => "TRENDING1".padEnd(40, "x")), group: step, log: () => {} });
    const r = await recomputeMetas(small, opts(5_000_000));
    expect(r.group.source).toBe("ai");
    expect(r).toMatchObject({ metas: 0, watching: 1 });
    expect(small.currentMetas()!.watching[0]).toMatchObject({ label: "Everything", grads: { "24h": 8, "6h": 8, creators24h: 8 } });
    expect(fake.prompts).toHaveLength(1);
  });

  it("a $900k leader still leads a Meta however it was grouped: the cap is display only", async () => {
    const { store, tick } = rig({ answer: () => '{"subjects":[{"name":"Alpha Story","items":["H1","H2"]}]}' }); // the $900k token is not an item: only the two themes are
    await tick(0, { dex: dexWith(() => 900_000) });
    expect(store.currentMetas()!.watching).toEqual([]);
    expect(store.currentMetas()!.metas[0]).toMatchObject({ label: "Alpha Story", namedBy: "ai", leader: { marketCapUsd: 900_000 }, grads: { "24h": 24, creators24h: 24 } });
  });

  it("a Meta whose key was lucia before is continued through its leader and raises no second New Meta event", async () => {
    const { store, tick, newMint } = rig();
    // The previous run stored the Meta under the old key `lucia`, led by the same token (a run from before this ticket).
    newMint(1);
    await tick(0, { group: undefined });
    const before = store.currentMetas()!;
    expect(before.metas[0]).toMatchObject({ key: "alpha", label: "Alpha", namedBy: "rules" });
    const { raiseNewMetas } = await import("./new-meta.ts");
    expect(raiseNewMetas(store).length).toBe(0); // the first run only sets the baseline
    store.meta.saveRun({ computedAt: T(1).toISOString(), note: "", rule: CFG, dexCalls: 0, dexFailures: 0, base: { "6h": { tokens: 0, migrations: 0 }, "24h": { tokens: 0, migrations: 0 } }, rows: { "6h": [], "24h": [] }, current: { metas: [{ ...before.metas[0]!, key: "lucia", label: "Lucia From GTA 6" }], watching: [] } });
    await tick(5);
    const after = store.currentMetas()!.metas[0]!;
    expect(after).toMatchObject({ label: "Alpha Story", namedBy: "ai", enteredAt: before.metas[0]!.enteredAt });
    expect(raiseNewMetas(store)).toEqual([]);
  });
});

describe("the config", () => {
  it("reads both knobs, bounded: junk is an error", () => {
    expect(metaGroupConfigFromEnv({})).toMatchObject({ enabled: true, maxDailyUsd: 1 });
    expect(metaGroupConfigFromEnv({ ARGUS_META_GROUP_AI: "0", ARGUS_META_GROUP_MAX_DAILY_USD: "0.25" })).toMatchObject({ enabled: false, maxDailyUsd: 0.25 });
    expect(metaGroupConfigFromEnv({ ARGUS_META_GROUP_AI: "1", ARGUS_META_GROUP_MAX_DAILY_USD: "" })).toMatchObject({ enabled: true, maxDailyUsd: 1 });
    for (const bad of ["0", "-1", "abc", "NaN", "Infinity"]) expect(() => metaGroupConfigFromEnv({ ARGUS_META_GROUP_MAX_DAILY_USD: bad })).toThrow(/ARGUS_META_GROUP_MAX_DAILY_USD/);
    expect(() => metaGroupConfigFromEnv({ ARGUS_META_GROUP_AI: "yes" })).toThrow(/ARGUS_META_GROUP_AI/);
    expect(DEFAULT_META_GROUP_CONFIG).toMatchObject({ maxDailyUsd: 1, reuseMinutes: 60 });
    expect(DEFAULT_ROUTING["meta-group"]).toMatchObject({ backend: "claude-code", model: "haiku", maxBudgetUsd: 0.05, timeoutMs: 120_000, tools: [] });
  });
});
