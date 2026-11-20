import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ApiBrain,
  applyXSessionResumes,
  BackoffSource,
  BUILD_TICK_MS,
  buildTokenFilePresent,
  missingCloudflareVariables,
  captureDueSnapshots,
  captureRunCap,
  CHAIN_TICK_MS,
  chainCreatesConfig,
  runChainCreates,
  type ChainState,
  createGroupStep,
  createMomentJob,
  createRadarJob,
  GoogleTrendsReader,
  loadRadarFeeds,
  RssFeedReader,
  radarSettingsFromEnv,
  RADAR_CONFIG,
  createTopDownReader,
  momentSettingsFromEnv,
  spawnMomentRunner,
  generateMemeIdeas,
  runMemeAngles,
  memeConfigFromEnv,
  metaConfigFromEnv,
  metaGroupConfigFromEnv,
  metaIntervalMinutes,
  metaSummaryConfigFromEnv,
  raiseNewMetasSafely,
  recomputeMetas,
  summariseMetas,
  FallbackBrain,
  announceNewProposals,
  anthropicKeyFromEnv,
  apiFallbackConfigFromEnv,
  apiSpentUsd,
  createNotifier,
  cloudflareEnv,
  telegramEnv,
  ClaudeCodeBrain,
  Datastore,
  DexScreenerClient,
  DexScreenerTrendingSource,
  GitHubTrendingSource,
  GoogleTrendsSource,
  PodmanSandbox,
  applyPendingCommands,
  capsFromEnv,
  currentImageTag,
  draftPendingSpecs,
  expireStaleProposals,
  githubRepoCheck,
  HASHING_JOIN_THRESHOLD,
  HashingEmbedder,
  clusterNewSignals,
  ingestSources,
  INGEST_TICK_MS,
  JUDGE_TICK_MS,
  STUDY_TICK_MS,
  judgeConfigFromEnv,
  judgePendingNarratives,
  killLiveBrainChildren,
  loadRssSources,
  createCollisionChecker,
  proposeConfigFromEnv,
  proposePendingNarratives,
  PumpPortalSource,
  researchConfigFromEnv,
  revisePendingSpecs,
  automaticAgents,
  automaticAgentsLine,
  RunCancels,
  runPendingCleanups,
  runPendingBuilds,
  startupConfigLine,
  startWorkerHeartbeat,
  STUDY_CAPTURE_RULE,
  sweepDismissedHomes,
  sweepStaleSeals,
  type BuildRunnerOptions,
  type Source,
} from "@argus/core";
import { reentrant } from "./reentrant.ts";
import { startResearchSchedule } from "./research-schedule.ts";
import { SEMANTIC_MODEL, backgroundEmbedder, embedderIdOf, loadSemanticEmbedder, modelCacheDir } from "./semantic-embedder.ts";

const TICK_MS = BUILD_TICK_MS; // the one definition of the tick; the Proposal page says "retried every N s" from it
const once = process.argv.includes("--once");
const dryRun = process.argv.includes("--dry-run") || process.env.ARGUS_DRY_RUN === "1";
const dbPath = process.env.ARGUS_DB ?? "../../.data/argus.db";
const store = Datastore.open(dbPath);
const dataDir = process.env.ARGUS_DATA_DIR || dirname(resolve(dbPath));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const skillsDir = join(repoRoot, ".claude", "skills");
// Children run from a temp dir holding only the task's skill, never the repo root (.env, .data/argus.db).
const claude = new ClaudeCodeBrain({ skillsDir, dryRun, command: process.env.ARGUS_CLAUDE_BIN || "claude" });
// The API fallback (docs/architecture.md section 5, ticket 12) is OFF unless ARGUS_API_FALLBACK=1. It serves judge and propose only,
// on haiku, when claude is rate-limited, and is held to a daily cap in REAL dollars (ARGUS_API_DAILY_USD can only lower the cap in code).
// ANTHROPIC_API_KEY is read here, from the environment or the git-ignored .env, only when the fallback is on, handed to ApiBrain
// and removed from this process's environment, so no child (claude, git, gh, wrangler, podman) can inherit it. It is never logged.
const apiFallback = apiFallbackConfigFromEnv(process.env);
const apiKey = apiFallback.enabled ? anthropicKeyFromEnv(process.env, join(repoRoot, ".env")) : undefined;
delete process.env.ANTHROPIC_API_KEY;
let brain: ClaudeCodeBrain | FallbackBrain = claude;
if (apiFallback.enabled && apiKey === undefined && !dryRun) {
  console.warn("[worker] ARGUS_API_FALLBACK=1 but ANTHROPIC_API_KEY is not set (environment or .env): the API fallback is off");
} else if (apiFallback.enabled) {
  brain = new FallbackBrain({
    primary: claude,
    api: new ApiBrain({ apiKey, skillsDir, spentUsd: apiSpentUsd(store), dailyCapUsd: apiFallback.dailyUsd, dryRun, log: console.log }),
    dryRun,
    log: console.log,
  });
  console.log(`[worker] API fallback on: judge and propose use the API (haiku) when the subscription is rate-limited, real-dollar cap $${apiFallback.dailyUsd}/day`);
} else {
  console.log("[worker] API fallback off (ARGUS_API_FALLBACK=1 turns it on)");
}

