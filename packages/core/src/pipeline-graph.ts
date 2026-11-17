/**
 * The pipeline logic as ONE typed graph (warroom-redesign ticket 10). Three things read it: the War Room's "How it works" page
 * (`GET /api/pipeline`), the generated diagrams in `docs/architecture.md` (`pipeline-diagrams.ts`, `pnpm docs:graph`), and the sync test
 * (`pipeline-graph.test.ts`), which fails when the code gains a Source, a worker pass, a brain task or a cap that this file does not draw.
 *
 * Pure data plus imports of the real constants; no I/O. Every number a rule shows is a `ref()` over an imported constant, never a
 * number typed here, so a value cannot drift from the code (the test fails on a numeric literal inside a `ref`). Only layout
 * (`column`, `row`) is typed in.
 */
import { DEFAULT_ROUTING } from "./brain.ts";
import { BUILD_TICK_MS } from "./build-refusal.ts";
import { MAX_NEW_PROPOSALS_PER_DAY } from "./datastore.ts";
import { EXPIRY_MS, MEME_EXPIRY_MS } from "./expiry.ts";
import { DEFAULT_JUDGE_CONFIG, judgeConfigFromEnv } from "./judge.ts";
import { DEFAULT_MEME_ANGLE_PER_DAY, MAX_MEME_ANGLE_PER_DAY, memeAngleConfigFromEnv } from "./meme/angle.ts";
import { DEFAULT_ANGLE_DAILY_MEME_RUNS, DEFAULT_MEME_CONFIG, MAX_ANGLE_DAILY_MEME_RUNS, MAX_MEME_RUNS_PER_DAY, memeConfigFromEnv } from "./meme/pass.ts";
import { MEME_REFRESH_MS, MEME_TRIO_SIZE, MEME_WINDOW_MS, NEWS_MEME_FLOORS, NEWS_MEME_LIVE_MS } from "./meme/types.ts";
import { META_RULE, META_WINDOWS, metaConfigFromEnv, metaIntervalMinutes } from "./meta/config.ts";
import { DEFAULT_META_GROUP_CONFIG, metaGroupConfigFromEnv } from "./meta/group-pass.ts";
import { DEFAULT_META_SUMMARY_CONFIG, metaSummaryConfigFromEnv } from "./meta/summary-pass.ts";
import { META_SUMMARY_FRESH } from "./meta/summary.ts";
import { DEFAULT_CLUSTER_CONFIG } from "./narratives.ts";
import { DEFAULT_PROPOSE_CONFIG, proposeConfigFromEnv } from "./propose.ts";
import { DEFAULT_RESEARCH_BUDGET_CONFIG, researchBudgetUsd, researchConfigFromEnv } from "./research-budget.ts";
import { SEED_GATE_MIN_SCORE } from "./rubric.ts";
import { MARKET_SOURCE_IDS, type SourceClass } from "./sources/source-class.ts";
import { captureRunCap, MAX_CAPTURE_RUNS_PER_DAY, STUDY_CAPTURE_RULE } from "./study/config.ts";
import { INGEST_TICK_MS, JUDGE_TICK_MS, STUDY_TICK_MS } from "./ticks.ts";

/** `on`: running. `off`: declared off (drawn muted). `context-only`: a Source whose Signals are only background (ADR 0011). */
export type NodeStatus = "on" | "off" | "context-only";

/** How a rule's value is written: the unit decides the display, so the same number never reads two ways. */
export type RuleUnit = "count" | "usd" | "ms" | "min" | "sec" | "hours" | "score" | "share" | "text";

export type Env = Record<string, string | undefined>;

export interface PipelineRule {
  label: string;
  /**
   * Which code constant this rule shows, as `CONSTANT` or `CONSTANT.field` (`DEFAULT_JUDGE_CONFIG.maxPerPass`). The sync test requires
   * every gate and cap in the code to be the `key` of some rule, and checks that `ref()` equals the code's value at that key.
   * A rule with no key shows a derived or incidental figure and covers nothing.
   */
  key?: string;
  /** The value, read from the real constant at call time. */
  ref: () => number | string;
  unit: RuleUnit;
  /**
   * The value the running config uses when an `ARGUS_*` variable overrides the default (`ref` is always the code's default, which the
   * sync test compares). It is called with the War Room process's environment, which is what the worker is assumed to share (the same
   * assumption `GET /api/research` makes); there is no channel to read the worker's own. Absent: no variable can change this value.
   */
  live?: (env: Env) => number | string;
  /** Also written into the generated system overview diagram, beside the node's label. */
  diagram?: boolean;
  /** The value the buildability gate shows is the stored Rubric's, not this seed: the API route overrides it (architecture section 7). */
  liveFrom?: "rubric";
}

/** One Source (or one family of them, the RSS catalog) on the Sources node. */
export interface SourceChip {
  /** The exact Source id as in `SOURCE_CLASS`, or the id prefix (ending in `:`) as in `SOURCE_CLASS_PREFIX`. */
  id: string;
  label: string;
  /** `context-only` for a context-class Source (ADR 0011), `on` for a market one. */
  status: "on" | "context-only";
  /** The class names in `packages/core/src/sources/` that implement it. */
  code: readonly string[];
}

export interface PipelineNode {
  id: string;
  label: string;
  /** Fixed grid cell on the page. Absent only on a node with `onPage: false`. */
  column?: number;
  row?: number;
  /** False for a node the generated diagrams need but the page does not draw (Operator, Telegram, ...). Default true. */
  onPage?: boolean;
  status: NodeStatus;
  /** Why the status is not `on`. */
  statusNote?: string;
  /** One plain sentence. */
  what: string;
  rules: readonly PipelineRule[];
  adrs: readonly string[];
  tickets: readonly string[];
  files: readonly string[];
  /** The worker pass(es) in `apps/worker/src/main.ts` that run it (the `const <name>Tick = reentrant(` names). */
  worker?: string | readonly string[];
  /** The Brain task it spends Claude on (a key of `DEFAULT_ROUTING`). Absent: plain code, no Claude cost. */
  brainTask?: string;
  /** Further Brain tasks the node spends Claude on (the Meta node writes summaries and groups subjects): drawn, counted in the node's live spend, not named on the page. */
  alsoBrainTasks?: readonly string[];
  sources?: readonly SourceChip[];
  /** Shape in the generated overview: a box (default), a store (data kept) or an actor (a person). */
  shape?: "box" | "store" | "actor";
  /** One line written under the label in the generated overview. */
  diagramNote?: string;
}

export interface PipelineEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  /** The key slice b counts for this edge over the last 24 h. */
  metric?: string;
  /** Gates drawn on the edge (a rule that decides whether an item passes). */
  gates?: readonly PipelineRule[];
  /** A decision or a path that does not move an item (the Operator acting, a path not wired yet). */
  dashed?: boolean;
}

export interface PipelineGraph {
  nodes: readonly PipelineNode[];
  edges: readonly PipelineEdge[];
}

