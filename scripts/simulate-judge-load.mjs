#!/usr/bin/env node
// Simulates the judge over a REPLAYED datastore (the replay.db that scripts/replay-launchpad-clustering.mjs leaves in its --work
// directory; never the live DB) to size the per-kind minimum Signals (viral sources ticket 01): how many judge runs a day each
// launchpad minimum asks for, and who gets served under the 24 h run cap.
//
// Usage: node scripts/simulate-judge-load.mjs <replay.db> [--lp-mins 2,5,8,10,15] [--news-min 2] [--cap 300] [--per-pass 10] [--days 2026-11-07,2026-11-12]
//
// The model: a 30-minute tick. A Narrative is a candidate when it holds a market Signal, has not been scored since it last changed
// materially (a Signal from a new Source, or the Signal count doubling since the last material change: `isMaterialJoin`), gained a Signal
// within 72 h and holds at least its kind's minimum. Each tick judges up to `per-pass` candidates, in the order under test, until the
// rolling-24 h run count reaches the cap. A judged Narrative is Scored at once (no failures, no retries). "Demand" is the same run
// without any cap: the runs a day that the minimums ask for.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const dbPath = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
if (!dbPath) {
  console.error('usage: node scripts/simulate-judge-load.mjs <replay.db> [--lp-mins 2,5,8,10,15] [--news-min 2] [--cap 300] [--per-pass 10] [--days a,b]');
  process.exit(2);
}
if (/[\\/]\.data[\\/]argus\.db/.test(path.resolve(dbPath))) {
  console.error('refusing the live database; give a replay.db');
  process.exit(2);
}
const lpMins = flag('lp-mins', '2,5,8,10,15').split(',').map(Number);
const newsMin = Number(flag('news-min', '2'));
const cap = Number(flag('cap', '300'));
const perPass = Number(flag('per-pass', '10'));
const [dayFrom, dayTo] = flag('days', '2026-11-07,2026-11-12').split(',');
const MARKET = new Set(['pumpportal:events', 'dexscreener:trending']);
const TICK = 30 * 60_000;
const DAY = 24 * 3_600_000;
const WINDOW = 72 * 3_600_000;

const db = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
const kindOf = new Map(db.prepare('SELECT id, kind FROM narratives').all().map((r) => [r.id, r.kind]));
const events = db
  .prepare('SELECT narrative_id AS nid, source_id AS src, published_at AS at FROM signals WHERE narrative_id IS NOT NULL ORDER BY published_at, id')
  .all()
  .map((r) => ({ nid: r.nid, src: r.src, t: Date.parse(r.at) }));
db.close();
const t0 = Math.floor(events[0].t / TICK) * TICK;
const tEnd = events[events.length - 1].t + TICK;

/** order: 'size' = signal_count DESC (today's), 'news-first' = news kind first, then signal_count DESC. */
function simulate({ lpMin, order, capRuns, passMax }) {
  const st = new Map();
  const pending = new Set();
  const judged = []; // { t, nid, kind }
  let recent = 0; // judged within the last 24 h: index of the oldest still counted
  let ei = 0;
  const minOf = (kind) => (kind === 'launchpad' ? lpMin : newsMin);
  const starved = { news: 0, launchpad: 0 };
  const eligibleEver = { news: new Set(), launchpad: new Set() };
  for (let T = t0; T <= tEnd; T += TICK) {
    for (; ei < events.length && events[ei].t <= T; ei++) {
      const e = events[ei];
      let s = st.get(e.nid);
      if (!s) {
        s = { kind: kindOf.get(e.nid) ?? 'news', count: 1, mat: 1, sources: new Set([e.src]), market: false, dirty: true, last: e.t };
        st.set(e.nid, s);
      } else {
        s.count++;
        s.last = e.t;
        const isNew = !s.sources.has(e.src);
        s.sources.add(e.src);
        if (isNew || s.count >= 2 * s.mat) {
          s.mat = s.count;
          s.dirty = true;
        }
      }
      if (MARKET.has(e.src)) s.market = true;
      if (s.dirty && s.market) pending.add(e.nid);
    }
    const candidates = [];
    for (const nid of pending) {
      const s = st.get(nid);
      if (s.last < T - WINDOW) {
        // Left the 72 h window without a run: starved if it had reached its minimum.
        if (s.count >= minOf(s.kind)) starved[s.kind]++;
        pending.delete(nid);
        continue;
      }
      if (s.count >= minOf(s.kind)) {
        candidates.push(nid);
        eligibleEver[s.kind].add(nid);
      }
    }
    candidates.sort((a, b) => {
      const sa = st.get(a);
      const sb = st.get(b);
      if (order === 'news-first' && sa.kind !== sb.kind) return sa.kind === 'news' ? -1 : 1;
      return sb.count - sa.count || a - b;
    });
    while (recent < judged.length && judged[recent].t < T - DAY) recent++;
    const room = Math.min(passMax, capRuns - (judged.length - recent));
    for (const nid of candidates.slice(0, Math.max(0, room))) {
      const s = st.get(nid);
      s.dirty = false;
      pending.delete(nid);
      judged.push({ t: T, nid, kind: s.kind });
    }
  }
  return { judged, starved, eligibleEver };
}

