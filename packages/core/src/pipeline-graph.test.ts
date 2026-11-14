import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTING } from "./brain.ts";
import { MAX_NEW_PROPOSALS_PER_DAY } from "./datastore.ts";
import { EXPIRY_MS } from "./expiry.ts";
import { DEFAULT_JUDGE_CONFIG } from "./judge.ts";
import { META_RULE, META_WINDOWS } from "./meta/config.ts";
import { formatRuleValue, PIPELINE, pipelineGaps, resolvePipeline, type PipelineGraph, type PipelineRegistry } from "./pipeline-graph.ts";
import { DEFAULT_PROPOSE_CONFIG } from "./propose.ts";
import { DEFAULT_RESEARCH_BUDGET_CONFIG } from "./research-budget.ts";
import { SEED_GATE_MIN_SCORE } from "./rubric.ts";
import { MARKET_SOURCE_IDS, SOURCE_CLASS, SOURCE_CLASS_PREFIX } from "./sources/source-class.ts";
import { MAX_CAPTURE_RUNS_PER_DAY, STUDY_CAPTURE_RULE } from "./study/config.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (repoPath: string) => readFileSync(join(REPO, repoPath), "utf8");
const matches = (text: string, re: RegExp): string[] => [...new Set([...text.matchAll(re)].map((m) => m[1]!))].sort();

/** Items the graph deliberately does not draw, each with the reason. A new key in any of these objects fails until someone decides. */
const LEFT_OUT: Record<string, string> = {
  BackoffSource: "wraps another Source for retries; it is not a Source of its own",
  "DEFAULT_JUDGE_CONFIG.maxConsecutiveFailures": "a circuit breaker, below the level of a high-level picture",
  "DEFAULT_JUDGE_CONFIG.maxConsecutiveTimeouts": "a circuit breaker, below the level of a high-level picture",
  "DEFAULT_PROPOSE_CONFIG.maxConsecutiveFailures": "a circuit breaker, below the level of a high-level picture",
  "DEFAULT_PROPOSE_CONFIG.maxConsecutiveTimeouts": "a circuit breaker, below the level of a high-level picture",
  "META_RULE.maxRowsPerWindow": "storage detail of the Meta ranking",
  "META_RULE.retentionDays": "storage detail of the Meta ranking",
  "META_RULE.dexGroups": "DexScreener call budget of the Meta ranking, below this picture",
  "META_RULE.dexMaxCalls": "DexScreener call budget of the Meta ranking, below this picture",
  "META_RULE.dexCandidates": "DexScreener call budget of the Meta ranking, below this picture",
  "META_RULE.topTokens": "display detail of a Meta row",
  "META_RULE.theme": "clone-cluster merging detail (an object), below this picture",
  "STUDY_CAPTURE_RULE.captureGraceSec": "capture timing detail, below this picture",
  "STUDY_CAPTURE_RULE.metadataAttempts": "capture fetch detail, below this picture",
  "STUDY_CAPTURE_RULE.websiteTextChars": "capture fetch detail, below this picture",
  "STUDY_CAPTURE_RULE.websiteMaxBytes": "capture fetch detail, below this picture",
  "STUDY_CAPTURE_RULE.metadataMaxBytes": "capture fetch detail, below this picture",
  "STUDY_CAPTURE_RULE.websiteTimeoutMs": "capture fetch detail, below this picture",
  "STUDY_CAPTURE_RULE.metadataTimeoutMs": "capture fetch detail, below this picture",
  "STUDY_CAPTURE_RULE.emptyShellMaxVisibleChars": "capture classification detail, below this picture",
};

/** The one-level keys of a config object as `NAME.key`; an array is joined, an object is its JSON. */
function flatten(name: string, obj: object): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(obj) as Array<[string, unknown]>) {
    out[`${name}.${k}`] = typeof v === "number" || typeof v === "string" ? v : Array.isArray(v) ? v.join(", ") : JSON.stringify(v);
  }
  return out;
}

