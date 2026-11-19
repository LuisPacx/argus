/**
 * The Radar page's data (trend radar ticket 01): the Trends the worker found (at most 100, highest score first, each with at most 50 lookalikes),
 * each source's state and the banners due. Read only: it writes nothing, and it returns exactly these fields (no raw reading, no trace JSON). Every
 * term, headline and token name is third-party text: the worker stored it cleaned and cut, and the page renders it as text.
 */
type Token = { name: string; symbol: string; url: string; marketCapUsd: number | null; liquidityUsd: number };
const token = (t: Token) => ({ name: t.name, symbol: t.symbol, url: t.url, marketCapUsd: t.marketCapUsd, liquidityUsd: t.liquidityUsd });

export default defineEventHandler(() => {
  const view = useStore().radarView(new Date());
  return {
    enabled: process.env.ARGUS_RADAR === "1",
    trends: view.trends.map((t) => ({
      id: t.id,
      term: t.term,
      firstSeen: t.firstSeen,
      lastSeen: t.lastSeen,
      score: t.score,
      side: t.side,
      sideAt: t.sideAt,
      trafficText: t.trafficText,
      trafficMin: t.trafficMin,
      newsTitle: t.newsTitle,
      newsUrl: t.newsUrl,
      lastChecked: t.lastChecked,
      localCreates: t.localCreates,
      localCreators: t.localCreators,
      traceAt: t.traceAt,
      liveCount: t.liveCount,
      biggest: t.biggest ? token(t.biggest) : null,
      lookalikes: t.lookalikes.map((l) => ({ ...token(l), reason: l.reason })),
      lookalikeCount: t.lookalikeCount,
    })),
    sources: view.sources.map((s) => ({ source: s.source, status: s.status, reason: s.reason, lastOk: s.lastOk, since: s.since })),
    alerts: view.alerts.map((a) => ({ source: a.source, status: a.status, reason: a.reason, since: a.since, lastOk: a.lastOk })),
    lastGoodPollAt: view.lastGoodPollAt,
    counts: { shown: view.counts.shown, untokenized: view.counts.untokenized },
  };
});
