import { Datastore, applyPendingCommands } from "@argus/core";
import { reentrant } from "./reentrant.ts";

const TICK_MS = 5_000;
const once = process.argv.includes("--once");
const store = Datastore.open(process.env.ARGUS_DB ?? "../../.data/argus.db");

const tick = reentrant(
  async () => {
    console.log(`[worker] tick ${new Date().toISOString()}`);
    const n = applyPendingCommands(store, (c, e) =>
      console.error(`[worker] command ${c.id} failed, will retry next tick:`, e),
    );
    if (n > 0) console.log(`[worker] resolved ${n} command(s)`);
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