/** What the code has right now: read from the source files and the real constants, nothing typed in. */
function realRegistry(): PipelineRegistry {
  const sourcesDir = join(REPO, "packages/core/src/sources");
  const sourceFiles = readdirSync(sourcesDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const worker = read("apps/worker/src/main.ts");
  return {
    sourceIds: { ...SOURCE_CLASS, ...SOURCE_CLASS_PREFIX },
    sourceClasses: sourceFiles.flatMap((f) => matches(readFileSync(join(sourcesDir, f), "utf8"), /class (\w+) implements Source\b/g)).sort(),
    workerSources: matches(worker, /new (\w+Source)\(/g),
    ticks: matches(worker, /const (\w*[tT]ick) = reentrant\(/g),
    brainTasks: Object.keys(DEFAULT_ROUTING),
    config: {
      ...flatten("DEFAULT_JUDGE_CONFIG", DEFAULT_JUDGE_CONFIG),
      ...flatten("DEFAULT_PROPOSE_CONFIG", DEFAULT_PROPOSE_CONFIG),
      ...flatten("DEFAULT_RESEARCH_BUDGET_CONFIG", DEFAULT_RESEARCH_BUDGET_CONFIG),
      ...flatten("META_RULE", META_RULE),
      ...flatten("STUDY_CAPTURE_RULE", STUDY_CAPTURE_RULE),
      ...flatten("EXPIRY_MS", EXPIRY_MS),
      META_WINDOWS: META_WINDOWS.join(", "),
      MARKET_SOURCE_IDS: MARKET_SOURCE_IDS.join(", "),
      MAX_NEW_PROPOSALS_PER_DAY,
      SEED_GATE_MIN_SCORE,
      MAX_CAPTURE_RUNS_PER_DAY,
    },
    leftOut: LEFT_OUT,
    exists: (repoPath) => existsSync(join(REPO, repoPath)),
  };
}

describe("the pipeline graph is in sync with the code", () => {
  it("has no gap on the current tree", () => {
    expect(pipelineGaps(PIPELINE, realRegistry())).toEqual([]);
  });

  it("the registry really finds what it claims to (so an empty gap list means something)", () => {
    const r = realRegistry();
    expect(r.ticks).toEqual(["buildTick", "ingestTick", "judgeTick", "metaSummaryTick", "metaTick", "proposeTick", "studyTick", "tick"]);
    expect(r.sourceClasses).toEqual(expect.arrayContaining(["BackoffSource", "DexScreenerTrendingSource", "GitHubTrendingSource", "GoogleTrendsSource", "PumpPortalSource", "RssSource"]));
    expect(r.workerSources).toEqual(expect.arrayContaining(["PumpPortalSource", "GoogleTrendsSource"]));
    expect(r.brainTasks).toEqual(["judge", "propose", "spec", "meta-summary", "build"]);
    expect(Object.keys(r.config).length).toBeGreaterThan(30);
  });

  it("draws the ten stages and the three side nodes, with the statuses the Operator decided", () => {
    const byId = new Map(PIPELINE.nodes.map((n) => [n.id, n]));
    for (const id of ["sources", "signals", "narratives", "judge", "proposals", "shortlist", "spec", "approve", "build", "preview", "meta", "beta", "study"]) expect(byId.get(id), id).toBeDefined();
    expect(PIPELINE.nodes.filter((n) => n.onPage !== false)).toHaveLength(13);
    expect(byId.get("beta")!.status).toBe("off");
    expect(byId.get("beta")!.statusNote).toMatch(/slices 3 and 4 are paused/);
    expect(byId.get("beta")!.tickets).toContain(".scratch/viral-sources/issues/04-beta-finder.md");
    const chips = Object.fromEntries(byId.get("sources")!.sources!.map((c) => [c.id, c.status]));
    expect(chips).toEqual({ "rss:": "context-only", "trends:google": "context-only", "github:trending": "context-only", "pumpportal:events": "on", "dexscreener:trending": "on" });
    for (const id of ["sources", "signals", "narratives", "judge", "proposals", "shortlist", "spec", "approve", "build", "preview", "meta", "study"]) expect(byId.get(id)!.status, id).toBe("on");
  });

  it("the Study is plain code: no brain task, and the code has no study task either", () => {
    expect(PIPELINE.nodes.find((n) => n.id === "study")!.brainTask).toBeUndefined();
    expect(Object.keys(DEFAULT_ROUTING)).not.toContain("study");
  });

  it("the market-Signal rule is a labelled gate on the Narratives to Judge edge", () => {
    const edge = PIPELINE.edges.find((e) => e.from === "narratives" && e.to === "judge")!;
    expect(edge.gates).toHaveLength(1);
    expect(edge.gates![0]!.label).toMatch(/market Signal/);
    expect(edge.gates![0]!.ref()).toBe(MARKET_SOURCE_IDS.join(", "));
  });

  it("the buildability gate shows the seed, and the stored Rubric's value (with its version) when the route has it", () => {
    const seeded = resolvePipeline(PIPELINE);
    const gate = (r: ReturnType<typeof resolvePipeline>) => r.edges.find((e) => e.id === "judge-proposals")!.gates[0]!;
    expect(gate(seeded)).toMatchObject({ value: SEED_GATE_MIN_SCORE, display: String(SEED_GATE_MIN_SCORE) });
    expect(gate(seeded).rubricVersion).toBeUndefined();
    const live = resolvePipeline(PIPELINE, { rubric: { version: 4, gateMinScore: 6.5 } });
    expect(gate(live)).toMatchObject({ value: 6.5, display: "6.5", rubricVersion: 4 });
    expect(live.rubric).toEqual({ version: 4, gateMinScore: 6.5 });
  });

  it("the page view leaves out the nodes the page does not draw and the edges that touch them", () => {
    const view = resolvePipeline(PIPELINE);
    expect(view.nodes.map((n) => n.id)).toEqual(["sources", "signals", "narratives", "judge", "proposals", "shortlist", "spec", "approve", "build", "preview", "study", "meta", "beta"]);
    const ids = new Set(view.nodes.map((n) => n.id));
    for (const e of view.edges) expect([ids.has(e.from), ids.has(e.to)]).toEqual([true, true]);
    expect(view.edges.length).toBeGreaterThan(10);
    expect(JSON.stringify(view)).not.toContain("=>"); // plain data: no function reaches the client
  });

  it("shows the real values: a rule's number is the constant's, formatted by its unit", () => {
    const judge = resolvePipeline(PIPELINE).nodes.find((n) => n.id === "judge")!;
    const by = (label: string) => judge.rules.find((r) => r.label === label)!;
    expect(by("Runs every")).toMatchObject({ value: 30 * 60_000, display: "30 min" });
    expect(by("Spend per day")).toMatchObject({ value: DEFAULT_JUDGE_CONFIG.maxDailyUsd, display: "$2" });
    expect(by("Spend per run").display).toBe("$0.10");
    expect(by("Research budget per day").display).toBe("$6");
    expect(by("Research share of the quota").display).toBe("30%");
    expect(formatRuleValue(48 * 3_600_000, "ms")).toBe("48 h");
    expect(formatRuleValue(10_000, "ms")).toBe("10 s");
    expect(formatRuleValue(240 * 60_000, "ms")).toBe("4 h");
    expect(formatRuleValue(1500, "ms")).toBe("1500 ms");
  });

  it("no numeric literal stands for a gate or cap: every rule's ref() is an expression over an imported constant", () => {
    const source = read("packages/core/src/pipeline-graph.ts");
    const refs = [...source.matchAll(/ref:\s*\(\)\s*=>\s*(.+?),\s*unit:/g)].map((m) => m[1]!);
    expect(refs.length).toBe(source.match(/\bref:\s*\(\)\s*=>\s*(?!\s|number)/g)!.length); // every ref sits on one line, so none escapes this check
    expect(refs.length).toBeGreaterThan(40);
    for (const expr of refs) expect(expr.replace(/"[^"]*"/g, ""), `ref: () => ${expr}`).not.toMatch(/\d/);
  });
});

describe("pipelineGaps bites: it reports each kind of drift", () => {
  const withRegistry = (extra: Partial<PipelineRegistry>): string[] => {
    const real = realRegistry();
    return pipelineGaps(PIPELINE, {
      ...real,
      ...extra,
      sourceIds: { ...real.sourceIds, ...extra.sourceIds },
      config: { ...real.config, ...extra.config },
      leftOut: { ...real.leftOut, ...extra.leftOut },
    });
  };
  const withGraph = (graph: PipelineGraph): string[] => pipelineGaps(graph, realRegistry());

  it("a new Source id, a new Source class and a new worker Source", () => {
    expect(withRegistry({ sourceIds: { "fake:source": "market" } })).toEqual([expect.stringContaining('"fake:source"')]);
    const real = realRegistry();
    expect(withRegistry({ sourceClasses: [...real.sourceClasses, "FakeSource"] })).toEqual([expect.stringContaining("FakeSource implements Source")]);
    expect(withRegistry({ workerSources: [...real.workerSources, "FakeSource"] })).toEqual([expect.stringContaining("new FakeSource(")]);
  });

  it("a Source whose class differs from its chip", () => {
    expect(withRegistry({ sourceIds: { "trends:google": "market" } })).toEqual([expect.stringContaining('"trends:google" is class market')]);
  });

  it("a new worker pass and a new brain task", () => {
    const real = realRegistry();
    expect(withRegistry({ ticks: [...real.ticks, "fakeTick"] })).toEqual([expect.stringContaining("fakeTick")]);
    expect(withRegistry({ brainTasks: [...real.brainTasks, "fake-task"] })).toEqual([expect.stringContaining('"fake-task"')]);
  });

  it("a new config key, and a rule whose value or key no longer matches the code", () => {
    expect(withRegistry({ config: { "DEFAULT_JUDGE_CONFIG.fakeCap": 7 } })).toEqual([expect.stringContaining("DEFAULT_JUDGE_CONFIG.fakeCap")]);
    expect(withRegistry({ config: { MAX_NEW_PROPOSALS_PER_DAY: 31 } })).toEqual([expect.stringMatching(/shows 30 but MAX_NEW_PROPOSALS_PER_DAY is 31/)]);
    const real = realRegistry();
    const config = Object.fromEntries(Object.entries(real.config).filter(([k]) => k !== "MAX_CAPTURE_RUNS_PER_DAY"));
    expect(pipelineGaps(PIPELINE, { ...real, config })).toEqual([expect.stringContaining("MAX_CAPTURE_RUNS_PER_DAY, which is not a gate or cap")]);
  });

  it("LEFT_OUT needs a reason and cannot outlive its item", () => {
    expect(withRegistry({ leftOut: { "META_RULE.theme": " " } })).toEqual(expect.arrayContaining([expect.stringContaining("with no reason")]));
    expect(withRegistry({ leftOut: { "ghost.key": "gone" } })).toEqual([expect.stringContaining("ghost.key, which the code no longer has")]);
  });

  it("a broken graph: a missing node, a loose node, a shared cell, a missing file", () => {
    const loose = { id: "loose", label: "Loose", column: 0, row: 9, status: "on", what: "x", rules: [], adrs: [], tickets: [], files: [] } as const;
    expect(withGraph({ ...PIPELINE, edges: [...PIPELINE.edges, { id: "bad", from: "sources", to: "nowhere", label: "x" }] })).toEqual([expect.stringContaining('names the node "nowhere"')]);
    expect(withGraph({ ...PIPELINE, nodes: [...PIPELINE.nodes, loose] })).toEqual([expect.stringContaining('"loose" is not connected')]);
    expect(withGraph({ ...PIPELINE, nodes: [...PIPELINE.nodes, { ...loose, row: 0 }] })).toEqual(expect.arrayContaining([expect.stringContaining("share the grid cell 0,0")]));
    const withFile = PIPELINE.nodes.map((n) => (n.id === "sources" ? { ...n, files: [...n.files, "nope/missing.ts"], adrs: [...n.adrs, "9999-none.md"], tickets: [...n.tickets, ".scratch/none.md"] } : n));
    expect(withGraph({ ...PIPELINE, nodes: withFile })).toEqual([expect.stringContaining("9999-none.md"), expect.stringContaining(".scratch/none.md"), expect.stringContaining("nope/missing.ts")]);
  });

  it("a Source dropped from the graph is reported by id", () => {
    const nodes = PIPELINE.nodes.map((n) => (n.id === "sources" ? { ...n, sources: n.sources!.filter((c) => c.id !== "github:trending") } : n));
    const gaps = withGraph({ ...PIPELINE, nodes });
    expect(gaps).toEqual(expect.arrayContaining([expect.stringContaining('Source "github:trending"'), expect.stringContaining("GitHubTrendingSource")]));
  });
});
