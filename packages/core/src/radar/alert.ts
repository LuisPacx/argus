import { RADAR_CONFIG } from "./config.ts";
import type { SourceAlert, SourceState } from "./types.ts";

/**
 * The source alert (ticket 01 item 7a): a source that has not been `ok` for more than an hour (`backing off`, `format changed` or `down`;
 * Google Trends included) raises a banner on `/radar` and `/`. It clears itself on the next good poll, which makes the state `ok`.
 * `since` is when the source last stopped being ok, so a stretch that moves from `backing off` to `down` keeps its start.
 */
export function sourceAlerts(states: readonly SourceState[], now: Date): SourceAlert[] {
  const out: SourceAlert[] = [];
  for (const s of states) {
    if (s.status === "ok") continue;
    const since = Date.parse(s.since);
    if (!Number.isFinite(since) || now.getTime() - since <= RADAR_CONFIG.alertAfterMs) continue;
    out.push({ source: s.source, status: s.status, reason: s.reason, since: s.since, lastOk: s.lastOk });
  }
  return out;
}
