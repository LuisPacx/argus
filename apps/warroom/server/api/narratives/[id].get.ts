export default defineEventHandler((event) => {
  const narrative = useStore().getNarrative(Number(getRouterParam(event, "id")));
  if (!narrative) throw createError({ statusCode: 404, statusMessage: "Narrative not found" });
  return narrative;
});
