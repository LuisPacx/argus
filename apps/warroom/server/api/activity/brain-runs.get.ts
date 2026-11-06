/** The newest 20 judge and propose runs, with start, end, duration and cost. Read-only. */
export default defineEventHandler(() => useStore().recentBrainRuns(20));
