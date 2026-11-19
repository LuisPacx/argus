/**
 * The Moments page's data (moment scanner ticket 01): the watched topic of the newest scan, how the scanner and the X session stand, and the
 * rising clips, newest reading first. Read only: it writes nothing, and it returns exactly these fields (no signal list, no raw page, no
 * counts other than views and likes). The text of a post is third-party: it is already flattened and cut by the store.
 */
export default defineEventHandler(() => {
  const view = useStore().momentsView(new Date());
  const s = view.session;
  return {
    enabled: process.env.ARGUS_MOMENTS === "1",
    topic: view.topic,
    scanner: {
      lastScanAt: view.lastScan?.at ?? null,
      lastStatus: view.lastScan?.status ?? null,
      lastReason: view.lastScan?.reason ?? "",
      lastLoads: view.lastScan?.loads ?? 0,
      lastGoodScanAt: view.lastGoodScanAt,
    },
    session: { status: s.status, reason: s.reason, stoppedAt: s.stoppedAt, resumeAt: s.resumeAt, probeDue: s.probeDue },
    posts: view.rising.map((p) => ({
      statusId: p.statusId,
      handle: p.handle,
      url: p.url,
      text: p.text,
      postedAt: p.postedAt,
      views: p.views,
      likes: p.likes,
      viewsPerHour: p.viewsPerHour,
      recentRate: p.recentRate,
      readings: p.readings,
      lastSeenAt: p.lastSeenAt,
    })),
  };
});
