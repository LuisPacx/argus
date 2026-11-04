import { Datastore, applyPendingCommands } from "@argus/core";
import { reentrant } from "./reentrant.ts";

const TICK_MS = 5_000;
const store = Datastore.open(process.env.ARGUS_DB ?? "../../.data/argus.db");

const tick = reentrant(
  async () => {
    console.log(`[worker] tick ${new Date().toISOString()}`);
    const n = applyPendingCommands(store);
    if (n > 0) console.log(`[worker] resolved ${n} command(s)`);
  },
  () => console.log("[worker] tick skipped: previous tick still running"),
);

console.log(`[worker] starting, tick every ${TICK_MS}ms`);
void tick().catch((e) => console.error("[worker] tick failed", e));
setInterval(() => void tick().catch((e) => console.error("[worker] tick failed", e)), TICK_MS);
