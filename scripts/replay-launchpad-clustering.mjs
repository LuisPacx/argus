#!/usr/bin/env node
// Replays the Narrative clustering (viral sources ticket 01) over every Signal of a COPY of the database, in published order, with the real
// semantic model, into a THROWAWAY datastore, and prints the numbers the ticket asks for. Opt-in; not part of `pnpm check`.
//
// Usage: sqlite3 .data/argus.db ".backup <home-disk path>/copy.db"     (make the copy first; this never opens the live file)
//        node scripts/replay-launchpad-clustering.mjs <copy.db> [--work <dir>] [--chunk 400] [--json out.json] [--map signal-to-narrative.json]
//   --work   where the throwaway datastore goes (default ~/.cache/argus-scratch/viral01/replay); must be new or empty and under ~/.cache or the
//            temp dir (the script deletes nothing); left for inspection. Its <work>/replay.db feeds scripts/simulate-judge-load.mjs.
//   --chunk  Signals per clustering pass (the worker clusters whatever arrived in the last 5 minutes; 400 is about that at 14k creates a day)
//   --map    writes each Signal's Narrative id, to compare this replay with one of the same copy under other code
// The copy is only read (read-only handle). Delete the copy and the work directory afterwards. The model must already be in ~/.cache/argus/models.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isLiveDb } from './live-db-guard.mjs';
import { workDirRefusal } from './replay-work-guard.mjs';
import { Datastore } from '../packages/core/src/datastore.ts';
import { clusterNewSignals } from '../packages/core/src/narratives.ts';
import { CREATE_TITLE_PREFIX } from '../packages/core/src/sources/pumpportal.ts';
import { loadSemanticEmbedder, modelCacheDir } from '../apps/worker/src/semantic-embedder.ts';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
if (positional.length < 1) {
  console.error('usage: node scripts/replay-launchpad-clustering.mjs <copy.db> [--work <dir>] [--chunk 400] [--json out.json] [--map signal-to-narrative.json]');
  process.exit(2);
}
const copyPath = path.resolve(positional[0]);
if (isLiveDb(copyPath, [path.resolve(import.meta.dirname, '../.data/argus.db'), process.env.ARGUS_DB])) {
  console.error('refusing to open the live database; make a .backup copy first');
  process.exit(2);
}
const work = path.resolve(flag('work', path.join(homedir(), '.cache', 'argus-scratch', 'viral01', 'replay')));
const refusal = workDirRefusal(work, [path.join(homedir(), '.cache'), tmpdir()]);
if (refusal) {
  console.error(refusal);
  process.exit(2);
}
const chunk = Number(flag('chunk', '400'));
const jsonOut = flag('json', undefined);
const mapOut = flag('map', undefined);

mkdirSync(work, { recursive: true });
const replayPath = path.join(work, 'replay.db');

const copy = new DatabaseSync(copyPath, { readOnly: true });
const signals = copy
  .prepare('SELECT id, source_id AS sourceId, source_label AS sourceLabel, title, summary, url, published_at AS publishedAt FROM signals ORDER BY published_at, id')
  .all();
const studyTokens = copy.prepare("SELECT mint, name, symbol, first_seen_at AS at FROM study_tokens WHERE name <> '' OR symbol <> ''").all();
const live = copy.prepare('SELECT id, narrative_id AS narrativeId FROM signals').all();
console.log(`copy: ${signals.length} Signals, ${studyTokens.length} Study tokens with a name`);

const embedder = await loadSemanticEmbedder({ dir: modelCacheDir(process.env), allowFetch: false, log: console.log });
// The cross-Source rule trusts the model's vocabulary to tell a coined word from an ordinary one; fail loudly if that no longer holds.
for (const [word, common] of [['moon', true], ['zero', true], ['poland', true], ['misu', false], ['melania', false], ['eisenkot', false]]) {
  if (embedder.isCommonWord(word) !== common) throw new Error(`isCommonWord(${word}) should be ${common}`);
}
// The Study's rows give a bond whose create predates the Signals its name. One transaction, straight into the throwaway file once migrated.
Datastore.open(replayPath).close();
const seed = new DatabaseSync(replayPath);
seed.exec('BEGIN');
const insertToken = seed.prepare("INSERT OR IGNORE INTO study_tokens (mint, status, name, symbol, first_seen_at) VALUES (?, 'pending', ?, ?, ?)");
for (const t of studyTokens) insertToken.run(t.mint, t.name, t.symbol, t.at);
seed.exec('COMMIT');
seed.close();
const store = Datastore.open(replayPath);

