import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeBrain, Datastore, applyPendingCommands, draftPendingSpecs } from "@argus/core";
import { reentrant } from "./reentrant.ts";

const TICK_MS = 5_000;
const once = process.argv.includes("--once");
const dryRun = process.argv.includes("--dry-run") || process.env.ARGUS_DRY_RUN === "1";
const dbPath = process.env.ARGUS_DB ?? "../../.data/argus.db";
const store = Datastore.open(dbPath);
const dataDir = process.env.ARGUS_DATA_DIR || dirname(resolve(dbPath));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const brain = new ClaudeCodeBrain({ cwd: repoRoot, dryRun, command: process.env.ARGUS_CLAUDE_BIN || "claude" });

const tick = reentrant(
  async () => {
    console.log(`[worker] tick ${new Date().toISOString()}`);
    const n = applyPendingCommands(store, (c, e) =>
      console.error(`[worker] command ${c.id} hit a non-domain error (attempt recorded):`, e),
    );
    if (n > 0) console.log(`[worker] resolved ${n} command(s)`);
    await draftPendingSpecs(store, brain, dataDir);
  },
  () => console.log("[worker] tick skipped: previous tick still running"),
);
const runTick = () => tick().catch((e) => console.error("[worker] tick failed", e));

if (once) {
  console.log("[worker] one-shot tick");
  await runTick();
  store.close();
} else {
  console.log(`[worker] starting, tick every ${TICK_MS}ms`);
  void runTick();
  const timer = setInterval(() => void runTick(), TICK_MS);
  const stop = () => {
    clearInterval(timer);
    store.close();
    console.log("[worker] stopped");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
