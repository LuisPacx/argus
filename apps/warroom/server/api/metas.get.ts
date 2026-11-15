import { isMetaWindow, liveHot, metaConfigFromEnv, metasResponse, type MetaWindow } from "@argus/core";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;
const bad = (what: string) => createError({ statusCode: 400, statusMessage: `Invalid ${what}` });
const one = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/**
 * The live Metas, ranked, from the worker's latest stored run (read-only; the page computes nothing). Query: `window` (6h or 24h;
 * default 24h) and `limit` (1 to 50; default 10). Before the first run it answers an empty list with a null `computedAt`.
 * Every row carries a one-line `summary`: the model's line, else a templated numbers line (`summarySource` says which).
 */
export default defineEventHandler((event) => {
  const q = getQuery(event);
  if (Array.isArray(q.window)) throw bad("window"); // a repeated ?window= is ambiguous, not the default
  const rawWindow = one(q.window) ?? "24h";
  if (!isMetaWindow(rawWindow)) throw bad("window");
  const window: MetaWindow = rawWindow;
  const rawLimit = one(q.limit);
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    if (!/^\d{1,3}$/.test(rawLimit)) throw bad("limit");
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_LIMIT) throw bad("limit");
  }
  const config = metaConfigFromEnv();
  const store = useStore();
  // A Meta whose Hot now event is live (raised within the cool-down) carries `hot`: why and when.
  return metasResponse(store.latestMetas(window, limit), window, config.coverageNoteBelow, liveHot(store, new Date(), config));
});