const t0 = performance.now();
let embedMs = 0;
const timed = { ...embedder, embed: async (s) => { const a = performance.now(); const v = await embedder.embed(s); embedMs += performance.now() - a; return v; } };
let passes = 0;
for (let i = 0; i < signals.length; i += chunk) {
  const slice = signals.slice(i, i + chunk);
  const last = new Date(Math.max(...slice.map((s) => Date.parse(s.publishedAt))) + 1);
  store.recordSignals(slice, last);
  await clusterNewSignals(store, timed, { now: last, config: { batchSize: chunk + 10 } });
  passes++;
}
const wall = performance.now() - t0;
store.close();
console.log(`replayed ${signals.length} Signals in ${passes} passes: ${(wall / 1000).toFixed(1)} s wall, ${(embedMs / 1000).toFixed(1)} s of it embedding the non-launchpad ones`);

const db = new DatabaseSync(replayPath, { readOnly: true });
const LP = "s.source_id = 'pumpportal:events'";
const report = {};

// Narratives overall.
const totals = db.prepare(`SELECT COUNT(*) AS narratives, SUM(kind = 'launchpad') AS launchpad, SUM(kind = 'news') AS news FROM narratives`).get();
console.log(`\n== Narratives: ${totals.narratives} (${totals.launchpad} launchpad, ${totals.news} news)`);

// (b) the largest Narrative and the share of launchpad Signals in the top 3.
const lpTotal = db.prepare(`SELECT COUNT(*) AS n FROM signals s WHERE ${LP}`).get().n;
const top = db
  .prepare(`SELECT n.id, n.title, n.signal_count AS size, n.kind, (SELECT COUNT(*) FROM signals s WHERE s.narrative_id = n.id AND ${LP}) AS lp FROM narratives n ORDER BY lp DESC, n.id LIMIT 60`)
  .all();
const top3 = top.slice(0, 3).reduce((s, r) => s + r.lp, 0);
console.log(`\n== (b) launchpad Signals: ${lpTotal}. Largest Narrative: ${top[0].size} Signals (${top[0].title}). Top 3 hold ${top3} = ${((100 * top3) / lpTotal).toFixed(1)}% (before: 99.9%)`);
report.b = { lpTotal, largest: top[0].size, top3, top3Share: top3 / lpTotal };

// (c) Narratives with 2 or more launchpad Signals, per day: the day the second Signal arrived (when it became eligible for a judge run).
const perDay = db
  .prepare(
    `WITH ranked AS (
       SELECT s.narrative_id AS nid, s.published_at AS at, ROW_NUMBER() OVER (PARTITION BY s.narrative_id ORDER BY s.published_at, s.id) AS rn
       FROM signals s WHERE ${LP}),
     reach AS (SELECT nid, rn, substr(at, 1, 10) AS day FROM ranked WHERE rn IN (1, 2, 3, 5, 10, 20))
     SELECT day, SUM(rn = 1) AS created, SUM(rn = 2) AS reached2, SUM(rn = 3) AS reached3, SUM(rn = 5) AS reached5, SUM(rn = 10) AS reached10, SUM(rn = 20) AS reached20
     FROM reach GROUP BY day ORDER BY day`,
  )
  .all();
console.log('\n== (c) launchpad Narratives per day: created, and reaching 2 / 3 / 5 / 10 / 20 launchpad Signals (a Narrative needs 2 to be judged)');
for (const r of perDay) console.log(`${r.day}  created ${String(r.created).padStart(5)}  >=2 ${String(r.reached2).padStart(5)}  >=3 ${String(r.reached3).padStart(5)}  >=5 ${String(r.reached5).padStart(5)}  >=10 ${String(r.reached10).padStart(4)}  >=20 ${String(r.reached20).padStart(4)}`);
report.c = perDay;

