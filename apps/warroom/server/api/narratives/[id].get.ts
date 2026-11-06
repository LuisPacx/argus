export default defineEventHandler((event) => {
  const store = useStore();
  const narrative = store.getNarrative(Number(getRouterParam(event, "id")));
  if (!narrative) throw createError({ statusCode: 404, statusMessage: "Narrative not found" });
  // `runs`: the judge runs with the backend that served each (claude-code: Est. usage; api: real dollars).
  return { ...narrative, runs: store.judgeRunsFor(narrative.id) };
});
