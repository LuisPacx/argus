export default defineEventHandler((event) => useStore().historyFor(Number(getRouterParam(event, "id"))));
