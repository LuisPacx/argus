import { metaConfigFromEnv, newMetasResponse } from "@argus/core";

/**
 * The live New Meta events (read-only; the page computes nothing): each subject that became a Meta within the last few hours and still is
 * one, as a Current Meta row (leader token, summary, counts) with the news that names it (context only). An empty list, not an error,
 * before the first run and while nothing is new.
 */
export default defineEventHandler(() => newMetasResponse(useStore(), new Date(), metaConfigFromEnv()));