const CONTEXT_TICKET = ".scratch/phase-3-feedback/issues/24-context-sources-never-propose.md";
const META_TICKET = ".scratch/viral-sources/issues/03-meta-ranking-from-launchpad-data.md";
const BETA_TICKET = ".scratch/viral-sources/issues/04-beta-finder.md";
const MEME_TICKET = ".scratch/missed-ideas/issues/06-meta-meme-idea-generation.md";
const NEWS_MEME_TICKET = ".scratch/proposal-routing/issues/04-news-meme-proposals.md";
const ANGLE_TICKET = ".scratch/meta-redesign/issues/11-operator-angle-for-meme-ideas.md";
const LAUNCHPAD_CLUSTER_TICKET = ".scratch/viral-sources/issues/01-launchpad-signals-cluster-by-theme.md";

export const PIPELINE: PipelineGraph = {
  nodes: [
    {
      id: "sources",
      label: "Sources",
      column: 0,
      row: 0,
      status: "on",
      diagramNote: "plain code, no Claude",
      what: "Polls the public Sources on a timer and keeps what is new as Signals. Plain code: no Claude runs here.",
      rules: [{ label: "Polled every", ref: () => INGEST_TICK_MS, unit: "ms", diagram: true }],
      adrs: ["0008-github-trending-uses-the-public-search-api.md", "0011-market-signals-decide-eligibility.md"],
      tickets: [CONTEXT_TICKET],
      files: ["apps/worker/src/main.ts", "packages/core/src/sources/source-class.ts", "packages/core/src/ingest.ts", "config/rss-feeds.json"],
      worker: "ingestTick",
      sources: [
        { id: "rss:", label: "RSS catalog", status: "context-only", code: ["RssSource"] },
        { id: "trends:google", label: "Google Trends", status: "context-only", code: ["GoogleTrendsSource"] },
        { id: "github:trending", label: "GitHub trending", status: "context-only", code: ["GitHubTrendingSource"] },
        { id: "pumpportal:events", label: "PumpPortal", status: "on", code: ["PumpPortalSource"] },
        { id: "dexscreener:trending", label: "DexScreener", status: "on", code: ["DexScreenerTrendingSource"] },
      ],
    },
    {
      id: "signals",
      label: "Signals",
      column: 1,
      row: 0,
      shape: "store",
      status: "on",
      what: "Every item a Source reported, normalised and deduplicated. Nothing else reads the Sources directly.",
      rules: [],
      adrs: [],
      tickets: [],
      files: ["packages/core/src/ingest.ts", "packages/core/src/datastore.ts"],
    },
    {
      id: "narratives",
      label: "Narratives",
      column: 2,
      row: 0,
      status: "on",
      diagramNote: "clustering, plain code, no Claude",
      what: "Groups new Signals that mean the same thing into one Narrative, with a local embedding model; token launches and bonds are grouped by the token's name and ticker instead. Plain code: no Claude runs here.",
      rules: [
        { label: "News joins a Narrative at similarity", key: "DEFAULT_CLUSTER_CONFIG.joinThreshold", ref: () => DEFAULT_CLUSTER_CONFIG.joinThreshold, unit: "count" },
        { label: "Joins a Narrative that had a Signal within", key: "DEFAULT_CLUSTER_CONFIG.windowHours", ref: () => DEFAULT_CLUSTER_CONFIG.windowHours, unit: "hours" },
        { label: "Signals in one Narrative, at most", key: "DEFAULT_CLUSTER_CONFIG.maxNarrativeSignals", ref: () => DEFAULT_CLUSTER_CONFIG.maxNarrativeSignals, unit: "count" },
        { label: "Signals a token Narrative needs before a headline joins it", key: "DEFAULT_CLUSTER_CONFIG.crossMinSignals", ref: () => DEFAULT_CLUSTER_CONFIG.crossMinSignals, unit: "count" },
        { label: "Recent headlines a linking phrase may appear in, at most", key: "DEFAULT_CLUSTER_CONFIG.crossMaxDocFreq", ref: () => DEFAULT_CLUSTER_CONFIG.crossMaxDocFreq, unit: "count" },
      ],
      adrs: ["0007-narratives-use-an-in-process-semantic-embedder.md"],
      tickets: [LAUNCHPAD_CLUSTER_TICKET],
      files: ["packages/core/src/narratives.ts", "packages/core/src/launchpad-cluster.ts", "packages/core/src/launchpad-subject.ts", "apps/worker/src/semantic-embedder.ts"],
      worker: "ingestTick",
    },
    {
      id: "judge",
      label: "Judge",
      column: 3,
      row: 0,
      status: "on",
      what: "Claude judges each new or changed Narrative against the Rubric and stores a Score per dimension.",
      rules: [
        { label: "Runs every", ref: () => JUDGE_TICK_MS, unit: "ms", diagram: true },
        { label: "Signals a news Narrative needs", key: "DEFAULT_JUDGE_CONFIG.minSignals", ref: () => DEFAULT_JUDGE_CONFIG.minSignals, unit: "count", live: (env) => judgeConfigFromEnv(env).minSignals },
        { label: "Looks back", key: "DEFAULT_JUDGE_CONFIG.windowHours", ref: () => DEFAULT_JUDGE_CONFIG.windowHours, unit: "hours" },
        { label: "Narratives per pass", key: "DEFAULT_JUDGE_CONFIG.maxPerPass", ref: () => DEFAULT_JUDGE_CONFIG.maxPerPass, unit: "count", live: (env) => judgeConfigFromEnv(env).maxPerPass },
        { label: "Runs per day", key: "DEFAULT_JUDGE_CONFIG.maxRunsPerDay", ref: () => DEFAULT_JUDGE_CONFIG.maxRunsPerDay, unit: "count", live: (env) => judgeConfigFromEnv(env).maxRunsPerDay },
        { label: "Spend per day", key: "DEFAULT_JUDGE_CONFIG.maxDailyUsd", ref: () => DEFAULT_JUDGE_CONFIG.maxDailyUsd, unit: "usd", live: (env) => judgeConfigFromEnv(env).maxDailyUsd },
        { label: "Spend per run", key: "DEFAULT_ROUTING.judge.maxBudgetUsd", ref: () => DEFAULT_ROUTING.judge.maxBudgetUsd, unit: "usd" },
        { label: "Wall clock per run", key: "DEFAULT_ROUTING.judge.timeoutMs", ref: () => DEFAULT_ROUTING.judge.timeoutMs, unit: "ms" },
        { label: "Model", ref: () => DEFAULT_ROUTING.judge.model, unit: "text" },
        { label: "Research daily quota (judge and propose)", key: "DEFAULT_RESEARCH_BUDGET_CONFIG.dailyQuotaUsd", ref: () => DEFAULT_RESEARCH_BUDGET_CONFIG.dailyQuotaUsd, unit: "usd", live: (env) => researchConfigFromEnv(env).dailyQuotaUsd },
        { label: "Research share of the quota", key: "DEFAULT_RESEARCH_BUDGET_CONFIG.share", ref: () => DEFAULT_RESEARCH_BUDGET_CONFIG.share, unit: "share", live: (env) => researchConfigFromEnv(env).share },
        { label: "Research budget per day", ref: () => researchBudgetUsd(DEFAULT_RESEARCH_BUDGET_CONFIG), unit: "usd", live: (env) => researchBudgetUsd(researchConfigFromEnv(env)) },
      ],
      adrs: ["0001-claude-code-headless-brain-with-api-fallback.md", "0011-market-signals-decide-eligibility.md"],
      tickets: [CONTEXT_TICKET],
      files: ["packages/core/src/judge.ts", "packages/core/src/research-budget.ts", "packages/core/src/rubric.ts", ".claude/skills/judge/SKILL.md"],
      worker: "judgeTick",
      brainTask: "judge",
    },
    {
      id: "proposals",
      label: "Proposals",
      column: 4,
      row: 0,
      shape: "store",
      status: "on",
      what: "Claude turns each Narrative that passed the gate into a Proposal: a name, a ticker and a Tech to build. The Operator sees it as a card.",
      rules: [
        { label: "New Proposals per day", key: "DEFAULT_PROPOSE_CONFIG.maxNewPerDay", ref: () => DEFAULT_PROPOSE_CONFIG.maxNewPerDay, unit: "count", diagram: true, live: (env) => proposeConfigFromEnv(env).maxNewPerDay },
        { label: "New Proposals per day, hard cap", key: "MAX_NEW_PROPOSALS_PER_DAY", ref: () => MAX_NEW_PROPOSALS_PER_DAY, unit: "count" },
        { label: "Narratives per pass", key: "DEFAULT_PROPOSE_CONFIG.maxPerPass", ref: () => DEFAULT_PROPOSE_CONFIG.maxPerPass, unit: "count", live: (env) => proposeConfigFromEnv(env).maxPerPass },
        { label: "Runs per day", key: "DEFAULT_PROPOSE_CONFIG.maxRunsPerDay", ref: () => DEFAULT_PROPOSE_CONFIG.maxRunsPerDay, unit: "count", live: (env) => proposeConfigFromEnv(env).maxRunsPerDay },
        { label: "Needs a Signal within", key: "DEFAULT_PROPOSE_CONFIG.windowHours", ref: () => DEFAULT_PROPOSE_CONFIG.windowHours, unit: "hours" },
        { label: "Migrated examples in the prompt", key: "DEFAULT_PROPOSE_CONFIG.migratedExamples", ref: () => DEFAULT_PROPOSE_CONFIG.migratedExamples, unit: "count", live: (env) => proposeConfigFromEnv(env).migratedExamples },
        { label: "Spend per run", key: "DEFAULT_ROUTING.propose.maxBudgetUsd", ref: () => DEFAULT_ROUTING.propose.maxBudgetUsd, unit: "usd" },
        { label: "Wall clock per run", key: "DEFAULT_ROUTING.propose.timeoutMs", ref: () => DEFAULT_ROUTING.propose.timeoutMs, unit: "ms" },
        { label: "Model", ref: () => DEFAULT_ROUTING.propose.model, unit: "text" },
        { label: "Closed as stale after", key: "EXPIRY_MS.new", ref: () => EXPIRY_MS.new ?? "never", unit: "ms" },
      ],
      adrs: ["0011-market-signals-decide-eligibility.md"],
      tickets: [],
      files: ["packages/core/src/propose.ts", "packages/core/src/collision.ts", "packages/core/src/expiry.ts", ".claude/skills/propose/SKILL.md"],
      worker: "proposeTick",
      brainTask: "propose",
    },
    {
      id: "shortlist",
      label: "Shortlist",
      column: 5,
      row: 0,
      status: "on",
      what: "The Operator's first decision. Shortlisting starts one paid Spec run; the Operator can undo it until the Spec is approved.",
      rules: [{ label: "Closed as stale after", key: "EXPIRY_MS.shortlisted", ref: () => EXPIRY_MS.shortlisted ?? "never", unit: "ms" }],
      adrs: [],
      tickets: [],
      files: ["packages/core/src/lifecycle.ts", "packages/core/src/expiry.ts"],
      worker: "tick",
    },
    {
      id: "spec",
      label: "Spec",
      column: 6,
      row: 0,
      status: "on",
      diagramNote: "drafted on shortlist",
      what: "Claude drafts a build Spec for the shortlisted Proposal; the Operator edits it in the War Room.",
      rules: [
        { label: "Spend per run", key: "DEFAULT_ROUTING.spec.maxBudgetUsd", ref: () => DEFAULT_ROUTING.spec.maxBudgetUsd, unit: "usd" },
        { label: "Wall clock per run", key: "DEFAULT_ROUTING.spec.timeoutMs", ref: () => DEFAULT_ROUTING.spec.timeoutMs, unit: "ms" },
        { label: "Model", ref: () => DEFAULT_ROUTING.spec.model, unit: "text" },
      ],
      adrs: ["0003-one-build-archetype-via-template-repo.md"],
      tickets: [],
      files: ["packages/core/src/spec-drafting.ts", ".claude/skills/spec/SKILL.md"],
      worker: "tick",
      brainTask: "spec",
    },
    {
      id: "approve",
      label: "Approve",
      column: 7,
      row: 0,
      status: "on",
      what: "The Operator approves the Spec. This is the one gate before a Build, and one function (`approve()`) makes it, so a rule could replace the click later.",
      rules: [],
      adrs: [],
      tickets: [],
      files: ["packages/core/src/lifecycle.ts"],
      worker: "tick",
    },
    {
      id: "build",
      label: "Build",
      column: 8,
      row: 0,
      status: "on",
      diagramNote: "Build Runner, one Build at a time",
      what: "Builds the approved Spec as a Cloudflare Workers web app in a rootless container, one Build at a time. The call sequence is in docs/architecture.md section 4.",
      rules: [
        { label: "Queue checked every", ref: () => BUILD_TICK_MS, unit: "ms" },
        { label: "Spend per Build run", key: "DEFAULT_ROUTING.build.maxBudgetUsd", ref: () => DEFAULT_ROUTING.build.maxBudgetUsd, unit: "usd" },
        { label: "Wall clock", key: "DEFAULT_ROUTING.build.timeoutMs", ref: () => DEFAULT_ROUTING.build.timeoutMs, unit: "ms" },
        { label: "Model", ref: () => DEFAULT_ROUTING.build.model, unit: "text" },
      ],
      adrs: ["0003-one-build-archetype-via-template-repo.md", "0005-builds-run-in-a-rootless-podman-container.md"],
      tickets: [],
      files: ["packages/core/src/build-runner.ts", "packages/core/src/sandbox.ts", "packages/core/src/brain.ts", "docs/architecture.md"],
      worker: "buildTick",
      brainTask: "build",
    },
    {
      id: "preview",
      label: "Preview",
      column: 9,
      row: 0,
      status: "on",
      what: "The built app on workers.dev. argus crawls it itself before it counts as built. The Operator launches the token elsewhere (newpairspam).",
      rules: [],
      adrs: ["0002-argus-does-not-launch-tokens.md"],
      tickets: [],
      files: ["packages/core/src/build-runner.ts", "packages/core/src/disclosure.ts"],
    },
    {
      id: "study",
      label: "Study",
      column: 0,
      row: 1,
      status: "on",
      diagramNote: "plain code, no Claude: PumpPortal create and migrate, Snapshots, chain labels",
      what: "Records every PumpPortal create and migrate and takes a Snapshot of each new token at a fixed age. Plain code: no Claude runs, so no spend.",
      rules: [
        { label: "Capture pass every", ref: () => STUDY_TICK_MS, unit: "ms" },
        { label: "Capture rule version", key: "STUDY_CAPTURE_RULE.version", ref: () => STUDY_CAPTURE_RULE.version, unit: "count" },
        { label: "Metadata and website Snapshot at age", key: "STUDY_CAPTURE_RULE.snapshotAgeSec", ref: () => STUDY_CAPTURE_RULE.snapshotAgeSec, unit: "sec" },
        { label: "X capture at age", key: "STUDY_CAPTURE_RULE.xCaptureAgeSec", ref: () => STUDY_CAPTURE_RULE.xCaptureAgeSec, unit: "sec" },
        { label: "Fast migration within", key: "STUDY_CAPTURE_RULE.fastMigrationSec", ref: () => STUDY_CAPTURE_RULE.fastMigrationSec, unit: "sec" },
        { label: "Captures per day, hard cap", key: "MAX_CAPTURE_RUNS_PER_DAY", ref: () => MAX_CAPTURE_RUNS_PER_DAY, unit: "count", live: (env) => captureRunCap(env) },
      ],
      adrs: ["0009-x-capture-through-a-dedicated-logged-in-browser.md"],
      tickets: [".scratch/phase-3-feedback/issues/02-snapshot-metadata-and-website.md", ".scratch/phase-3-feedback/issues/06-x-capture-job.md"],
      files: ["packages/core/src/study/config.ts", "packages/core/src/study/capture.ts", "packages/core/src/study/store.ts"],
      worker: "studyTick",
    },
    {
      id: "meta",
      label: "Meta",
      column: 1,
      row: 1,
      status: "on",
      what: "A Meta is a current trend with a token really high (ADR 0014, ADR 0015): plain code reads what is trending now on Jupiter and GeckoTerminal, drops fakes and tokenized stocks, has DexScreener verify each survivor's market cap, matches the leader token (of any age) to the launch theme that copies it (launches on the pump and bonk launchpads both count as copiers), and stores at most 3 Metas and up to 3 Watching subjects, with hysteresis. The old launch-theme ranking (clone clusters of the last day's creates, \"All launch themes\" on /meta) keeps running as context, with counts only. Each tick Claude also groups the trending tokens and the top 30 launch themes into named subjects (so Lucia, Vice City and GTA VI are one subject), reusing the last answer while nothing changed and stopping at a daily cap; with no answer plain code names a subject by the creators who used the name most, merging spelling aliases strictly. It decides only grouping and names: the leader, the market caps and the copier counts are computed by code from the members. Plain code also raises New Meta, one event each time a subject becomes a Meta; Claude writes a one-line summary, for the Metas and the Watching subjects (at most 6), which also sees the matching news as context.",
      rules: [
        { label: "A token's market cap makes its subject a Meta at", key: "META_RULE.enterMcapUsd", ref: () => META_RULE.enterMcapUsd, unit: "usd", live: (env) => metaConfigFromEnv(env).enterMcapUsd },
        { label: "A Meta stays one while its leader is at least", key: "META_RULE.stayMcapUsd", ref: () => META_RULE.stayMcapUsd, unit: "usd", live: (env) => metaConfigFromEnv(env).stayMcapUsd },
        { label: "Distinct creators in 24 h to become a Meta or be Watching", key: "META_RULE.minCopies", ref: () => META_RULE.minCopies, unit: "count", live: (env) => metaConfigFromEnv(env).minCopies },
        { label: "Metas, at most", key: "META_RULE.maxMetas", ref: () => META_RULE.maxMetas, unit: "count", live: (env) => metaConfigFromEnv(env).maxMetas },
        { label: "Watching subjects, at most", key: "META_RULE.watching", ref: () => META_RULE.watching, unit: "count", live: (env) => metaConfigFromEnv(env).watching },
        { label: "DexScreener calls per tick to verify the leaders' market caps", key: "META_RULE.leaderCalls", ref: () => META_RULE.leaderCalls, unit: "count", live: (env) => metaConfigFromEnv(env).leaderCalls },
        { label: "Requests per tick to the two trending lists (Jupiter, GeckoTerminal), retries included", key: "META_RULE.topDownCalls", ref: () => META_RULE.topDownCalls, unit: "count", live: (env) => metaConfigFromEnv(env).topDownCalls },
        { label: "A trending token needs liquidity of at least", key: "META_RULE.topDownMinLiquidityUsd", ref: () => META_RULE.topDownMinLiquidityUsd, unit: "usd", live: (env) => metaConfigFromEnv(env).topDownMinLiquidityUsd },
        { label: "A trending token's market cap may be at most this many times its liquidity", key: "META_RULE.topDownMaxCapLiquidityRatio", ref: () => META_RULE.topDownMaxCapLiquidityRatio, unit: "count", live: (env) => metaConfigFromEnv(env).topDownMaxCapLiquidityRatio },
        { label: "A trending token needs 24 h volume of at least", key: "META_RULE.topDownMinVolumeUsd", ref: () => META_RULE.topDownMinVolumeUsd, unit: "usd", live: (env) => metaConfigFromEnv(env).topDownMinVolumeUsd },
        { label: "Jupiter organic score at which the list's liquidity counts in DexScreener's verification", key: "META_RULE.topDownMinOrganicScore", ref: () => META_RULE.topDownMinOrganicScore, unit: "score", live: (env) => metaConfigFromEnv(env).topDownMinOrganicScore },
        { label: "Earlier Meta state older than this is not carried", key: "META_RULE.stateMaxMinutes", ref: () => META_RULE.stateMaxMinutes, unit: "min", live: (env) => metaConfigFromEnv(env).stateMaxMinutes },
        { label: "Ranked every", key: "DEFAULT_META_INTERVAL_MINUTES", ref: () => metaIntervalMinutes({}), unit: "min", diagram: true, live: (env) => metaIntervalMinutes(env) },
        { label: "Windows", key: "META_WINDOWS", ref: () => META_WINDOWS.join(", "), unit: "text" },
        { label: "Rank order, first decides", key: "META_RULE.rankOrder", ref: () => META_RULE.rankOrder.join(", "), unit: "text", live: (env) => metaConfigFromEnv(env).rankOrder.join(", ") },
        { label: "Tokens a Meta needs", key: "META_RULE.minTokens", ref: () => META_RULE.minTokens, unit: "count", live: (env) => metaConfigFromEnv(env).minTokens },
        { label: "Distinct creators a Meta needs", key: "META_RULE.minCreators", ref: () => META_RULE.minCreators, unit: "count", live: (env) => metaConfigFromEnv(env).minCreators },
        { label: "Judge and propose skip the Metas when covered hours of 24 are below", key: "META_RULE.coverageNoteBelow", ref: () => META_RULE.coverageNoteBelow, unit: "share", live: (env) => metaConfigFromEnv(env).coverageNoteBelow },
        { label: "Counted as organic after", key: "META_RULE.organicAfterSec", ref: () => META_RULE.organicAfterSec, unit: "sec" },
        { label: "A New Meta event stays live (War Room alert, meme trigger) for", key: "META_RULE.newMetaLiveHours", ref: () => META_RULE.newMetaLiveHours, unit: "hours" },
        { label: "Summaries per day", key: "DEFAULT_META_SUMMARY_CONFIG.maxRunsPerDay", ref: () => DEFAULT_META_SUMMARY_CONFIG.maxRunsPerDay, unit: "count", live: (env) => metaSummaryConfigFromEnv(env).maxRunsPerDay },
        { label: "Summary spend per day", key: "DEFAULT_META_SUMMARY_CONFIG.maxDailyUsd", ref: () => DEFAULT_META_SUMMARY_CONFIG.maxDailyUsd, unit: "usd", live: (env) => metaSummaryConfigFromEnv(env).maxDailyUsd },
        { label: "A summary shows for at most", key: "META_SUMMARY_FRESH.maxAgeHours", ref: () => META_SUMMARY_FRESH.maxAgeHours, unit: "hours" },
        { label: "Summary spend per run", key: "DEFAULT_ROUTING.meta-summary.maxBudgetUsd", ref: () => DEFAULT_ROUTING["meta-summary"].maxBudgetUsd, unit: "usd" },
        { label: "Summary wall clock per run", key: "DEFAULT_ROUTING.meta-summary.timeoutMs", ref: () => DEFAULT_ROUTING["meta-summary"].timeoutMs, unit: "ms" },
        { label: "Summary model", ref: () => DEFAULT_ROUTING["meta-summary"].model, unit: "text" },
        { label: "Claude groups and names the subjects each tick", key: "DEFAULT_META_GROUP_CONFIG.enabled", ref: () => String(DEFAULT_META_GROUP_CONFIG.enabled), unit: "text", live: (env) => String(metaGroupConfigFromEnv(env).enabled) },
        { label: "Grouping spend per day", key: "DEFAULT_META_GROUP_CONFIG.maxDailyUsd", ref: () => DEFAULT_META_GROUP_CONFIG.maxDailyUsd, unit: "usd", live: (env) => metaGroupConfigFromEnv(env).maxDailyUsd },
        { label: "An unchanged grouping is reused for up to", key: "DEFAULT_META_GROUP_CONFIG.reuseMinutes", ref: () => DEFAULT_META_GROUP_CONFIG.reuseMinutes, unit: "min", live: (env) => metaGroupConfigFromEnv(env).reuseMinutes },
        { label: "Grouping spend per run", key: "DEFAULT_ROUTING.meta-group.maxBudgetUsd", ref: () => DEFAULT_ROUTING["meta-group"].maxBudgetUsd, unit: "usd" },
        { label: "Grouping wall clock per run", key: "DEFAULT_ROUTING.meta-group.timeoutMs", ref: () => DEFAULT_ROUTING["meta-group"].timeoutMs, unit: "ms" },
        { label: "Grouping model", ref: () => DEFAULT_ROUTING["meta-group"].model, unit: "text" },
      ],
      adrs: ["0012-metas-are-ranked-from-launchpad-data-by-plain-code.md", "0014-a-meta-is-led-by-a-tokens-market-cap.md", "0015-metas-are-found-top-down.md"],
      tickets: [META_TICKET, ".scratch/meta-redesign/issues/01-market-led-meta-rule.md", ".scratch/meta-redesign/issues/03-new-meta-event-meme-trigger-summaries-prompt.md", ".scratch/meta-redesign/issues/05-top-down-leader-sources.md", ".scratch/meta-redesign/issues/06-ai-grouping-and-naming-with-rule-fallback.md"],
      files: ["packages/core/src/meta/compute.ts", "packages/core/src/meta/leaders.ts", "packages/core/src/meta/grouping.ts", "packages/core/src/meta/group-pass.ts", ".claude/skills/meta-group/SKILL.md", "packages/core/src/meta/topdown.ts", "packages/core/src/meta/topdown-source.ts", "packages/core/src/sources/jupiter.ts", "packages/core/src/sources/geckoterminal.ts", "packages/core/src/meta/config.ts", "packages/core/src/meta/summary-pass.ts", "packages/core/src/meta/new-meta.ts", "packages/core/src/meta/news.ts"],
      worker: ["metaTick", "metaSummaryTick"],
      brainTask: "meta-summary",
      alsoBrainTasks: ["meta-group"],
    },
    {
      id: "meme",
      label: "Meme ideas",
      column: 2,
      row: 1,
      status: "off",
      statusNote: "Off until the Operator sets ARGUS_MEME_IDEAS=1 in the worker's environment (the switch defaults to off). The 2026-11-18 backtest re-run is an input to turning it on.",
      diagramNote: "New Meta, then every 12 h, one sonnet run, 3 ideas",
      what: "When a subject becomes a Meta, and again every 12 hours while it stays one, one sonnet run writes three meme ideas for it (a name, ticker, angle, X post and image idea as text). After the Metas, a news story that failed the buildability gate (so it has no Tech) but passes the legitimacy, hook and momentum floors gets one trio too, from the same task and the same daily cap. They become meme Proposals: no Spec, no Build, no Score of their own, and they close after 12 hours unless shortlisted. The room-left ranking is an input to a Meta's prompt, and a name that copies a token of the Meta is refused. Watching subjects get no ideas, and a story that names a Meta or a Watching subject is left to it.",
      rules: [
        { label: "Ideas per run", key: "MEME_TRIO_SIZE", ref: () => MEME_TRIO_SIZE, unit: "count" },
        { label: "A Meta gets ideas again every", key: "MEME_REFRESH_MS", ref: () => MEME_REFRESH_MS, unit: "ms", diagram: true },
        { label: "A new trio is refused within (of the last one)", key: "MEME_WINDOW_MS", ref: () => MEME_WINDOW_MS, unit: "ms" },
        { label: "Runs per day", key: "DEFAULT_MEME_CONFIG.maxRunsPerDay", ref: () => DEFAULT_MEME_CONFIG.maxRunsPerDay, unit: "count", diagram: true, live: (env) => memeConfigFromEnv(env).config.maxRunsPerDay },
        { label: "Runs per day, hard cap", key: "MAX_MEME_RUNS_PER_DAY", ref: () => MAX_MEME_RUNS_PER_DAY, unit: "count" },
        { label: "Operator angle requests per day (they share the runs above)", key: "DEFAULT_MEME_ANGLE_PER_DAY", ref: () => DEFAULT_MEME_ANGLE_PER_DAY, unit: "count", live: (env) => memeAngleConfigFromEnv(env).maxPerDay },
        { label: "Operator angle requests per day, hard cap", key: "MAX_MEME_ANGLE_PER_DAY", ref: () => MAX_MEME_ANGLE_PER_DAY, unit: "count" },
        { label: "Angle runs per day, their own allowance apart from the runs above", key: "DEFAULT_ANGLE_DAILY_MEME_RUNS", ref: () => DEFAULT_ANGLE_DAILY_MEME_RUNS, unit: "count" },
        { label: "Angle runs per day, hard cap", key: "MAX_ANGLE_DAILY_MEME_RUNS", ref: () => MAX_ANGLE_DAILY_MEME_RUNS, unit: "count" },
        { label: "Spend per run", key: "DEFAULT_ROUTING.meme-ideas.maxBudgetUsd", ref: () => DEFAULT_ROUTING["meme-ideas"].maxBudgetUsd, unit: "usd" },
        { label: "Wall clock per run", key: "DEFAULT_ROUTING.meme-ideas.timeoutMs", ref: () => DEFAULT_ROUTING["meme-ideas"].timeoutMs, unit: "ms" },
        { label: "Model", ref: () => DEFAULT_ROUTING["meme-ideas"].model, unit: "text" },
        { label: "Closed as stale after (new)", key: "MEME_EXPIRY_MS.new", ref: () => MEME_EXPIRY_MS.new ?? "never", unit: "ms" },
        { label: "A news story needs a Signal newer than", key: "NEWS_MEME_LIVE_MS", ref: () => NEWS_MEME_LIVE_MS, unit: "ms" },
      ],
      adrs: ["0013-a-proposal-has-a-kind-narrative-or-meme.md", "0012-metas-are-ranked-from-launchpad-data-by-plain-code.md"],
      tickets: [MEME_TICKET, BETA_TICKET, NEWS_MEME_TICKET, ANGLE_TICKET],
      files: ["packages/core/src/meme/pass.ts", "packages/core/src/meme/ideas.ts", "packages/core/src/meme/angle.ts", "packages/core/src/beta/room-left.ts", "packages/core/src/beta/distinct-name.ts", ".claude/skills/meme-ideas/SKILL.md"],
      worker: ["memeIdeasTick", "memeAngleTick"],
      brainTask: "meme-ideas",
    },
    // Nodes the generated diagrams need but the page does not draw.
    { id: "operator", label: "Operator", onPage: false, shape: "actor", status: "on", what: "The person who decides at every gate.", rules: [], adrs: [], tickets: [], files: [] },
    { id: "warroom", label: "War Room (localhost)", onPage: false, status: "on", what: "Where the Operator reads and acts.", rules: [], adrs: [], tickets: [], files: [] },
    { id: "telegram", label: "Telegram, notify only", onPage: false, status: "on", what: "Tells the Team about new Proposals and Builds.", rules: [], adrs: [], tickets: [], files: [] },
    { id: "handoff", label: "Launch handoff: newpairspam form prefilled", onPage: false, status: "on", what: "Opens the token form elsewhere. argus never launches (ADR 0002).", rules: [], adrs: [], tickets: [], files: [] },
    { id: "marked", label: "Operator marks launched + mint", onPage: false, status: "on", what: "The Operator records the launch.", rules: [], adrs: [], tickets: [], files: [] },
    { id: "playbook", label: "Playbook: lessons and Rubric changes", onPage: false, shape: "store", status: "on", what: "What the Study learned, approved by the Operator.", rules: [], adrs: [], tickets: [], files: [] },
    { id: "review", label: "War Room: Study page and weekly Playbook review", onPage: false, status: "on", what: "Where the Operator reviews lessons.", rules: [], adrs: [], tickets: [], files: [] },
  ],
  edges: [
    { id: "sources-signals", from: "sources", to: "signals", label: "poll, normalise, dedupe", metric: "signals_ingested" },
    { id: "signals-narratives", from: "signals", to: "narratives", label: "cluster by meaning", metric: "narratives_created" },
    {
      id: "narratives-judge",
      from: "narratives",
      to: "judge",
      label: "judge new or changed Narratives",
      metric: "narratives_judged",
      gates: [{ label: "Needs a market Signal from", key: "MARKET_SOURCE_IDS", ref: () => MARKET_SOURCE_IDS.join(", "), unit: "text" }],
    },
    {
      id: "judge-proposals",
      from: "judge",
      to: "proposals",
      label: "Score passes the buildability gate",
      metric: "proposals_created",
      gates: [{ label: "Buildability gate, minimum", key: "SEED_GATE_MIN_SCORE", ref: () => SEED_GATE_MIN_SCORE, unit: "score", liveFrom: "rubric" }],
    },
    {
      id: "judge-meme",
      from: "judge",
      to: "meme",
      label: "news story fails the buildability gate, passes the floors",
      gates: [
        { label: "Legitimacy, minimum", key: "NEWS_MEME_FLOORS.legitimacy", ref: () => NEWS_MEME_FLOORS.legitimacy, unit: "score" },
        { label: "Hook, minimum", key: "NEWS_MEME_FLOORS.hook", ref: () => NEWS_MEME_FLOORS.hook, unit: "score" },
        { label: "Momentum, minimum", key: "NEWS_MEME_FLOORS.momentum", ref: () => NEWS_MEME_FLOORS.momentum, unit: "score" },
      ],
    },
    { id: "proposals-shortlist", from: "proposals", to: "shortlist", label: "Operator shortlists", metric: "shortlisted" },
    { id: "shortlist-spec", from: "shortlist", to: "spec", label: "Spec drafted on shortlist", metric: "spec_drafted" },
    { id: "spec-approve", from: "spec", to: "approve", label: "Operator edits and approves", metric: "approved" },
    { id: "approve-build", from: "approve", to: "build", label: "queued, one Build at a time", metric: "build_finished" },
    { id: "build-preview", from: "build", to: "preview", label: "wrangler deploy to workers.dev", metric: "built" },
    { id: "sources-study", from: "sources", to: "study", label: "PumpPortal create and migrate", metric: "creates_seen" },
    { id: "sources-meta", from: "sources", to: "meta", label: "launchpad creates" },
    { id: "sources-meta-jupiter", from: "sources", to: "meta", label: "Jupiter trending (market cap, liquidity, volume)" },
    { id: "sources-meta-gecko", from: "sources", to: "meta", label: "GeckoTerminal trending (3 pages)" },
    { id: "sources-meta-trending", from: "sources", to: "meta", label: "leaders' market caps verified on DexScreener" },
    { id: "signals-meta", from: "signals", to: "meta", label: "matching news: context only, never a trigger" },
    { id: "meta-warroom", from: "meta", to: "warroom", label: "New Meta" },
    { id: "meta-judge", from: "meta", to: "judge", label: "Meta block in the prompt" },
    { id: "meta-proposals", from: "meta", to: "proposals", label: "Meta block in the prompt" },
    { id: "meta-meme", from: "meta", to: "meme", label: "new Meta, then every 12 h, cap 8 a day, room-left as a reason" },
    { id: "meme-proposals", from: "meme", to: "proposals", label: "3 meme Proposals per run", metric: "memes_created" },
    // Off the page: what the old hand-drawn overview also showed.
    { id: "proposals-warroom", from: "proposals", to: "warroom", label: "list" },
    { id: "proposals-telegram", from: "proposals", to: "telegram", label: "notify" },
    { id: "warroom-operator", from: "warroom", to: "operator", label: "reads" },
    { id: "operator-shortlist", from: "operator", to: "shortlist", label: "shortlist", dashed: true },
    { id: "operator-approve", from: "operator", to: "approve", label: "approve", dashed: true },
    { id: "preview-warroom", from: "preview", to: "warroom", label: "preview link" },
    { id: "warroom-handoff", from: "warroom", to: "handoff", label: "Launch button" },
    { id: "handoff-operator", from: "handoff", to: "operator", label: "launches outside argus", dashed: true },
    { id: "operator-marked", from: "operator", to: "marked", label: "after the launch" },
    { id: "marked-proposals", from: "marked", to: "proposals", label: "status launched" },
    { id: "marked-study", from: "marked", to: "study", label: "mint read-only at 1h, 24h, 7d" },
    { id: "study-playbook", from: "study", to: "playbook", label: "lesson candidates" },
    { id: "playbook-review", from: "playbook", to: "review", label: "weekly review" },
    { id: "review-operator", from: "review", to: "operator", label: "reads" },
    { id: "operator-playbook", from: "operator", to: "playbook", label: "approves lessons", dashed: true },
    { id: "playbook-judge", from: "playbook", to: "judge", label: "approved lessons, versioned" },
    { id: "playbook-proposals", from: "playbook", to: "proposals", label: "approved lessons, versioned" },
  ],
};

