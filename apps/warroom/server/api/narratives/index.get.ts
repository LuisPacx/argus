import type { NarrativeQuery, NarrativeSort } from "@argus/core";

const SORTS: readonly NarrativeSort[] = ["score", "newest", "signals", "active"];
const WINDOWS_MS: Record<string, number> = { "1h": 3_600_000, "6h": 6 * 3_600_000, "24h": 24 * 3_600_000, "7d": 7 * 24 * 3_600_000 };
const bad = (what: string) => createError({ statusCode: 400, statusMessage: `Invalid ${what}` });
const yesNo = (value: unknown, what: string): boolean | undefined => {
  if (value === undefined || value === "") return undefined;
  if (value === "yes") return true;
  if (value === "no") return false;
  throw bad(what);
};
const one = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/**
 * The Narratives list, filtered and sorted in the datastore (the cap cuts after sorting). Query: `sort` (score, newest, signals,
 * active; default score), `scored` and `proposal` (yes or no), `source` (a Source id), `active` (1h, 6h, 24h, 7d: gained a Signal
 * within that long).
 */
export default defineEventHandler((event) => {
  const q = getQuery(event);
  const query: NarrativeQuery = {};
  const sort = one(q.sort);
  if (sort !== undefined) {
    if (!SORTS.includes(sort as NarrativeSort)) throw bad("sort");
    query.sort = sort as NarrativeSort;
  }
  const scored = yesNo(q.scored, "scored filter");
  if (scored !== undefined) query.scored = scored;
  const hasProposal = yesNo(q.proposal, "proposal filter");
  if (hasProposal !== undefined) query.hasProposal = hasProposal;
  const source = one(q.source);
  if (source !== undefined) query.sourceId = source;
  const active = one(q.active);
  if (active !== undefined) {
    if (!Object.hasOwn(WINDOWS_MS, active)) throw bad("active window");
    query.activeSince = new Date(Date.now() - WINDOWS_MS[active]!).toISOString();
  }
  return useStore().queryNarratives(query);
});
