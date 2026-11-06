import type { Datastore } from "./datastore.ts";
import type { Source } from "./sources/source.ts";

/**
 * One ingest pass: polls every Source and stores what is new. Plain code, no brain or LLM involved.
 * A Source that throws is logged and counted, and never stops the others.
 */
export async function ingestSources(
  store: Pick<Datastore, "recordSignals">,
  sources: Source[],
  log: (line: string) => void,
): Promise<{ stored: number; failed: number }> {
  const polled = await Promise.all(
    sources.map(async (source) => {
      try {
        return await source.poll();
      } catch (e) {
        log(`[ingest] ${source.id} failed: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
    }),
  );
  let stored = 0;
  let failed = 0;
  for (const signals of polled) {
    if (signals === undefined) failed++;
    else stored += store.recordSignals(signals);
  }
  return { stored, failed };
}