export const isOnPage = (n: PipelineNode): boolean => n.onPage !== false;
const workersOf = (n: PipelineNode): string[] => (n.worker === undefined ? [] : typeof n.worker === "string" ? [n.worker] : [...n.worker]);
const allRules = (graph: PipelineGraph): PipelineRule[] => [...graph.nodes.flatMap((n) => [...n.rules]), ...graph.edges.flatMap((e) => [...(e.gates ?? [])])];

// ---------------------------------------------------------------- display

const trimNumber = (v: number): string => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2))));

/** The text a rule's value is shown as. */
export function formatRuleValue(value: number | string, unit: RuleUnit): string {
  if (typeof value === "string") return value;
  switch (unit) {
    case "usd":
      return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
    case "ms": {
      if (value >= 3_600_000 && value % 3_600_000 === 0) return `${trimNumber(value / 3_600_000)} h`;
      if (value >= 60_000 && value % 60_000 === 0) return `${trimNumber(value / 60_000)} min`;
      if (value >= 1_000 && value % 1_000 === 0) return `${trimNumber(value / 1_000)} s`;
      return `${trimNumber(value)} ms`;
    }
    case "min":
      return `${trimNumber(value)} min`;
    case "sec":
      return `${trimNumber(value)} s`;
    case "hours":
      return `${trimNumber(value)} h`;
    case "share":
      return `${trimNumber(value * 100)}%`;
    default:
      return trimNumber(value);
  }
}

