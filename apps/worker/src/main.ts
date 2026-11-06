import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ApiBrain,
  BackoffSource,
  FallbackBrain,
  announceNewProposals,
  anthropicKeyFromEnv,
  apiFallbackConfigFromEnv,
  apiSpentUsd,
  createNotifier,
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
  runPendingBuilds,
  sweepDismissedHomes,
  sweepStaleSeals,
  type BuildRunnerOptions,
  type Source,
} from "@argus/core";
import { reentrant } from "./reentrant.ts";
import { SEMANTIC_MODEL, backgroundEmbedder, embedderIdOf, loadSemanticEmbedder, modelCacheDir } from "./semantic-embedder.ts";

const TICK_MS = 5_000;
const INGEST_TICK_MS = 5 * 60_000;
const JUDGE_TICK_MS = 30 * 60_000;
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
const sandbox = new PodmanSandbox({
  image: process.env.ARGUS_BUILD_IMAGE || currentImageTag(repoRoot),
  podmanBin: process.env.ARGUS_PODMAN_BIN || "podman",
  tokenPath: process.env.ARGUS_BUILD_TOKEN_FILE || join(homedir(), ".config", "argus", "build-token"),
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
const buildOptions: BuildRunnerOptions = {
  notifier,
  buildRoot,
  templateRepo: process.env.ARGUS_TEMPLATE_REPO || join(buildRoot, "argus-build-template"),
  dataDir,
  sandbox,
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
const tick = reentrant(
  async () => {
    console.log(`[worker] tick ${new Date().toISOString()}`);
    const n = applyPendingCommands(
      store,
      (c, e) => console.error(`[worker] command ${c.id} hit a non-domain error (attempt recorded):`, e),
      { dataDir, log: console.log, buildRoot, githubRepoExists: ghRepoExists },
    );
    if (n > 0) console.log(`[worker] resolved ${n} command(s)`);
    sweepStaleRuns();
    expireStaleProposals(store, new Date(), console.log);
    announceNewProposals(store, notifier);
    await draftPendingSpecs(store, brain, dataDir, console.log, shutdown.signal);
    await revisePendingSpecs(store, brain, dataDir, console.log, shutdown.signal);
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
const pumpPortal = standingOn && !once && !dryRun ? new PumpPortalSource({ url: process.env.ARGUS_PUMPPORTAL_URL || undefined, log: console.error }) : undefined;
if (pumpPortal) standingSources.push(pumpPortal);
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
// Judge and propose share one rolling-24 h research budget (about 30% of the assumed daily quota, research-budget.ts), checked before every run.
const researchBudget = researchConfigFromEnv(process.env);
const judgeEmbedder = embedderChoice === "hashing" ? new HashingEmbedder() : { id: embedderIdOf(SEMANTIC_MODEL), dimension: SEMANTIC_MODEL.dimension };
const judgeTick = reentrant(
  async () => {
    const r = await judgePendingNarratives(store, brain, judgeEmbedder, { config: judgeConfig, research: researchBudget, log: console.log, signal: shutdown.signal });
    console.log(`[worker] judge tick: ${r.judged} scored, ${r.refused} refused, ${r.failed} failed${r.stoppedBy ? `, stopped: ${r.stoppedBy}` : ""}`);
  },
  () => console.log("[worker] judge tick skipped: previous judge pass still running"),
);
// The propose pass turns Narratives whose Score passes the Rubric's buildability gate into Proposals (docs/architecture.md section 7), right
// after each judge pass. At most 10 new Proposals a day; ARGUS_PROPOSE_* lower its other caps. A dry run logs the command and spawns nothing.
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
// Research is one sequence: score what changed, then propose from the Scores.
const runResearchTick = async () => {
  await runJudgeTick();
  await runProposeTick();
};

let timer: ReturnType<typeof setInterval> | undefined;
let ingestTimer: ReturnType<typeof setInterval> | undefined;
let judgeTimer: ReturnType<typeof setInterval> | undefined;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  clearInterval(ingestTimer);
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
  await runResearchTick();
  await Promise.race([notifier.idle(), new Promise((r) => setTimeout(r, 10_000))]); // a one-shot run lets its notices go out first
  notifier.close();
  if (!stopping) store.close();
} else {
  console.log(`[worker] starting, tick every ${TICK_MS}ms`);
  pumpPortal?.start();
  void runTick();
  void runBuildTick();
  void runIngestTick();
  void runResearchTick();
  timer = setInterval(() => {
    void runTick();
    void runBuildTick();
  }, TICK_MS);
  ingestTimer = setInterval(() => void runIngestTick(), INGEST_TICK_MS);
  judgeTimer = setInterval(() => void runResearchTick(), JUDGE_TICK_MS);
}
