/**
 * The Source class (ticket 24, docs/adr/0011): the one place that says which Sources can make a Narrative eligible.
 * `market` Signals (PumpPortal, DexScreener) decide whether a Narrative is judged and proposed. `context` Signals (news, Trends, GitHub)
 * are ingested and clustered but only ever background. A Source that is not listed is `context`, so a new Source cannot start producing
 * Proposals by being forgotten: declare it `market` here on purpose. The datastore takes its market id list from this table.
 */
export type SourceClass = "context" | "market";

/** Exact Source ids. A test fails when a registered Source has neither an entry here nor a prefix below. */
export const SOURCE_CLASS: Readonly<Record<string, SourceClass>> = {
  "pumpportal:events": "market",
  "dexscreener:trending": "market",
  "trends:google": "context",
  "github:trending": "context",
};

/** Id prefixes, for Sources with one id per feed. Context only: a market Source is always listed by its exact id above. */
export const SOURCE_CLASS_PREFIX: Readonly<Record<string, "context">> = {
  "rss:": "context",
};

/** The class of a Source id. Unknown ids are `context` (fail closed). */
export function sourceClass(sourceId: string): SourceClass {
  const exact = Object.hasOwn(SOURCE_CLASS, sourceId) ? SOURCE_CLASS[sourceId] : undefined;
  if (exact) return exact;
  for (const prefix of Object.keys(SOURCE_CLASS_PREFIX)) if (sourceId.startsWith(prefix)) return SOURCE_CLASS_PREFIX[prefix]!;
  return "context";
}

/** Every Source id declared `market`: what the selection queries match a Signal's `source_id` against. */
export const MARKET_SOURCE_IDS: readonly string[] = Object.entries(SOURCE_CLASS)
  .filter(([, c]) => c === "market")
  .map(([id]) => id);