// The Build Runner: Build repos live under ~/code (ARGUS_BUILD_ROOT), cloned from the template repo. The *_BIN overrides
// point the runner at other executables (tests use fakes); nothing else about a Build is configurable from the environment.
const buildRoot = process.env.ARGUS_BUILD_ROOT || join(homedir(), "code");
// Builds run in rootless podman containers (containment design). The image is the tag `pnpm image:build` prints, derived from this
// checkout unless ARGUS_BUILD_IMAGE names one; the worker never builds or pulls it. The Build token is read from a file on each Build.
const buildTokenPath = process.env.ARGUS_BUILD_TOKEN_FILE || join(homedir(), ".config", "argus", "build-token");
const sandbox = new PodmanSandbox({
  image: process.env.ARGUS_BUILD_IMAGE || currentImageTag(repoRoot),
  podmanBin: process.env.ARGUS_PODMAN_BIN || "podman",
  tokenPath: buildTokenPath,
  dataDir,
  caps: capsFromEnv(process.env),
});
// Telegram (notify only): TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from the environment or the git-ignored .env at the repo root (only
// those two names are taken from the file; a variable that is set, even empty, wins over it). Missing config turns notifications
// off with one warning. Sending is queued and asynchronous, so Telegram being slow or down never holds up a tick or a Build.
// ARGUS_TELEGRAM_URL and ARGUS_NO_DOTENV exist for tests: the test run sets both, so no test worker reads the Operator's .env.
// ARGUS_ENV_FILE names another file than the repo-root .env (tests point it at a file holding a token, to prove ARGUS_NO_DOTENV skips it).
const envFile = process.env.ARGUS_ENV_FILE || join(repoRoot, ".env");
if (process.env.ARGUS_NO_DOTENV) console.log("[worker] .env skipped (ARGUS_NO_DOTENV)");
const notifier = createNotifier({
  env: telegramEnv(process.env, envFile),
  dryRun,
  log: console.log,
  baseUrl: process.env.ARGUS_TELEGRAM_URL || undefined,
});
// Judge and propose share one rolling-24 h research budget (about 30% of the assumed daily quota, research-budget.ts), checked before every
// run. The Build Runner reads the same parsed config: its daily quota gates the start of a Build.
const researchBudget = researchConfigFromEnv(process.env);
const buildOptions: BuildRunnerOptions = {
  notifier,
  research: researchBudget,
  buildRoot,
  templateRepo: process.env.ARGUS_TEMPLATE_REPO || join(buildRoot, "argus-build-template"),
  dataDir,
  sandbox,
  // The Build's credential source: the process environment plus CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN from the environment or
  // the .env file (only those two names). It is the runner's lookup table, not any child's environment; each command gets only its allowlist.
  env: { ...process.env, ...cloudflareEnv(process.env, envFile) },
  gitBin: process.env.ARGUS_GIT_BIN || undefined,
  ghBin: process.env.ARGUS_GH_BIN || undefined,
  wranglerBin: process.env.ARGUS_WRANGLER_BIN || undefined,
  dryRun,
  log: console.log,
};

// An open brain run older than its task's timeout plus grace belongs to a process that died: surface it, never retry.
// A younger one may be live (this process, or a foreground --once beside the daemon): leave it. Runs at boot and every tick.
const sweepStaleRuns = () => {
  const interrupted = store.interruptStaleBrainRuns((task) => brain.staleAfterMs(task));
  if (interrupted > 0) console.error(`[worker] ${interrupted} brain run(s) were interrupted by a dead worker; flagged on their cards`);
};
sweepStaleRuns();
// What an earlier worker left behind when it died mid-Build is cleaned up: its containers (found by label, and only those of this
// data dir whose owning worker is gone) and its seal directories (same rule). A worker that is alive, such as the daemon beside a
// `--once` run, keeps its own. A dry run touches nothing.
if (!dryRun) {
  await sandbox.reconcile(console.log);
  sweepStaleSeals(dataDir, console.log);
  sweepDismissedHomes(store, dataDir, console.log);
}