// ---------------------------------------------------------------- the page's view

export interface PipelineRuleView {
  label: string;
  key?: string;
  value: number | string;
  unit: RuleUnit;
  /** `value` as the unit writes it. `value` is what the running config uses (an `ARGUS_*` override, or the stored Rubric's gate). */
  display: string;
  /** Set only when the effective value differs from the code's default: the default, and how it is written. */
  defaultValue?: number | string;
  defaultDisplay?: string;
  /** Set when the value is the stored Rubric's, and which version. */
  rubricVersion?: number;
  /** Set when an `ARGUS_*` variable is invalid (the worker would refuse to start): the default is shown and this says why. */
  envError?: string;
}

export interface PipelineNodeView {
  id: string;
  label: string;
  column: number;
  row: number;
  status: NodeStatus;
  statusNote?: string;
  what: string;
  rules: PipelineRuleView[];
  adrs: string[];
  tickets: string[];
  files: string[];
  worker: string[];
  brainTask?: string;
  sources: SourceChip[];
}

export interface PipelineEdgeView {
  id: string;
  from: string;
  to: string;
  label: string;
  metric?: string;
  dashed: boolean;
  gates: PipelineRuleView[];
}

/** What `GET /api/pipeline` returns: the on-page part of the graph with every rule's value read from the code (or the stored Rubric). */
export interface PipelineResponse {
  nodes: PipelineNodeView[];
  edges: PipelineEdgeView[];
  rubric: { version: number; gateMinScore: number } | null;
  /** Where the limit values come from: the War Room process's `ARGUS_*` variables (may differ from the worker's), or the code's defaults when none were given. */
  envSource: "warroom-process" | "defaults";
}

