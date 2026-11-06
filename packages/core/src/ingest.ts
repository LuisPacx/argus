import type { Datastore } from "./datastore.ts";
import type { Source } from "./sources/source.ts";

/**
 * One ingest pass: polls every Source and stores what is new. Plain code, no brain or LLM involved.
 * A Source that throws is logged, counted and recorded as failed, and never stops the others. Every poll, successful or not
 * (a Source with nothing new included), is recorded for the War Room's Source health.
 */
export async function ingestSources(
  store: Pick<Datastore, "recordSignals" | "recordSourcePoll">,
  sources: Source[],
  log: (line: string) => void,
): Promise<{ stored: number; failed: number }> {
  // Bookkeeping only: a failed write is logged and never rejects the pass or costs another Source its Signals.
  const record = (source: Source, error?: string) => {
    try {
      store.recordSourcePoll({ sourceId: source.id, label: source.label, ...(error === undefined ? {} : { error }) });
    } catch (e) {
      log(`[ingest] ${source.id} poll not recorded: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const polled = await Promise.all(
    sources.map(async (source) => {
      try {
        return await source.poll();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log(`[ingest] ${source.id} failed: ${message}`);
        record(source, message);
        return undefined;
      }
    }),
  );
  let stored = 0;
  let failed = 0;
  polled.forEach((signals, i) => {
    if (signals === undefined) {
      failed++;
      return;
    }
    stored += store.recordSignals(signals);
    record(sources[i]!);
  });
  return { stored, failed };
}
