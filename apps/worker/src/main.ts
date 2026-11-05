import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeBrain, Datastore, applyPendingCommands, draftPendingSpecs, killLiveBrainChildren } from "@argus/core";
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

// An open brain run older than its task's timeout plus grace belongs to a process that died: surface it, never retry.
// A younger one may be live (this process, or a foreground --once beside the daemon): leave it. Runs at boot and every tick.
const sweepStaleRuns = () => {
  const interrupted = store.interruptStaleBrainRuns((task) => brain.staleAfterMs(task));
  if (interrupted > 0) console.error(`[worker] ${interrupted} brain run(s) were interrupted by a dead worker; flagged on their cards`);
};
sweepStaleRuns();

const shutdown = new AbortController();
const tick = reentrant(
  async () => {
    console.log(`[worker] tick ${new Date().toISOString()}`);
    const n = applyPendingCommands(store, (c, e) =>
      console.error(`[worker] command ${c.id} hit a non-domain error (attempt recorded):`, e),
    );
    if (n > 0) console.log(`[worker] resolved ${n} command(s)`);
    sweepStaleRuns();
    await draftPendingSpecs(store, brain, dataDir, console.log, shutdown.signal);
  },
  () => console.log("[worker] tick skipped: previous tick still running"),
);
const running = new Set<Promise<unknown>>();
const runTick = () => {
  const p: Promise<unknown> = tick()
    .catch((e) => console.error("[worker] tick failed", e))
    .finally(() => running.delete(p));
  running.add(p);
  return p;
};

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
  if (!stopping) store.close();
} else {
  console.log(`[worker] starting, tick every ${TICK_MS}ms`);
  void runTick();
  timer = setInterval(() => void runTick(), TICK_MS);
}
