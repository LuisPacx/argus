/**
 * The score of a Trend that only Google Trends carries (spec section 5.2: one independent source is 20 points; `approx_traffic` of 5,000 or
 * more adds 10, of 20,000 or more adds 20 instead). Ticket 02 adds the other parts and gates the page on it; in ticket 01 it only orders the page.
 */
export function googleScore(trafficMin: number): number {
  return 20 + (trafficMin >= 20_000 ? 20 : trafficMin >= 5_000 ? 10 : 0);
}
