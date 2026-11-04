export default defineEventHandler((event) => {
  const proposal = useStore().getProposal(Number(getRouterParam(event, "id")));
  if (!proposal) throw createError({ statusCode: 404, statusMessage: "Proposal not found" });
  return proposal;
});