/** The graph as the page draws it: functions evaluated, off-page nodes and the edges that touch them left out. */
export function resolvePipeline(graph: PipelineGraph, live: { rubric?: { version: number; gateMinScore: number } | null; env?: Env } = {}): PipelineResponse {
  const rubric = live.rubric ?? null;
  const view = (r: PipelineRule): PipelineRuleView => {
    const fromRubric = r.liveFrom === "rubric" && rubric !== null;
    const base = r.ref();
    let value = base;
    let envError: string | undefined;
    if (fromRubric) value = rubric.gateMinScore;
    else if (r.live && live.env) {
      try {
        value = r.live(live.env);
      } catch (e) {
        envError = e instanceof Error ? e.message : String(e);
      }
    }
    const differs = String(value) !== String(base);
    return {
      label: r.label,
      ...(r.key === undefined ? {} : { key: r.key }),
      value,
      unit: r.unit,
      display: formatRuleValue(value, r.unit),
      ...(differs ? { defaultValue: base, defaultDisplay: formatRuleValue(base, r.unit) } : {}),
      ...(fromRubric ? { rubricVersion: rubric.version } : {}),
      ...(envError === undefined ? {} : { envError }),
    };
  };
  const shown = graph.nodes.filter(isOnPage);
  const ids = new Set(shown.map((n) => n.id));
  return {
    nodes: shown.map((n) => ({
      id: n.id,
      label: n.label,
      column: n.column ?? 0,
      row: n.row ?? 0,
      status: n.status,
      ...(n.statusNote === undefined ? {} : { statusNote: n.statusNote }),
      what: n.what,
      rules: n.rules.map(view),
      adrs: [...n.adrs],
      tickets: [...n.tickets],
      files: [...n.files],
      worker: workersOf(n),
      ...(n.brainTask === undefined ? {} : { brainTask: n.brainTask }),
      sources: [...(n.sources ?? [])],
    })),
    edges: graph.edges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e) => ({ id: e.id, from: e.from, to: e.to, label: e.label, ...(e.metric === undefined ? {} : { metric: e.metric }), dashed: e.dashed === true, gates: (e.gates ?? []).map(view) })),
    rubric,
    envSource: live.env ? "warroom-process" : "defaults",
  };
}