const days = [];
for (let d = Date.parse(`${dayFrom}T00:00:00Z`); d <= Date.parse(`${dayTo}T00:00:00Z`); d += DAY) days.push(new Date(d).toISOString().slice(0, 10));
const perDay = (judged, kind) => days.map((d) => judged.filter((j) => j.t >= Date.parse(`${d}T00:00:00Z`) && j.t < Date.parse(`${d}T00:00:00Z`) + DAY && (!kind || j.kind === kind)).length);
const fmt = (a) => a.map((n) => String(n).padStart(5)).join('');
console.log(`days ${days.join(' ')} (complete days only; the replay's first and last days are partial)`);
console.log(`news minimum ${newsMin}, cap ${cap} runs / rolling 24 h, ${perPass} per 30-minute pass\n`);

console.log('== Demand: judge runs a day each minimum asks for (no cap). total = news + launchpad');
console.log(`${'launchpad min'.padEnd(14)}${'total'.padEnd(5 * days.length + 4)}${'news'.padEnd(5 * days.length + 4)}launchpad`);
for (const lpMin of [newsMin, ...lpMins.filter((m) => m !== newsMin)]) {
  const { judged } = simulate({ lpMin, order: 'size', capRuns: Infinity, passMax: Infinity });
  console.log(`${String(lpMin).padEnd(14)}${fmt(perDay(judged)).padEnd(5 * days.length + 4)}${fmt(perDay(judged, 'news')).padEnd(5 * days.length + 4)}${fmt(perDay(judged, 'launchpad'))}`);
}

console.log(`\n== Served under the cap (${cap}/24 h, ${perPass} a pass). Over the full window: judged, news judged, news that reached the minimum, news left the 72 h window unjudged (starved)`);
console.log(`${'launchpad min'.padEnd(14)}${'order'.padEnd(11)}${'judged'.padStart(7)}${'news'.padStart(6)}${'newsElig'.padStart(9)}${'newsStarved'.padStart(12)}${'lp'.padStart(7)}${'lpElig'.padStart(8)}${'lpStarved'.padStart(10)}  max/day  runs per day`);
for (const lpMin of [newsMin, ...lpMins.filter((m) => m !== newsMin)]) {
  for (const order of ['size', 'news-first']) {
    const r = simulate({ lpMin, order, capRuns: cap, passMax: perPass });
    const total = perDay(r.judged);
    const news = r.judged.filter((j) => j.kind === 'news').length;
    const lp = r.judged.length - news;
    console.log(
      `${String(lpMin).padEnd(14)}${order.padEnd(11)}${String(r.judged.length).padStart(7)}${String(news).padStart(6)}${String(r.eligibleEver.news.size).padStart(9)}${String(r.starved.news).padStart(12)}${String(lp).padStart(7)}${String(r.eligibleEver.launchpad.size).padStart(8)}${String(r.starved.launchpad).padStart(10)}  ${String(Math.max(...total)).padStart(7)}  ${fmt(total)}`,
    );
  }
}