const shutdown = new AbortController();
const ghRepoExists = githubRepoCheck({ ghBin: process.env.ARGUS_GH_BIN || "gh", cwd: dataDir });
// The Spec runs (draft and revise) in flight in this process, so Undo shortlist can kill one.
const specRuns = new RunCancels();
const applyCommands = () => {
  const n = applyPendingCommands(
    store,
    (c, e) => console.error(`[worker] command ${c.id} hit a non-domain error (attempt recorded):`, e),
    { dataDir, log: console.log, buildRoot, githubRepoExists: ghRepoExists, cancelRun: (id) => specRuns.cancel(id) },
  );
  if (n > 0) console.log(`[worker] resolved ${n} command(s)`);
};
// "Clean up build" commands reach Cloudflare and GitHub, so they have their own async pass. They use the Build's credential sources
// (the Cloudflare keys from the environment or .env; the GitHub token from GH_TOKEN/GITHUB_TOKEN or `gh auth token`). A dry run
// deletes nothing and leaves the commands pending.
const applyCleanups = async () => {
  if (dryRun) return;
  const n = await runPendingCleanups(store, {
    buildRoot,
    env: { ...process.env, ...cloudflareEnv(process.env, envFile) },
    ghBin: process.env.ARGUS_GH_BIN || undefined,
    log: console.log,
    onError: (c, e) => console.error(`[worker] cleanup command ${c.id} hit a non-domain error (attempt recorded):`, e),
  });
  if (n > 0) console.log(`[worker] resolved ${n} clean-up command(s)`);
};
const recordAlive = () => {
  const gap = store.recordWorkerAlive(new Date());
  if (gap) console.log(`[worker] was stopped from ${gap.start} to ${gap.end}; meme ideas and refreshes do not count that time`);
};
// At boot too, so a stop is recorded even when the first tick is late.
if (!dryRun) recordAlive();
const tick = reentrant(
  async () => {
    console.log(`[worker] tick ${new Date().toISOString()}`);
    // The heartbeat first: a stop since the last one is recorded before expiry reads it (meme ideas count running time only).
    if (!dryRun) recordAlive();
    applyCommands();
    // A Resume press the War Room wrote clears the X session's stop state here, on the next tick (moment scanner ticket 01).
    applyXSessionResumes(store, new Date(), console.log);
    await applyCleanups();
    sweepStaleRuns();
    expireStaleProposals(store, new Date(), console.log);
    announceNewProposals(store, notifier);
    await draftPendingSpecs(store, brain, dataDir, console.log, shutdown.signal, specRuns);
    await revisePendingSpecs(store, brain, dataDir, console.log, shutdown.signal, specRuns);
  },
  () => console.log("[worker] tick skipped: previous tick still running"),
);
// Builds run on their own guarded loop: a Build takes hours, and commands, Spec drafts and revises must not wait for it.
// `runPendingBuilds` itself takes one Build at a time, so a long Build never overlaps another.
const buildTick = reentrant(
  async () => {
    // Builds are handed the claude brain itself, never the fallback: a Build cannot reach the API however the window stands.
    const n = await runPendingBuilds(store, claude, buildOptions, shutdown.signal);
    if (n > 0) console.log(`[worker] finished ${n} build(s)`);
  },
  () => {}, // a Build is still running: the next tick tries again (no log line: a Build takes hours)
);
// Ingestion runs on its own guarded loop, every 5 minutes: polling feeds is slow and must not hold up commands or Spec drafts.
// No brain or LLM is involved. The feed list is re-read each pass, so editing it needs no restart. A dry run polls nothing.
const rssFeedsPath = process.env.ARGUS_RSS_FEEDS || join(repoRoot, "config", "rss-feeds.json");
// Google Trends and DexScreener trending (the standing Sources) also run on this tick. They are built once so their backoff
// outlives a pass. ARGUS_INGEST_STANDING=0 is the one switch that turns both off (tests do; nothing else disables them), and only the
// exact string "0" does: "false", "off", "no" and the empty string leave them on.
// ARGUS_TRENDS_URL and ARGUS_DEXSCREENER_URL exist for tests and local mirrors; empty or unset means the real endpoint.
const standingOn = process.env.ARGUS_INGEST_STANDING !== "0";
const trendsUrl = process.env.ARGUS_TRENDS_URL || undefined;
const dexUrl = process.env.ARGUS_DEXSCREENER_URL || undefined;
const standingSources: Source[] = standingOn
  ? [
      new BackoffSource(new GoogleTrendsSource({ baseUrl: trendsUrl })),
      new BackoffSource(new DexScreenerTrendingSource({ client: new DexScreenerClient({ baseUrl: dexUrl }) })),
      new BackoffSource(new GitHubTrendingSource({ baseUrl: process.env.ARGUS_GITHUB_URL || undefined })),
    ]
  : [];
// PumpPortal keeps a websocket open, so it exists only in the long-running daemon: never in a dry run or a one-shot `--once`,
// where an open socket would keep the process alive. Its events wait in a buffer that each ingest pass drains.
// ARGUS_PUMPPORTAL_URL exists for tests; empty or unset means the real endpoint.
// The Study (phase 3) reads the same connection: every create and migrate goes into the Study's tables as it arrives, and the
// connection going down or up is kept as a gap marker. A failed write is logged by the Source and never reaches the Signals.
const pumpPortal =
  standingOn && !once && !dryRun
    ? new PumpPortalSource({
        url: process.env.ARGUS_PUMPPORTAL_URL || undefined,
        log: console.log, // lifecycle lines ([pumpportal] connect/disconnect/...) go to stdout beside the other [worker] lines
        onToken: (e) => store.study.recordTokenEvent(e),
        onConnection: (e) => store.study.recordConnection(e),
      })
    : undefined;
if (pumpPortal) {
  store.study.recordBoot(new Date());
  standingSources.push(pumpPortal);
}
console.log(`[worker] ingest sources: RSS catalog${standingOn ? `, ${standingSources.map((s) => s.id).join(", ")}` : " (standing Sources off: ARGUS_INGEST_STANDING=0; only the exact string 0 turns them off)"}`);
// Narratives are clustered with a semantic model run in this process (docs/adr/0007), loaded in the background after the first ingest,
// which downloads it from huggingface.co if `pnpm models:fetch` has not. Ingest never waits for it: until the model is ready (or if it
// cannot be had) clustering is skipped (logged) and the Signals stay unclustered; it never falls back to the lexical embedder.
// ARGUS_EMBEDDER=hashing is the explicit dev and test choice for that embedder. A dry run never reaches clustering, so it downloads nothing.
const embedderChoice = process.env.ARGUS_EMBEDDER || "semantic";
if (embedderChoice !== "semantic" && embedderChoice !== "hashing") throw new Error(`ARGUS_EMBEDDER must be "semantic" or "hashing", got "${embedderChoice}"`);
const hashingEmbedder = new HashingEmbedder();
const semantic =
  embedderChoice === "hashing"
    ? undefined
    : backgroundEmbedder(
        () => loadSemanticEmbedder({ dir: modelCacheDir(process.env), host: process.env.ARGUS_MODEL_HOST || undefined, signal: shutdown.signal, log: console.log }),
        console.log,
      );
