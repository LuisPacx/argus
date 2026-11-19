/** X's snowflake epoch: 2010-11-04T01:42:54.657Z. A status ID is `(milliseconds since it << 22) | worker and sequence bits`. */
const TWITTER_EPOCH_MS = 1_288_834_974_657n;
/** 15 digits is the shortest ID of any post that matters here (a post from 2013 or later); anything shorter is not one of ours. */
const STATUS_ID_RE = /^[1-9]\d{14,18}$/;

/** Whether `id` is a plausible status ID: 15 to 19 digits, no sign, no zero lead. */
export const isStatusId = (id: unknown): id is string => typeof id === "string" && STATUS_ID_RE.test(id);

/**
 * The time a post was created, read from its status ID, exact to the millisecond (X's search results show no time element).
 * Example: 2123280111864811617 is 2026-11-19T05:00:01Z. Returns null for anything that is not a plausible ID.
 */
export function statusIdTime(id: string): Date | null {
  if (!isStatusId(id)) return null;
  const ms = Number((BigInt(id) >> 22n) + TWITTER_EPOCH_MS);
  const when = new Date(ms);
  return Number.isNaN(when.getTime()) ? null : when;
}
