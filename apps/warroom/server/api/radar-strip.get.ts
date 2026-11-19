/**
 * The home page's one-line Radar strip (trend radar ticket 01): how many Trends are shown, how many are untokenized and the source banners due.
 * Read only, and small: it never carries the Trends themselves.
 */
export default defineEventHandler(() => {
  const strip = useStore().radarStrip(new Date());
  return {
    enabled: process.env.ARGUS_RADAR === "1",
    shown: strip.shown,
    untokenized: strip.untokenized,
    alerts: strip.alerts.map((a) => ({ source: a.source, status: a.status, reason: a.reason, since: a.since, lastOk: a.lastOk })),
  };
});
