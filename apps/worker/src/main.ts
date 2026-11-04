import { reentrant } from "./reentrant.ts";

const TICK_MS = 5_000;

const tick = reentrant(
  async () => {
    console.log(`[worker] tick ${new Date().toISOString()}`);
  },
  () => console.log("[worker] tick skipped: previous tick still running"),
);

console.log(`[worker] starting, tick every ${TICK_MS}ms`);
void tick();
setInterval(() => void tick().catch((e) => console.error("[worker] tick failed", e)), TICK_MS);
