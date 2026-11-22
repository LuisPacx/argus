export default defineEventHandler((event) => {
  const store = useStore();
  const narrative = store.getNarrative(Number(getRouterParam(event, "id")));
  if (!narrative) throw createError({ statusCode: 404, statusMessage: "Narrative not found" });
  // `runs`: the judge runs with the backend that served each (claude-code: Est. usage; api: real dollars).
  // `verdicts`: the Operator's verdicts, newest (the current one) first. `proposals`: the Proposals made from this Narrative, as links.
  // `ideaVerdict` on a meme idea: the Operator's current Idea verdict (ticket 21).
  const ideaVerdicts = store.currentProposalVerdicts();
  const proposals = store.listProposals().filter((p) => p.narrativeId === narrative.id).map((p) => ({ id: p.id, name: p.name, ticker: p.ticker, kind: p.kind, status: p.status, ideaVerdict: ideaVerdicts[p.id] ?? null }));
  return { ...narrative, runs: store.judgeRunsFor(narrative.id), verdicts: store.verdictsFor(narrative.id), proposals };
});
