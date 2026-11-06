/**
 * The newest 20 Narratives with their latest Score and gate result. The gate is buildability against the minimum of the Rubric
 * version the Score used (versions are immutable), derived here and never stored.
 */
export default defineEventHandler(() => {
  const store = useStore();
  return store.newestNarratives(20).map((n) => {
    const s = store.latestScore(n.id);
    const min = s ? store.getRubric(s.rubricVersion).gateMinScore : null;
    return {
      id: n.id,
      title: n.title,
      signalCount: n.signalCount,
      createdAt: n.createdAt,
      lastSignalAt: n.lastSignalAt,
      score: s ? { total: s.total, rubricVersion: s.rubricVersion, createdAt: s.createdAt, scores: s.scores } : null,
      gate: s && min !== null ? { dimension: "buildability" as const, value: s.scores.buildability, min, passed: s.scores.buildability >= min } : null,
    };
  });
});
