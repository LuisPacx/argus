import type { Proposal, Score, WarRoomStore } from "@argus/core";

/**
 * A Proposal as the card shows it: `score` is the Score it was created from (`scoreId`, the one the propose pass's gate saw), and
 * `latestScore` is the Narrative's latest, present only when that is a different Score (the Narrative was judged again since).
 * A hand-entered Proposal has neither; a null or dangling `scoreId` falls back to the latest as `score` with no `latestScore`.
 * The Why panel and the list's Score sort read `score`. The Narrative age comes from `narrativeCreatedAt`.
 */
export function withScore<T extends Proposal>(store: Pick<WarRoomStore, "latestScore" | "getScore">, p: T): T & { score: Score | null; latestScore?: Score } {
  if (p.narrativeId === null) return { ...p, score: null };
  const latest = store.latestScore(p.narrativeId) ?? null;
  const created = store.getScore(p.scoreId) ?? null;
  if (created === null) return { ...p, score: latest };
  return latest !== null && latest.id !== created.id ? { ...p, score: created, latestScore: latest } : { ...p, score: created };
}
