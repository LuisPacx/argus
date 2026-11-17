import type { Datastore, ProposalKind } from "./datastore.ts";
import type { ProposalStatus } from "./lifecycle.ts";
import { gapMsHeld, type WorkerGap } from "./worker-gaps.ts";

const HOUR_MS = 3_600_000;

/** How long a Proposal may sit in a state before it goes stale (architecture section 3). Other states, `spec-drafted` included, never expire. */
export const EXPIRY_MS: Partial<Record<ProposalStatus, number>> = {
  new: 48 * HOUR_MS,
  shortlisted: 7 * 24 * HOUR_MS,
};

/**
 * A `meme` Proposal (ADR 0013, amended 2026-11-15) lives 12 h in `new`: a joke about a live Meta is stale by then, and it matches the 12 h
 * refresh (`MEME_REFRESH_MS`), so a Meta that stays one always has live ideas. A shortlisted one keeps `EXPIRY_MS.shortlisted`.
 */
export const MEME_EXPIRY_MS: Partial<Record<ProposalStatus, number>> = { new: 12 * HOUR_MS };

/** When a Proposal that entered `status` at `since` (ISO, the `status_history.at` of that transition) goes stale, as an ISO time; null for a state that never expires. */
export function expiresAtFor(status: ProposalStatus, since: string, kind: ProposalKind = "narrative", gaps: readonly WorkerGap[] = []): string | null {
  const memeTtl = kind === "meme" ? MEME_EXPIRY_MS[status] : undefined;
  const ttl = memeTtl ?? EXPIRY_MS[status];
  if (ttl === undefined) return null;
  // Only the meme 12 h counts running time: the worker's recorded stops after `since` push it out, with no cap. Narrative lives stay wall-clock.
  const held = memeTtl === undefined ? 0 : gapMsHeld(gaps, since, ttl);
  return new Date(new Date(since).getTime() + ttl + held).toISOString();
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