// (d) the 60 largest.
console.log('\n== (d) the 60 largest launchpad Narratives (id, launchpad Signals, title | distinct names | a few of them)');
const nameOf = (title) => (title.startsWith(CREATE_TITLE_PREFIX) ? title.slice(CREATE_TITLE_PREFIX.length) : title);
for (const r of top) {
  const names = db.prepare(`SELECT title, COUNT(*) AS n FROM signals s WHERE s.narrative_id = ? AND ${LP} GROUP BY title ORDER BY n DESC LIMIT 6`).all(r.id);
  const distinct = db.prepare(`SELECT COUNT(DISTINCT title) AS n FROM signals s WHERE s.narrative_id = ? AND ${LP}`).get(r.id).n;
  console.log(`${String(r.id).padStart(6)} ${String(r.lp).padStart(5)} ${r.title.slice(0, 50).padEnd(50)} | ${String(distinct).padStart(3)} names | ${names.map((n) => `${nameOf(n.title).slice(0, 28)}:${n.n}`).join(' ; ')}`);
}
report.d = top;

// (a) Misu: the 9 creates and the bond.
const misu = db
  .prepare(`SELECT s.id, s.title, s.narrative_id AS nid FROM signals s WHERE ${LP} AND (s.title LIKE '%米苏%' OR lower(s.title) LIKE '%misu%' OR s.id = 'pumpportal:events:migrate:9oD9pi7KfiXKGt3zq6w65HpwbCdax5KcpEZZQE5ipump')`)
  .all();
const misuNarratives = [...new Set(misu.map((m) => m.nid))];
console.log(`\n== (a) Misu: ${misu.length} Signals (creates and bond) in ${misuNarratives.length} Narrative(s): ${misuNarratives.join(', ')}`);
for (const nid of misuNarratives) {
  const members = db.prepare('SELECT s.id, s.title, s.source_id AS src FROM signals s WHERE s.narrative_id = ?').all(nid);
  const foreign = members.filter((m) => !/米苏|misu/i.test(m.title) && m.id !== 'pumpportal:events:migrate:9oD9pi7KfiXKGt3zq6w65HpwbCdax5KcpEZZQE5ipump');
  console.log(`  Narrative ${nid}: ${members.length} Signals, ${foreign.length} that are not Misu${foreign.length ? ': ' + foreign.slice(0, 5).map((f) => f.title.slice(0, 60)).join(' | ') : ''}`);
}
report.a = { signals: misu.length, narratives: misuNarratives };

// NVIDIA 11-12: Jensen / Nvidia launches.
const NVIDIA = /nvidia|nvda|jensen|huang|kress|nvidi/i;
const nv = db.prepare(`SELECT s.id, s.title, s.published_at AS at, s.narrative_id AS nid FROM signals s WHERE ${LP} AND s.id LIKE '%:create:%'`).all().filter((r) => NVIDIA.test(r.title));
const byN = new Map();
for (const r of nv) byN.set(r.nid, (byN.get(r.nid) ?? 0) + 1);
const sizeOf = new Map(db.prepare('SELECT id, signal_count AS size, title, kind FROM narratives').all().map((n) => [n.id, n]));
const largestId = top[0].id;
const nv1112 = nv.filter((r) => r.at.startsWith('2026-11-12'));
console.log(`\n== NVIDIA/Jensen: ${nv.length} launchpad creates match (nvidia|nvda|jensen|huang|kress|nvidi); ${nv1112.length} of them on 2026-11-12`);
console.log(`   in the largest Narrative (${largestId}, ${sizeOf.get(largestId).size} Signals): ${byN.get(largestId) ?? 0}; in Narratives of one Signal: ${[...byN].filter(([id]) => sizeOf.get(id).size === 1).length}; in Narratives of 2 or more: ${[...byN].filter(([id]) => sizeOf.get(id).size >= 2).reduce((s, [, n]) => s + n, 0)}`);
console.log('   Narratives that hold them (id, matching creates / Narrative size, title):');
for (const [id, n] of [...byN].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`   ${String(id).padStart(6)}  ${String(n).padStart(4)} / ${String(sizeOf.get(id).size).padStart(4)}  ${sizeOf.get(id).title.slice(0, 70)}`);
const mintRow = db.prepare("SELECT narrative_id AS nid FROM signals WHERE id = 'pumpportal:events:create:dS222UNvAHpALEuFtK26bfM6Sganp1TZfFVQEiEpump'").get();
if (mintRow) console.log(`   the mint dS222UNv... (NVIDIHIA) is in Narrative ${mintRow.nid} (${sizeOf.get(mintRow.nid).size} Signals): ${sizeOf.get(mintRow.nid).title}`);
report.nvidia = { matches: nv.length, on1112: nv1112.length, inLargest: byN.get(largestId) ?? 0, narratives: [...byN].map(([id, n]) => ({ id, n, size: sizeOf.get(id).size, title: sizeOf.get(id).title })) };

