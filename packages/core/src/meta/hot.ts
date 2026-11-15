import type { Datastore } from "../datastore.ts";
import { META_RULE, type MetaConfig } from "./config.ts";
import { isThin } from "./coverage.ts";
import type { MetaRun, NewMetaHotEvent } from "./store.ts";

/**
 * Hot now (missed ideas ticket 03): which Metas just became worth the Operator's attention. Plain code over two stored runs of the 24 h
 * ranking, the one being checked and one about an hour older, with the thresholds in `MetaConfig`. A Meta is hot when
 *   - it entered the top `hotTopRank` (it ranked below that, or was not a Meta at all, in the older run), or
 *   - its distinct creators in the 24 h window are at least `hotCreatorFactor` times what they were in the older run, which must be no
 *     more than `hotBaselineMaxMinutes` older (so "within 1 h" stays about an hour).
 * News never triggers it (ADR 0011); the matching news is only shown beside the event (`hot-api.ts`).
 *
 * Coverage (viral sources ticket 05, ADR 0012 addendum): no event is raised when either run's 24 h window is thinly covered
 * (`isThin`, the same `coverageNoteBelow` the judge's Meta block uses). After a pause the ranking is made of a few hours of launches, every
 * Meta looks like it just entered the top 5 and counts double as the feed refills, and a "Hot now" from that would be an artefact, not news.
 * A run from before coverage was stored (null) is trusted, as everywhere else.
 */

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

/** The events of `now` against `before`, best-ranked first. None without a `before` run. Pure: no clock, no store, no cool-down (`raiseHotMetas` applies it). */
export function hotEvents(now: MetaRun, before: MetaRun | undefined, config: MetaConfig = META_RULE): NewMetaHotEvent[] {
  if (!before) return [];
  if (isThin(now.coverage?.["24h"], config.coverageNoteBelow) || isThin(before.coverage?.["24h"], config.coverageNoteBelow)) return [];
  const gapMin = (Date.parse(now.computedAt) - Date.parse(before.computedAt)) / MIN_MS;
  const creatorsComparable = Number.isFinite(gapMin) && gapMin <= config.hotBaselineMaxMinutes;
  const was = new Map(before.rows.map((r) => [r.key, r]));
  const out: NewMetaHotEvent[] = [];
  for (const row of now.rows) {
    const prev = was.get(row.key);
    const reasons: string[] = [];
    if (row.rank <= config.hotTopRank && (!prev || prev.rank > config.hotTopRank)) reasons.push(`entered top ${config.hotTopRank}`);
    const creators = row.counts["24h"].creators;
    const prevCreators = prev?.counts["24h"].creators ?? 0;
    if (creatorsComparable && prevCreators > 0 && creators >= config.hotCreatorFactor * prevCreators) {
      reasons.push(`creators ${prevCreators} to ${creators} in ${Math.max(1, Math.round(gapMin / 60))} h`);
    }
    if (reasons.length > 0) out.push({ key: row.key, label: row.label, raisedAt: now.computedAt, reason: reasons.join("; "), rank: row.rank, creators, runId: now.id });
  }
  return out;
}

/**
 * WORKER ONLY. Checks the newest stored 24 h ranking against the run about `hotBaselineMinutes` before it and stores an event for each Meta
 * that is hot and was not raised within the last `hotCooldownHours`. Returns the events stored. Safe to call twice for one run: the
 * cool-down makes the second call store nothing. Nothing here creates a Narrative, Proposal or Score.
 */
export function raiseHotMetas(store: Datastore, config: MetaConfig = META_RULE): NewMetaHotEvent[] {
  const run = store.meta.latest("24h", 200);
  if (!run) return [];
  const asOf = Date.parse(run.computedAt);
  if (!Number.isFinite(asOf)) return [];
  const before = store.meta.latest("24h", 200, new Date(asOf - config.hotBaselineMinutes * MIN_MS).toISOString());
  const raised: NewMetaHotEvent[] = [];
  for (const e of hotEvents(run, before, config)) {
    const last = store.meta.lastHotAt(e.key);
    if (last !== undefined && asOf - Date.parse(last) < config.hotCooldownHours * HOUR_MS) continue;
    store.meta.saveHot(e);
    raised.push(e);
  }
  return raised;
}