console.log(`[worker] narrative embedder: ${embedderChoice}${embedderChoice === "hashing" ? " (lexical, dev/test choice)" : ` (model cache ${modelCacheDir(process.env)})`}`);
const ingestTick = reentrant(
  async () => {
    if (dryRun) {
      console.log(`[worker] ingest tick: dry-run, would poll the RSS catalog at ${rssFeedsPath} and ${standingSources.length} other source(s)`);
      return;
    }
    const sources = [...loadRssSources(rssFeedsPath), ...standingSources];
    const { stored, failed } = await ingestSources(store, sources, console.error);
    console.log(`[worker] ingest tick: ${sources.length} source(s), ${stored} new signal(s)${failed > 0 ? `, ${failed} source(s) failed` : ""}`);
    // Then cluster whatever is not in a Narrative yet (also leftovers of an earlier pass). Plain code, no brain.
    let embedder = semantic ? semantic.current() : hashingEmbedder;
    if (!embedder && once) {
      // A one-shot run has no next tick: it waits for the model, but only after its ingest is done.
      await semantic?.settled();
      embedder = semantic?.peek(); // not current(): after a failed load that would start a download nobody awaits
    }
    if (!embedder) return; // the model is not ready or unavailable: logged, retried next tick, Signals stay unclustered meanwhile
    const config = embedderChoice === "hashing" ? { joinThreshold: HASHING_JOIN_THRESHOLD } : undefined;
    const { clustered, created } = await clusterNewSignals(store, embedder, { config, signal: shutdown.signal });
    console.log(`[worker] cluster: ${clustered} signal(s) clustered, ${created} new narrative(s)`);
  },
  () => console.log("[worker] ingest tick skipped: previous ingest still running"),
);
// The judge pass scores new or materially changed Narratives of the current embedder (docs/architecture.md section 7), every 30 minutes.
// Its caps (per pass, per rolling day) come from ARGUS_JUDGE_* (judgeConfigFromEnv). A dry run logs the command and spawns nothing.
const judgeConfig = judgeConfigFromEnv(process.env);
const judgeEmbedder = embedderChoice === "hashing" ? new HashingEmbedder() : { id: embedderIdOf(SEMANTIC_MODEL), dimension: SEMANTIC_MODEL.dimension };
const judgeTick = reentrant(
  async () => {
    const r = await judgePendingNarratives(store, brain, judgeEmbedder, { config: judgeConfig, research: researchBudget, log: console.log, signal: shutdown.signal });
    console.log(`[worker] judge tick: ${r.judged} scored, ${r.refused} refused, ${r.failed} failed${r.stoppedBy ? `, stopped: ${r.stoppedBy}` : ""}`);
  },
  () => console.log("[worker] judge tick skipped: previous judge pass still running"),
);
// The propose pass turns Narratives whose Score passes the Rubric's buildability gate into Proposals (docs/architecture.md section 7), right
// after each judge pass. At most 30 new Proposals a day; ARGUS_PROPOSE_* lower its other caps. A dry run logs the command and spawns nothing.
// `onCreated` is the one hook for a new Proposal (ticket 11 attaches the Telegram notice there).
const proposeConfig = proposeConfigFromEnv(process.env);
// Each Proposal's name, ticker and repo name are checked against DexScreener and GitHub (keyless public APIs, 15 s bound, backoff after a
// failure; a check that fails is stored as "unknown"). One checker for the process, so its backoff lasts across passes.
// ARGUS_DEXSCREENER_SEARCH_URL and ARGUS_GITHUB_SEARCH_URL exist for tests: the test run points both at a dead loopback port. They are
// separate from the ingest Source's ARGUS_DEXSCREENER_URL, so a test that mirrors the ingest APIs never mirrors the collision checks.
const collisionChecker = createCollisionChecker({
  dexBaseUrl: process.env.ARGUS_DEXSCREENER_SEARCH_URL || undefined,
  githubUrl: process.env.ARGUS_GITHUB_SEARCH_URL || undefined,
});
const proposeTick = reentrant(
  async () => {
    const r = await proposePendingNarratives(store, brain, judgeEmbedder, { config: proposeConfig, research: researchBudget, log: console.log, signal: shutdown.signal, collisions: collisionChecker });
    console.log(`[worker] propose tick: ${r.proposed} proposed, ${r.refused} refused, ${r.failed} failed${r.withdrawn ? `, ${r.withdrawn} withdrawn` : ""}${r.stoppedBy ? `, stopped: ${r.stoppedBy}` : ""}`);
  },
  () => console.log("[worker] propose tick skipped: previous propose pass still running"),
);
// The Study's capture job (phase 3 ticket 02): Snapshots of new tokens at the fixed age (60 s), a metadata fetch and one website fetch
// each, no brain or LLM. Its own run cap is counted in code (ARGUS_STUDY_CAPTURES_PER_DAY can only lower it). A dry run reports
// what is due and fetches and writes nothing. It runs only in the long-running daemon, where PumpPortal feeds it.
const studyTick = reentrant(
  async () => {
    const r = await captureDueSnapshots(store.study, { dryRun, runCap: captureRunCap(process.env), log: console.error });
    if (r.dryRun) {
      if (r.due > 0) console.log(`[worker] study tick: dry-run, ${r.due} token(s) due, would capture ${r.wouldCapture ?? 0}`);
    } else if (r.due > 0) {
      console.log(`[worker] study tick: ${r.due} due, ${r.captured} captured, ${r.counted} without links, ${r.late} late, ${r.capped} capped, ${r.unreadable} unreadable, ${r.retrying} retrying`);
    }
  },
  () => {}, // a slow site is still being fetched: the next tick takes what is due then
);
// The Study's chain-sourced creates (phase 3 ticket 20): PumpPortal misses about half of the pump creates, so migrated mints get their create
// read from chain (read-only, through Helius, the key in HELIUS_API_KEY) and once a day a random sample of the previous UTC day's creates is
// stored as the comparison population. Credits are counted per call against a daily cap (ARGUS_CHAIN_CREATES_DAILY_CREDIT_CAP, 25,000 by default,
// 33,000 at most) and logged per job and verb. Without the key it is off. A dry run makes no chain call and logs what a run would use.
const chainConfig = chainCreatesConfig(process.env);
const chainState: ChainState = {};
const chainTick = reentrant(
  async () => {
    await runChainCreates({ chain: store.chain, config: chainConfig, dryRun, state: chainState, log: console.log });
  },
  () => {}, // the previous run is still reading: the next tick carries on
);
// The Meta ranking (viral sources ticket 03): groups the last 24 h of launchpad creates into clone clusters, ranks them for the 6 h and 24 h
// windows and stores the run. Plain code, no LLM. DexScreener market cap for the top groups only, within a call budget (ARGUS_META_DEX_*).
// Every ARGUS_META_INTERVAL_MINUTES (default 15). The lookup uses the collision checks' DexScreener URL override, so a test run never reaches
// the real API. A dry run does not run it (it writes a run row).
const META_TICK_MS = metaIntervalMinutes(process.env) * 60_000;
const metaConfig = metaConfigFromEnv(process.env);
const metaDex = new DexScreenerClient({ baseUrl: process.env.ARGUS_DEXSCREENER_SEARCH_URL || undefined });
// Leaders are found top-down (ADR 0015): Jupiter's and GeckoTerminal's trending lists, within ARGUS_META_TOPDOWN_CALLS requests a tick, then
// verified on DexScreener. ARGUS_JUPITER_URL (the whole list prefix, ending in a slash) and ARGUS_GECKOTERMINAL_URL exist for tests and local mirrors.
const metaTopDown = createTopDownReader({ config: metaConfig, jupiterUrl: process.env.ARGUS_JUPITER_URL || undefined, geckoUrl: process.env.ARGUS_GECKOTERMINAL_URL || undefined });
// The AI grouping step (meta redesign ticket 06, ADR 0015): the Brain task `meta-group` names the subjects each tick, reused while its inputs
// are unchanged (up to 60 min) and capped at ARGUS_META_GROUP_MAX_DAILY_USD (1.00) a day; ARGUS_META_GROUP_AI=0 turns it off. Any failure or
// refusal leaves the tick on the rule-based names. A dry run never calls it (the Brain's dry run answers nothing).
const metaGroupConfig = metaGroupConfigFromEnv(process.env);
const metaGroup = createGroupStep(store, brain, { config: metaGroupConfig, research: researchBudget, log: console.log, signal: shutdown.signal });
const metaTick = reentrant(
  async () => {
    const r = await recomputeMetas(store, { dex: metaDex, topDown: metaTopDown, config: metaConfig, group: metaGroup, log: console.error });
    console.log(`[worker] meta tick: ${r.tokensRead} tokens, ${r.groups} groups, ${r.dexCalls} DexScreener call(s) (${r.leaderCalls} for leaders), ${r.dexFailures} failed, top-down ${r.topDown.requests} request(s) ${r.topDown.kept} kept ${r.topDown.dropped} dropped${r.topDown.errors.length > 0 ? ` (${r.topDown.errors.length} failed)` : ""}, ${r.metas} Meta(s), ${r.watching} Watching`);
    // Market-led Metas (ADR 0014): who leads each one, so the log says why a Meta is (or is not) there.
    for (const m of r.current.metas) console.log(`[worker] Meta "${m.label}": leader ${m.leader.symbol || m.leader.name} $${Math.round(m.leader.marketCapUsd).toLocaleString("en-US")}${m.holding ? " (holding)" : ""}${m.leader.stale ? " (stale)" : ""}`);
    // New Meta (meta redesign ticket 03): plain code over the two newest stored runs, one event each time a subject becomes a Meta. Never a
    // Narrative, Proposal or Score. A failure is logged inside and never skips the summary tick that follows this tick.
    for (const e of raiseNewMetasSafely(store, metaConfig)) console.log(`[worker] new meta: "${e.label}" (leader ${e.leader.symbol || e.leader.name} at $${Math.round(e.leader.marketCapUsd).toLocaleString("en-US")}): ${e.reason}`);
  },
  () => {}, // a slow lookup is still running: the next tick starts fresh
);
// The one-line summary of the top Metas (slice 5): the Brain task `meta-summary`, after each ranking refresh and as its own pass, so a slow
// claude call never delays the next ranking. Bounded and cached (ARGUS_META_SUMMARY_MAX_PER_DAY, ARGUS_META_SUMMARY_MAX_DAILY_USD); counts in
// the research share. When it makes no line the War Room shows the templated numbers line.
const metaSummaryConfig = metaSummaryConfigFromEnv(process.env);
const metaSummaryTick = reentrant(
  async () => {
    const r = await summariseMetas(store, brain, { config: metaSummaryConfig, research: researchBudget, log: console.log, signal: shutdown.signal });
    if (r.called > 0) console.log(`[worker] meta summary: ${r.accepted} written, ${r.refused} refused, ${r.failed} failed${r.stoppedBy ? `, stopped: ${r.stoppedBy}` : ""}`);
  },
  () => {}, // the previous pass is still waiting on claude: the next refresh picks up what is left
);
// Meme ideas (missed ideas ticket 06, ADR 0013, amended by meta redesign ticket 03): for each current Meta when it becomes one and again every
// 12 h while it stays one, one sonnet run that returns three ideas, stored as `meme` Proposals. After the Metas, a news Narrative that failed
// the buildability gate gets one trio too (proposal-routing ticket 04; the judge's embedder picks its Narratives). OFF unless ARGUS_MEME_IDEAS=1 (the Operator
// turns it on after the backtest re-run); off, the pass reads and calls nothing. ARGUS_MEME_MAX_PER_DAY runs a day (8 by default, 40 at most),
// taken from the research budget. A dry run never calls the
// Brain: the pass is skipped. DexScreener (the name check) and the collision checks use the same declared client and the test override.
const memeSettings = memeConfigFromEnv(process.env);
const memeDex = new DexScreenerClient({ baseUrl: process.env.ARGUS_DEXSCREENER_SEARCH_URL || undefined });
// One meme pass at a time, automatic or an Operator's angle: they share the caps and the claude process, so they never overlap (the one that
// finds the other running returns; the next tick or the next Meta pass picks up what is left).
let memePassRunning = false;
const memeIdeasTick = reentrant(
  async () => {
    if (!memeSettings.enabled || dryRun || memePassRunning) return;
    memePassRunning = true;
    try {
      const r = await generateMemeIdeas(store, brain, { enabled: true, config: memeSettings.config, research: researchBudget, metaConfig, log: console.log, signal: shutdown.signal, dex: memeDex, collisions: collisionChecker, embedder: judgeEmbedder });
      if (r.called > 0 || r.stoppedBy) console.log(`[worker] meme ideas: ${r.stored} stored, ${r.refused} refused, ${r.failed} failed, ${r.skipped} skipped${r.withdrawn ? `, ${r.withdrawn} withdrawn` : ""}${r.stoppedBy ? `, stopped: ${r.stoppedBy}` : ""}`);
    } finally {
      memePassRunning = false;
    }
  },
  () => {}, // the previous pass is still waiting on claude: the next ranking picks up what is left
);
// The Operator's angle on a Meta (meta redesign ticket 11): a request the War Room wrote is run through the same meme pass (same switch, same
// caps, same research budget) on the fast tick, so it does not wait up to 15 minutes for the next Meta pass. With nothing waiting it reads one
// table and returns. Off with the meme ideas (ARGUS_MEME_IDEAS), where a request waits. A pass that stopped for a reason that is not the
// request's own (a rate limit, three failures, the API hold, a shutdown) is not tried again until the next Meta pass is due, so the fast tick
// does not probe a limit every 30 s.
let memeAngleHoldUntil = 0;
const memeAngleTick = reentrant(
  async () => {
    if (!memeSettings.enabled || dryRun || memePassRunning || Date.now() < memeAngleHoldUntil || !store.hasOpenAngleRequests()) return;
    memePassRunning = true;
    try {
      const r = await runMemeAngles(store, brain, { enabled: true, config: memeSettings.config, research: researchBudget, metaConfig, log: console.log, signal: shutdown.signal, dex: memeDex, collisions: collisionChecker });
      if (r.called > 0 || r.stoppedBy) console.log(`[worker] meme angles: ${r.stored} stored, ${r.refused} refused, ${r.failed} failed${r.stoppedBy ? `, stopped: ${r.stoppedBy}` : ""}`);
      if (r.stoppedBy === "rate-limited" || r.stoppedBy === "backoff" || r.stoppedBy === "api-hold" || r.stoppedBy === "interrupted") memeAngleHoldUntil = Date.now() + META_TICK_MS;
    } finally {
      memePassRunning = false;
    }
  },
  () => {}, // the previous pass is still waiting on claude: the next tick picks up what is left
);
// The Moment scanner (moment scanner ticket 01, ADR 0009 as amended 2026-11-19): every ARGUS_MOMENT_INTERVAL_MIN minutes (30 by default, 15 at
// least) one child process loads the topic's two search pages on the dedicated logged-in profile and stores the posts and their counts. No Claude,
// no Brain. OFF unless ARGUS_MOMENTS=1 (and then ARGUS_MOMENT_TOPIC must be set). Caps are in code: 8 loads a scan and 100 a day
// (ARGUS_MOMENT_LOADS_PER_DAY can only lower it). A locked profile or a stopped X session skips the scan; a dry run spawns nothing.
const momentSettings = momentSettingsFromEnv(process.env);
const MOMENT_TICK_MS = momentSettings.intervalMinutes * 60_000;
const momentJob = createMomentJob({ store, settings: momentSettings, runner: spawnMomentRunner(), notifier, dryRun, log: console.log, signal: shutdown.signal });
const momentTick = reentrant(
  async () => {
    const r = await momentJob();
    if (r.status !== "off" && r.status !== "overlap") console.log(`[worker] moment scan: ${r.status}${r.note ? ` (${r.note})` : ""}, ${r.loads} load(s), ${r.newPosts} new post(s), ${r.readings} reading(s)`);
  },
  () => console.log("[worker] moment scan skipped: the previous scan is still running"),
);
// The trend radar (trend radar ticket 01, ADR 0016): every 15 minutes it reads Google Trends' rising terms for the US through its own reader (not a
// Source: no Signal, no Narrative), keeps the 14-day seen-set, drops what is already a Meta or Watching subject, and runs the untokenized check
// (DexScreener search through the shared client, the live-token test, the local creates) on each new Trend, within 30 searches a tick. No Claude, no Brain.
// OFF unless ARGUS_RADAR=1 (any other value but 0 is an error); a dry run polls and searches nothing. It uses the collision checks' DexScreener URL
// override, so a test run never reaches the real API.
const radarSettings = radarSettingsFromEnv(process.env);
const RADAR_TICK_MS = RADAR_CONFIG.tickMinutes * 60_000;
// Ticket 02: the radar's own news feed list (config/radar-feeds.json, never config/rss-feeds.json), read once at start and only when the radar is on, so a
// bad file stops a radar that is on and cannot break one that is off. ARGUS_RADAR_FEEDS points at another file (tests, local mirrors).
const radarFeeds = radarSettings.enabled ? loadRadarFeeds(process.env.ARGUS_RADAR_FEEDS || join(repoRoot, "config", "radar-feeds.json")) : [];
const radarJob = createRadarJob({
  store,
  settings: radarSettings,
  reader: new GoogleTrendsReader(),
  feedReader: new RssFeedReader(),
  feeds: radarFeeds,
  dex: new DexScreenerClient({ baseUrl: process.env.ARGUS_DEXSCREENER_SEARCH_URL || undefined }),
  dryRun,
  log: console.log,
  signal: shutdown.signal,
});
const radarTick = reentrant(
  async () => {
    const r = await radarJob();
    if (r.status === "ok") console.log(`[worker] radar tick: ${r.note}${r.waiting.length > 0 ? `, waiting out a backoff: ${r.waiting.join(", ")}` : ""}${r.failed.length > 0 ? `, failed: ${r.failed.join(", ")}` : ""}`);
  },
  () => console.log("[worker] radar tick skipped: the previous tick is still running"),
);
// One greppable line of the effective config, so worker.log proves it instead of leaving a reader to assume defaults. Secrets appear only as set/unset.
// The capture tick runs in the daemon (also in a dry run, which only reports what is due), never in a one-shot: this one flag drives both this line and the timer.
const studyOn = standingOn && !once;
console.log(
  startupConfigLine(process.env, {
    apiKeySet: apiKey !== undefined,
    telegramOn: notifier.enabled,
    studyOn,
    buildDryRun: dryRun,
    buildImage: sandbox.image,
    buildCloudflare: missingCloudflareVariables(buildOptions.env ?? process.env).length === 0,
    buildTokenPresent: buildTokenFilePresent(buildTokenPath),
  }),
);
const running = new Set<Promise<unknown>>();
const track = (run: () => Promise<unknown>, what: string) => {
  const p: Promise<unknown> = run()
    .catch((e) => console.error(`[worker] ${what} failed`, e))
    .finally(() => running.delete(p));
  running.add(p);
  return p;
};
const runTick = () => track(tick, "tick");
const runBuildTick = () => track(buildTick, "build pass");
const runIngestTick = () => track(ingestTick, "ingest tick");
const runJudgeTick = () => track(judgeTick, "judge tick");
const runProposeTick = () => track(proposeTick, "propose tick");
const runStudyTick = () => track(studyTick, "study tick");
const runChainTick = () => track(chainTick, "chain creates");
const runMetaSummaryTick = () => track(metaSummaryTick, "meta summary");
const runMemeIdeasTick = () => track(memeIdeasTick, "meme ideas");
const runMemeAngleTick = () => track(memeAngleTick, "meme angles");
const runMomentTick = () => track(momentTick, "moment scan");
const runRadarTick = () => track(radarTick, "radar tick");
const runMetaTick = () =>
  track(async () => {
    await metaTick();
    void runMetaSummaryTick();
    void runMemeIdeasTick();
  }, "meta tick");
