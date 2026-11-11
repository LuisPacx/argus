#!/usr/bin/env node
// Replays the Source class selection (phase 3 ticket 24) on a COPY of the database. Opt-in; not part of `pnpm check`.
// Counts Narratives by class (context-only, mixed, market-only) and checks that the judge and propose selections hold no context-only
// Narrative. The selection runs with the window opened to the epoch, so it shows eligibility, not the 72 h delta.
//
// Usage: sqlite3 .data/argus.db ".backup <home-disk path>"        (make the copy first; argus code never opens the live file)
//        node scripts/context-replay.mjs <copy.db>
// The copy is opened with Datastore.open, so it is also migrated (additively). Delete the copy afterwards.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Datastore } from '../packages/core/src/datastore.ts';
import { MARKET_SOURCE_IDS } from '../packages/core/src/sources/source-class.ts';

if (process.argv.length < 3) {
  console.error('usage: node scripts/context-replay.mjs <copy.db>');
  process.exit(2);
}
const dbPath = path.resolve(process.argv[2]);
if (/[\\/]\.data[\\/]argus\.db(-wal|-shm)?$/.test(dbPath)) {
  console.error('refusing to open the live database; make a .backup copy first');
  process.exit(2);
}

const store = Datastore.open(dbPath);
const raw = new DatabaseSync(dbPath, { readOnly: true });
const market = MARKET_SOURCE_IDS.map((id) => `'${id.replaceAll("'", "''")}'`).join(', ');
const classOf = new Map();
for (const r of raw.prepare(
  `SELECT n.id AS id, COUNT(*) AS total, SUM(CASE WHEN sg.source_id IN (${market}) THEN 1 ELSE 0 END) AS mkt
   FROM narratives n JOIN signals sg ON sg.narrative_id = n.id GROUP BY n.id`,
).all()) classOf.set(Number(r.id), r.mkt === 0 ? 'context-only' : r.mkt === r.total ? 'market-only' : 'mixed');

const tally = (ids) => {
  const t = { 'context-only': 0, mixed: 0, 'market-only': 0, other: 0 };
  for (const id of ids) t[classOf.get(id) ?? 'other']++;
  return t;
};
console.log('Narratives by class:', tally([...classOf.keys()]));

const epoch = new Date(0).toISOString();
const embedders = raw.prepare('SELECT DISTINCT embedder AS id, dimension FROM narratives').all();
const judge = new Set();
const propose = new Set();
for (const e of embedders) {
  const embedder = { id: String(e.id), dimension: Number(e.dimension) };
  for (const n of store.narrativesToJudge(embedder, epoch, 100000, Infinity, 1)) judge.add(n.id);
  for (const p of store.narrativesToPropose(embedder, epoch, 0, 100000)) propose.add(p.narrative.id);
}
console.log('narrativesToJudge (unscored, any age):', tally(judge));
console.log('narrativesToPropose (scored, no Proposal, any age):', tally(propose));
const leaked = [...judge, ...propose].filter((id) => classOf.get(id) === 'context-only').length;
console.log(leaked === 0 ? 'OK: no context-only Narrative is selected' : `FAIL: ${leaked} context-only selections`);
process.exit(leaked === 0 ? 0 : 1);