// ---------------------------------------------------------------- the sync check

/**
 * What the code has, gathered by the test (this module reads no files). `pipelineGaps` compares it with the graph.
 * Every list is a fact about the code, never about the graph.
 */
export interface PipelineRegistry {
  /** Every key of `SOURCE_CLASS` and `SOURCE_CLASS_PREFIX`, with its class. */
  sourceIds: Readonly<Record<string, SourceClass>>;
  /** Every class in `packages/core/src/sources/` (not a test) that declares `implements Source`. */
  sourceClasses: readonly string[];
  /** Every `new <X>Source(` in the worker. */
  workerSources: readonly string[];
  /** Every `const <name>Tick = reentrant(` (or `tick`) in the worker. */
  ticks: readonly string[];
  /** Every key of `DEFAULT_ROUTING`. */
  brainTasks: readonly string[];
  /** Every gate and cap: `CONSTANT` or `CONSTANT.field`, with the code's current value (arrays joined with ", "). */
  config: Readonly<Record<string, number | string>>;
  /** Items deliberately not drawn, each with the reason. A key is a Source class name, a config key, a tick or a brain task. */
  leftOut: Readonly<Record<string, string>>;
  /** Whether a repo-relative path exists on disk. */
  exists: (repoPath: string) => boolean;
}

