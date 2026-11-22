import { flat } from "../context-block.ts";
import type { Datastore } from "../datastore.ts";
import { META_RULE, type MetaConfig } from "./config.ts";
import type { CurrentMeta, MetaCurrent, NewMetaNewEvent } from "./store.ts";
import { leaderMoney } from "./summary.ts";

/**
 * New Meta (meta redesign ticket 03, replaces Hot now): the moment a subject becomes a Meta. Plain code over two stored runs of the
 * market-led rule (ADR 0014): a subject that is a Meta in this run and was not in the run before it is new. News never triggers it (ADR 0011).
 *
 * - With no run before, or one older than `stateMaxMinutes` (a first run, a restart, a pause), nothing is raised: that run only
 *   re-establishes the baseline, so a restart or a gap never raises a burst of "new" Metas that were there all along.
 * - Hysteresis (ADR 0014) already stops a Meta flapping at the entry cap, so there is no cool-down here; a subject that fell out and
 *   comes back is a new Meta again.
 * - A subject that was only Watching and is now a Meta is new.
 * - A Meta that was re-keyed or renamed (the grouping step of ADR 0015) is not new while its leader is the one that led a Meta in the run before.
 */

const MIN_MS = 60_000;

/** The shown form of a leader: `$SYMBOL` when it has a symbol, else its name. Creator-written, so cleaned and cut. */
export function leaderTag(leader: { name: string; symbol: string }): string {
  const plain = (s: string, max: number) => flat(s.replaceAll("<", "").replaceAll(">", ""), max);
  const symbol = plain(leader.symbol, 20).replace(/^\$+/, "").trim();
  if (symbol !== "") return `$${symbol}`;
  const name = plain(leader.name, 40);
  return name === "" ? "its leader" : name;
}

/** `became a Meta: 12 graduated in 24 h, $JENSEN at $2.4M, 14 creators in 24 h` (no graduation part on a row stored before graduation Metas; `at -` for a leader with no price): written by code from the stored numbers; the leader's tag is creator text, cleaned and cut. */
export function newMetaReason(m: CurrentMeta): string {
  const copies = m.counts["24h"].creators;
  const grads = m.grads ? `${m.grads["24h"]} graduated in 24 h, ` : "";
  return `became a Meta: ${grads}${leaderTag(m.leader)} at ${leaderMoney(m.leader.marketCapUsd)}, ${copies} ${copies === 1 ? "creator" : "creators"} in 24 h`;
}

/** The events of `current` against `previous`, in Meta order (highest leader market cap first). Pure: no clock, no store. */
export function newMetaEvents(current: MetaCurrent, previous: MetaCurrent | undefined, config: Pick<MetaConfig, "stateMaxMinutes"> = META_RULE): NewMetaNewEvent[] {
  if (!previous) return [];
  const gapMin = (Date.parse(current.computedAt) - Date.parse(previous.computedAt)) / MIN_MS;
  if (!Number.isFinite(gapMin) || gapMin > config.stateMaxMinutes) return [];
  const was = new Set(previous.metas.map((m) => m.key));
  // A subject renamed or re-keyed by the grouping step (ticket 06: `lucia` became `gta6`) is the same Meta while its leader is the one that led
  // a Meta in the run before: the continuation of ADR 0014 follows the leader's mint, so a new key alone is not a new Meta.
  const ledBefore = new Set(previous.metas.map((m) => m.leader.mint));
  const out: NewMetaNewEvent[] = [];
  current.metas.forEach((m, i) => {
    if (was.has(m.key) || ledBefore.has(m.leader.mint)) return;
    out.push({
      key: m.key,
      label: m.label,
      raisedAt: current.computedAt,
      reason: newMetaReason(m),
      rank: i + 1,
      leader: { mint: m.leader.mint, name: m.leader.name, symbol: m.leader.symbol, marketCapUsd: m.leader.marketCapUsd },
      copies: m.counts["24h"].creators,
      runId: current.runId,
    });
  });
  return out;
}

/**
 * WORKER ONLY. Compares the newest stored run's Metas with the run before it and stores an event for each new one. Returns the events
 * stored (those already stored for the run are not stored again, so a second call for the same run returns none). Nothing here creates a
 * Narrative, Proposal or Score.
 */
export function raiseNewMetas(store: Datastore, config: Pick<MetaConfig, "stateMaxMinutes"> = META_RULE): NewMetaNewEvent[] {
  const current = store.currentMetas();
  if (!current) return [];
  const raised: NewMetaNewEvent[] = [];
  for (const e of newMetaEvents(current, store.meta.currentBefore(current.runId), config)) if (store.meta.saveNewMeta(e)) raised.push(e);
  return raised;
}

/**
 * WORKER ONLY. `raiseNewMetas` for the Meta tick: a failure is logged and swallowed, so a New Meta problem never stops the ranking tick that
 * called it or the summary tick that follows it. Returns the events stored (none on failure).
 */
export function raiseNewMetasSafely(store: Datastore, config: Pick<MetaConfig, "stateMaxMinutes"> = META_RULE, log: (line: string, error?: unknown) => void = console.error): NewMetaNewEvent[] {
  try {
    return raiseNewMetas(store, config);
  } catch (e) {
    log("[worker] new meta failed", e);
    return [];
  }
}
