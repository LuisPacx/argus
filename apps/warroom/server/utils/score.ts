import type { Proposal, Score, WarRoomStore } from "@argus/core";

/**
 * A Proposal as the card shows it: with its Narrative's latest Score (GLOSSARY: a Proposal carries its Narrative's latest), for the
 * Score bars; null for a hand-entered Proposal or a Narrative with no Score. The Narrative age comes from `narrativeCreatedAt`.
 */
export function withScore<T extends Proposal>(store: Pick<WarRoomStore, "latestScore">, p: T): T & { score: Score | null } {
  return { ...p, score: p.narrativeId === null ? null : (store.latestScore(p.narrativeId) ?? null) };
}
