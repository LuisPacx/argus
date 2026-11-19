/**
 * How often the worker's passes run (`apps/worker/src/main.ts`). They live here, beside `BUILD_TICK_MS` (build-refusal.ts), so the
 * pipeline graph (pipeline-graph.ts) can show the real intervals instead of a copy.
 */

/** Ingestion: poll the Sources, then cluster new Signals into Narratives. */
export const INGEST_TICK_MS = 5 * 60_000;
/** Research: the judge pass, then the propose pass right after it. */
export const JUDGE_TICK_MS = 30 * 60_000;
/** The Study's capture job (Snapshots of new tokens at their fixed age). */
export const STUDY_TICK_MS = 10_000;
/** The Study's chain-sourced creates job (phase 3 ticket 20): migrated creates through the day, the daily sample once a day. */
export const CHAIN_TICK_MS = 5 * 60_000;
