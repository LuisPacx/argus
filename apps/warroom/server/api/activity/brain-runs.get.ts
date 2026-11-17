import { DEFAULT_RESEARCH_RUN_CAPS } from "@argus/core";

/** The newest 20 judge and propose runs, with start, end, duration and cost. Read-only. */
// A run that ended without a reported cost shows what the research budget charges it (its route's cap), marked estimated, not $0.
export default defineEventHandler(() => useStore().recentBrainRuns(20, DEFAULT_RESEARCH_RUN_CAPS));