/** Every way the graph and the code disagree, as sentences. Empty when they are in sync. */
export function pipelineGaps(graph: PipelineGraph, registry: PipelineRegistry): string[] {
  const gaps: string[] = [];
  const { leftOut } = registry;
  const skipped = (item: string): boolean => Boolean(leftOut[item]?.trim());
  const nodeIds = new Set<string>();
  for (const n of graph.nodes) {
    if (nodeIds.has(n.id)) gaps.push(`Two nodes share the id "${n.id}".`);
    nodeIds.add(n.id);
  }

  // 1. Sources.
  const chips = graph.nodes.flatMap((n) => [...(n.sources ?? [])]);
  const chipById = new Map(chips.map((c) => [c.id, c]));
  for (const [id, cls] of Object.entries(registry.sourceIds)) {
    const chip = chipById.get(id);
    if (!chip) gaps.push(`Source "${id}" (class ${cls}) is in the Source class table but on no Sources node chip.`);
    else if ((cls === "context") !== (chip.status === "context-only")) gaps.push(`Source "${id}" is class ${cls} in the code but its chip says ${chip.status}.`);
  }
  for (const chip of chips) if (!(chip.id in registry.sourceIds)) gaps.push(`The chip "${chip.id}" names a Source that is in neither SOURCE_CLASS nor SOURCE_CLASS_PREFIX.`);
  const drawnClasses = new Set(chips.flatMap((c) => [...c.code]));
  for (const cls of registry.sourceClasses) if (!drawnClasses.has(cls) && !skipped(cls)) gaps.push(`${cls} implements Source but is in no chip's code[] (and not in LEFT_OUT).`);
  for (const cls of registry.workerSources) if (!drawnClasses.has(cls) && !skipped(cls)) gaps.push(`The worker creates new ${cls}( but no chip lists it in code[] (and it is not in LEFT_OUT).`);
  for (const c of drawnClasses) if (!registry.sourceClasses.includes(c)) gaps.push(`A chip lists the class ${c}, which no file in sources/ declares.`);

  // 2. Stages.
  const drawnWorkers = new Set(graph.nodes.flatMap(workersOf));
  for (const tick of registry.ticks) if (!drawnWorkers.has(tick) && !skipped(tick)) gaps.push(`The worker runs ${tick} but no node has it as its worker (and it is not in LEFT_OUT).`);
  for (const w of drawnWorkers) if (!registry.ticks.includes(w)) gaps.push(`A node names the worker pass ${w}, which apps/worker/src/main.ts does not define.`);
  const drawnTasks = new Set(graph.nodes.flatMap((n) => [...(n.brainTask === undefined ? [] : [n.brainTask]), ...(n.alsoBrainTasks ?? [])]));
  for (const task of registry.brainTasks) if (!drawnTasks.has(task) && !skipped(task)) gaps.push(`DEFAULT_ROUTING has the brain task "${task}" but no node has it as its brainTask (and it is not in LEFT_OUT).`);
  for (const t of drawnTasks) if (!registry.brainTasks.includes(t)) gaps.push(`A node names the brain task "${t}", which DEFAULT_ROUTING does not have.`);

  // 3. Gates and caps.
  const rules = allRules(graph);
  const ruleKeys = new Set(rules.flatMap((r) => (r.key === undefined ? [] : [r.key])));
  for (const key of Object.keys(registry.config)) if (!ruleKeys.has(key) && !skipped(key)) gaps.push(`${key} is a gate or cap in the code but the graph has no rule for it (add a rule with that key, or put it in LEFT_OUT with a reason).`);
  for (const r of rules) {
    if (r.key === undefined) continue;
    if (!(r.key in registry.config)) gaps.push(`The rule "${r.label}" names ${r.key}, which is not a gate or cap in the code.`);
    else if (String(r.ref()) !== String(registry.config[r.key])) gaps.push(`The rule "${r.label}" shows ${String(r.ref())} but ${r.key} is ${String(registry.config[r.key])} in the code.`);
  }
  const known = new Set<string>([...Object.keys(registry.sourceIds), ...registry.sourceClasses, ...registry.workerSources, ...registry.ticks, ...registry.brainTasks, ...Object.keys(registry.config)]);
  for (const [item, reason] of Object.entries(leftOut)) {
    if (!reason.trim()) gaps.push(`LEFT_OUT lists ${item} with no reason.`);
    if (!known.has(item)) gaps.push(`LEFT_OUT lists ${item}, which the code no longer has.`);
  }

  // 4. Shape.
  const edgeIds = new Set<string>();
  for (const e of graph.edges) {
    if (edgeIds.has(e.id)) gaps.push(`Two edges share the id "${e.id}".`);
    edgeIds.add(e.id);
    for (const end of [e.from, e.to]) if (!nodeIds.has(end)) gaps.push(`The edge "${e.id}" names the node "${end}", which does not exist.`);
  }
  const cells = new Map<string, string>();
  for (const n of graph.nodes.filter(isOnPage)) {
    if (!Number.isInteger(n.column) || !Number.isInteger(n.row) || (n.column ?? -1) < 0 || (n.row ?? -1) < 0) {
      gaps.push(`The node "${n.id}" is on the page but has no grid cell (column and row).`);
      continue;
    }
    const cell = `${n.column},${n.row}`;
    if (cells.has(cell)) gaps.push(`The nodes "${cells.get(cell)}" and "${n.id}" share the grid cell ${cell}.`);
    cells.set(cell, n.id);
  }
  const seen = new Set<string>();
  const first = graph.nodes[0];
  if (first) {
    const queue = [first.id];
    seen.add(first.id);
    while (queue.length > 0) {
      const at = queue.shift()!;
      for (const e of graph.edges) {
        const next = e.from === at ? e.to : e.to === at ? e.from : undefined;
        if (next !== undefined && nodeIds.has(next) && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  }
  for (const n of graph.nodes) if (!seen.has(n.id)) gaps.push(`The node "${n.id}" is not connected to the rest of the graph.`);
  for (const n of graph.nodes) {
    for (const adr of n.adrs) if (!registry.exists(`docs/adr/${adr}`)) gaps.push(`The node "${n.id}" links the ADR ${adr}, which is not in docs/adr/.`);
    for (const t of n.tickets) if (!registry.exists(t)) gaps.push(`The node "${n.id}" links the ticket ${t}, which does not exist.`);
    for (const f of n.files) if (!registry.exists(f)) gaps.push(`The node "${n.id}" names the file ${f}, which does not exist.`);
  }
  return gaps;
}