// News unchanged: the live Narrative of each non-launchpad Signal against the replay's.
const liveOf = new Map(live.map((r) => [r.id, r.narrativeId]));
const replayOf = new Map(db.prepare('SELECT id, narrative_id AS nid FROM signals').all().map((r) => [r.id, r.nid]));
const newsIds = signals.filter((s) => s.sourceId !== 'pumpportal:events').map((s) => s.id);
const liveGroups = new Map();
for (const id of newsIds) {
  const g = liveOf.get(id);
  if (g == null) continue;
  (liveGroups.get(g) ?? liveGroups.set(g, []).get(g)).push(id);
}
const replayNewsGroups = new Map();
for (const id of newsIds) {
  const g = replayOf.get(id);
  (replayNewsGroups.get(g) ?? replayNewsGroups.set(g, []).get(g)).push(id);
}
const sig = (ids) => [...ids].sort().join('|');
const replaySets = new Set([...replayNewsGroups.values()].map(sig));
let multi = 0;
let same = 0;
const different = [];
for (const [g, ids] of liveGroups) {
  if (ids.length < 2) continue;
  multi++;
  if (replaySets.has(sig(ids))) same++;
  else different.push({ live: g, size: ids.length });
}
console.log(`\n== news: ${newsIds.length} non-launchpad Signals. Live Narratives with 2 or more of them: ${multi}; the replay forms exactly the same group for ${same} (${((100 * same) / multi).toFixed(1)}%)`);
for (const id of [485, 662]) {
  const ids = liveGroups.get(id) ?? [];
  const inReplay = [...new Set(ids.map((x) => replayOf.get(x)))];
  const sets = inReplay.map((g) => replayNewsGroups.get(g)?.length);
  console.log(`   live Narrative ${id}: ${ids.length} non-launchpad Signals -> replay Narrative(s) ${inReplay.join(', ')} (non-launchpad members ${sets.join(', ')}); identical set: ${replaySets.has(sig(ids))}`);
}
report.news = { total: newsIds.length, liveGroups: multi, same, different: different.slice(0, 20) };

// Cross-Source joins: non-launchpad Signals now inside a launchpad Narrative.
const cross = db
  .prepare(`SELECT s.id, s.source_id AS src, s.title, n.id AS nid, n.title AS ntitle, n.signal_count AS size FROM signals s JOIN narratives n ON n.id = s.narrative_id WHERE NOT ${LP} AND n.kind = 'launchpad' ORDER BY s.published_at`)
  .all();
console.log(`\n== cross-Source: ${cross.length} non-launchpad Signals joined a launchpad Narrative (${cross.filter((c) => c.src === 'dexscreener:trending').length} DexScreener, ${cross.filter((c) => c.src !== 'dexscreener:trending').length} headlines)`);
for (const c of cross) console.log(`   [${c.src}] ${c.title.slice(0, 80)}  ->  ${c.nid} (${c.size}) ${c.ntitle.slice(0, 40)}`);
report.cross = cross;

if (jsonOut) writeFileSync(path.resolve(jsonOut), JSON.stringify(report, null, 1));
// Every Signal's Narrative in the replay, for comparing two replays (the same Signals, before and after a change).
if (mapOut) writeFileSync(path.resolve(mapOut), JSON.stringify(Object.fromEntries(db.prepare('SELECT id, narrative_id AS n FROM signals').all().map((r) => [r.id, r.n]))));
db.close();
copy.close();
