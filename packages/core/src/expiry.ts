import type { Datastore } from "./datastore.ts";
import type { ProposalStatus } from "./lifecycle.ts";

const HOUR_MS = 3_600_000;

/** How long a Proposal may sit in a state before it goes stale (architecture section 3). Other states, `spec-drafted` included, never expire. */
export const EXPIRY_MS: Partial<Record<ProposalStatus, number>> = {
  new: 48 * HOUR_MS,
  shortlisted: 7 * 24 * HOUR_MS,
};

/** When a Proposal that entered `status` at `since` (ISO) goes stale, as an ISO time; null for a state that never expires. */
export function expiresAtFor(status: ProposalStatus, since: string): string | null {
  const ttl = EXPIRY_MS[status];
  return ttl === undefined ? null : new Date(new Date(since).getTime() + ttl).toISOString();
}

/**
 * Closes every stale Proposal through the lifecycle (system actor, reason `stale`) and returns how many it closed. A Proposal with
 * a Brain run in flight is skipped, so a run is never cut off mid-way; it is picked up on a later tick once the run has ended.
 * `now` is a parameter so tests drive a fake clock.
 */
export function expireStaleProposals(store: Datastore, now: Date = new Date(), log?: (line: string) => void): number {
  let n = 0;
  for (const p of store.listProposals()) {
    if (p.expiresAt === null || p.brainRunInFlightSince !== null) continue;
    if (new Date(p.expiresAt).getTime() > now.getTime()) continue;
    store.transition(p.id, "closed", "system");
    log?.(`[worker] closed stale Proposal ${p.id} (${p.status})`);
    n++;
  }
  return n;
}
