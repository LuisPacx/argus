import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClaudeCodeBrain,
  Datastore,
  PodmanSandbox,
  applyPendingCommands,
  capsFromEnv,
  currentImageTag,
  draftPendingSpecs,
  expireStaleProposals,
  githubRepoCheck,
  killLiveBrainChildren,
  revisePendingSpecs,
  runPendingBuilds,
  sweepStaleSeals,
  type BuildRunnerOptions,
} from "@argus/core";
import { reentrant } from "./reentrant.ts";

const TICK_MS = 5_000;
const once = process.argv.includes("--once");
const dryRun = process.argv.includes("--dry-run") || process.env.ARGUS_DRY_RUN === "1";
const dbPath = process.env.ARGUS_DB ?? "../../.data/argus.db";
const store = Datastore.open(dbPath);
const dataDir = process.env.ARGUS_DATA_DIR || dirname(resolve(dbPath));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// Children run from a temp dir holding only the task's skill, never the repo root (.env, .data/argus.db).
const brain = new ClaudeCodeBrain({ skillsDir: join(repoRoot, ".claude", "skills"), dryRun, command: process.env.ARGUS_CLAUDE_BIN || "claude" });

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
const buildOptions: BuildRunnerOptions = {
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
    await draftPendingSpecs(store, brain, dataDir, console.log, shutdown.signal);
    await revisePendingSpecs(store, brain, dataDir, console.log, shutdown.signal);
  },
  () => console.log("[worker] tick skipped: previous tick still running"),
);
// Builds run on their own guarded loop: a Build takes hours, and commands, Spec drafts and revises must not wait for it.
// `runPendingBuilds` itself takes one Build at a time, so a long Build never overlaps another.
const buildTick = reentrant(
  async () => {
    const n = await runPendingBuilds(store, brain, buildOptions, shutdown.signal);
    if (n > 0) console.log(`[worker] finished ${n} build(s)`);
  },
  () => {}, // a Build is still running: the next tick tries again (no log line: a Build takes hours)
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

let timer: ReturnType<typeof setInterval> | undefined;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  // Stop the drafting loop (nothing new is spawned), kill the live claude child (no orphan keeps spending), let the tick
  // record the interrupted run, then exit.
  shutdown.abort();
  await killLiveBrainChildren();
  await Promise.all(running);
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
  if (!stopping) store.close();
} else {
  console.log(`[worker] starting, tick every ${TICK_MS}ms`);
  void runTick();
  void runBuildTick();
  timer = setInterval(() => {
    void runTick();
    void runBuildTick();
  }, TICK_MS);
}