// ADR 0017: Claude runs only when the Operator triggers it. The automatic research tick, the automatic Meta meme ideas and the moment scanner are
// switches, off by default; the worker says so once at start (the War Room shows the same list). The haiku tasks and the plain-code jobs stay on.
const agents = automaticAgents(process.env);
const researchTickOn = agents.find((a) => a.id === "research-tick")!.on;
console.log(`[worker] ${automaticAgentsLine(agents)}`);
// Research is one sequence: score what changed, then propose from the Scores.
const runResearchTick = async () => {
  await runJudgeTick();
  await runProposeTick();
};

let timer: ReturnType<typeof setInterval> | undefined;
let commandTimer: ReturnType<typeof setInterval> | undefined;
let stopHeartbeat: (() => void) | undefined;
let ingestTimer: ReturnType<typeof setInterval> | undefined;
let judgeTimer: ReturnType<typeof setInterval> | undefined;
let studyTimer: ReturnType<typeof setInterval> | undefined;
let chainTimer: ReturnType<typeof setInterval> | undefined;
let metaTimer: ReturnType<typeof setInterval> | undefined;
let momentTimer: ReturnType<typeof setInterval> | undefined;
let radarTimer: ReturnType<typeof setInterval> | undefined;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  clearInterval(commandTimer);
  stopHeartbeat?.();
  clearInterval(ingestTimer);
  if (studyTimer) console.log("[worker] Study stopped");
  clearInterval(studyTimer);
  clearInterval(chainTimer);
  clearInterval(metaTimer);
  clearInterval(momentTimer);
  clearInterval(radarTimer);
  pumpPortal?.close();
  clearInterval(judgeTimer);
  // Stop the drafting loop (nothing new is spawned), kill the live claude child (no orphan keeps spending), let the tick
  // record the interrupted run, then exit.
  shutdown.abort();
  await killLiveBrainChildren();
  await Promise.all(running);
  notifier.close(); // what is still queued or in flight is dropped; a notice is never worth a slow shutdown
  store.close();
  console.log("[worker] stopped");
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

