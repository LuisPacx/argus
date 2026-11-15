import { hotNowResponse, metaConfigFromEnv } from "@argus/core";

/**
 * The live Hot now events (read-only; the page computes nothing): each Meta that entered the top of the 24 h ranking or whose creators
 * doubled in about an hour within the last cool-down, with its ranking row (label, summary, top tokens, migrations) and the matching news
 * of the last 24 h. News is context: it is shown here and never raises an event. Before the first ranking run it answers an empty list.
 */
export default defineEventHandler(() => hotNowResponse(useStore(), new Date(), metaConfigFromEnv()));
