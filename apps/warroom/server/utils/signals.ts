import type { Proposal, WarRoomStore } from "@argus/core";

/** How many of the Narrative's Signals the "Why this Proposal" panel shows. */
export const WHY_SIGNALS = 5;

export interface WhySignalRow {
  title: string;
  sourceLabel: string;
  url: string;
  publishedAt: string;
}

/** A Proposal with its Narrative's top Signals (newest first); `[]` for a hand-entered Proposal. Text is raw: the page escapes it. */
export function withSignals<T extends Proposal>(store: Pick<WarRoomStore, "getNarrative">, p: T): T & { signals: WhySignalRow[] } {
  const signals = p.narrativeId === null ? [] : (store.getNarrative(p.narrativeId)?.signals ?? []);
  return { ...p, signals: signals.slice(0, WHY_SIGNALS).map((s) => ({ title: s.title, sourceLabel: s.sourceLabel, url: s.url, publishedAt: s.publishedAt })) };
}