if (once) {
  console.log("[worker] one-shot tick");
  await runTick();
  await runBuildTick();
  await runIngestTick();
  if (researchTickOn) await runResearchTick();
  // A one-shot run lets its notices go out first, for at most 10 s. The cap timer is cleared so a quiet run exits at once
  // instead of idling out the rest of it.
  let cap: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([notifier.idle(), new Promise((r) => (cap = setTimeout(r, 10_000)))]);
  clearTimeout(cap);
  notifier.close();
  if (!stopping) store.close();
} else {
  console.log(`[worker] starting, tick every ${TICK_MS}ms`);
  pumpPortal?.start();
  void runTick();
  void runBuildTick();
  void runIngestTick();
  void runMemeAngleTick();
  timer = setInterval(() => {
    void runTick();
    void runMemeAngleTick();
    void runBuildTick();
  }, TICK_MS);
  // Commands are also applied on their own timer: the tick above waits for a Spec run (up to the brain timeout), and an Undo shortlist
  // for that very run must reach it now, not after it. applyCommands is synchronous, so it never interleaves with the tick's own call.
  commandTimer = setInterval(() => {
    if (stopping) return;
    try {
      applyCommands();
    } catch (e) {
      console.error("[worker] command pass failed", e);
    }
  }, TICK_MS);
  // The heartbeat has its own timer: a tick that waits on a Spec run can pass WORKER_GAP_MS and must not look like a stop (not on a dry run).
  if (!dryRun) {
    stopHeartbeat = startWorkerHeartbeat(
      store,
      TICK_MS,
      (gap) => console.log(`[worker] was stopped from ${gap.start} to ${gap.end}; meme ideas and refreshes do not count that time`),
      (e) => console.error("[worker] heartbeat write failed", e),
    );
  }
  ingestTimer = setInterval(() => void runIngestTick(), INGEST_TICK_MS);
  if (studyOn) {
    studyTimer = setInterval(() => void runStudyTick(), STUDY_TICK_MS);
    console.log(`[worker] Study started: capture tick every ${STUDY_TICK_MS / 1000}s, rule v${STUDY_CAPTURE_RULE.version}`);
    if (dryRun) {
      void runChainTick(); // one report of what a run would use; no chain call
    } else if (chainConfig.apiKey) {
      void runChainTick();
      chainTimer = setInterval(() => void runChainTick(), CHAIN_TICK_MS);
      console.log(`[worker] chain creates started: every ${CHAIN_TICK_MS / 60_000} min, credit cap ${chainConfig.chainCreatesDailyCreditCap} a day, sample ${chainConfig.chainCreatesSampleSize} a day`);
    } else {
      console.log("[worker] chain creates off: HELIUS_API_KEY is not set");
    }
    if (!dryRun) {
      void runMetaTick();
      metaTimer = setInterval(() => void runMetaTick(), META_TICK_MS);
      console.log(`[worker] Meta ranking started: every ${META_TICK_MS / 60_000} min, rank order ${metaConfig.rankOrder.join(" > ")}`);
    }
  }
  judgeTimer = startResearchSchedule({ enabled: researchTickOn, intervalMs: JUDGE_TICK_MS, run: runResearchTick, log: console.log });
  if (momentSettings.enabled) {
    // The first scan waits out the interval since the last one (a restart does not start an extra scan); then one every interval.
    const last = store.moments.lastScan();
    const sinceLastMs = last ? Date.now() - Date.parse(last.at) : Infinity;
    if (sinceLastMs >= MOMENT_TICK_MS) void runMomentTick();
    momentTimer = setInterval(() => void runMomentTick(), MOMENT_TICK_MS);
    console.log(`[worker] Moment scanner started: topic "${momentSettings.topic?.label}", every ${momentSettings.intervalMinutes} min, at most ${momentSettings.loadsPerDay} page loads in 24 h${dryRun ? " (dry run: nothing is spawned)" : ""}`);
  } else console.log("[worker] Moment scanner off (ARGUS_MOMENTS=1 turns it on)");
  // The War Room shows this row, not its own environment (it may have been started with other variables than the worker).
  store.radar.recordWorker({ enabled: radarSettings.enabled, dryRun, startedAt: new Date().toISOString(), lastTickAt: null, geos: RADAR_CONFIG.googleGeos.length, feeds: radarFeeds.length });
  if (radarSettings.enabled) {
    void runRadarTick();
    radarTimer = setInterval(() => void runRadarTick(), RADAR_TICK_MS);
    console.log(`[worker] Trend radar started: Google Trends ${RADAR_CONFIG.googleGeos.join(", ")} and ${radarFeeds.length} news feeds every ${RADAR_CONFIG.tickMinutes} min, at most ${radarSettings.searchesPerTick} DexScreener searches a tick${dryRun ? " (dry run: nothing is polled or searched)" : ""}`);
  } else console.log("[worker] Trend radar off (ARGUS_RADAR=1 turns it on)");
}
