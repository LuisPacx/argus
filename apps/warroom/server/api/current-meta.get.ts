import { currentMetaResponse, liveNewMetas, memeIdeasByKey, metaConfigFromEnv } from "@argus/core";

/**
 * The Current Meta (ADR 0014, meta redesign ticket 02), read-only: at most 3 Metas (each led by a token at millions of market cap) and
 * at most 3 Watching subjects (up, but not a Meta), in leader-cap order, from the worker's latest stored run. No query. Each row carries
 * its leader, copies, `holding` (cooling), `enteredAt`, a one-line `summary` (the model's line while it holds, else a numbers line) and,
 * for a Meta, its live meme ideas. Before the first run: empty lists and a null `computedAt`.
 */
export default defineEventHandler(() => {
  const config = metaConfigFromEnv();
  const store = useStore();
  const current = store.currentMetas();
  const keys = current ? [...current.metas, ...current.watching].map((m) => m.key) : [];
  return currentMetaResponse(
    current,
    store.latestMetas("24h", 1)?.coverage ?? null,
    store.metaSummaries(keys),
    liveNewMetas(store, new Date(), config),
    memeIdeasByKey(store.liveMemeProposals()),
    config.coverageNoteBelow,
  );
});
