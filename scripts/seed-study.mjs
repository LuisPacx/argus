#!/usr/bin/env node
// Seeds a scratch database with Study data so the War Room Study page can be checked in a browser. Never touches the live database.
// Usage: node scripts/seed-study.mjs <path-to-new-db>      (the file must not exist; refuses the live .data/argus.db)
import fs from 'node:fs';
import path from 'node:path';
import { Datastore } from '../packages/core/src/datastore.ts';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/seed-study.mjs <path-to-new-db>');
  process.exit(2);
}
const dbPath = path.resolve(target);
if (/[\\/]\.data[\\/]argus\.db$/.test(dbPath)) {
  console.error('refusing to seed the live database');
  process.exit(2);
}
if (fs.existsSync(dbPath)) {
  console.error(`${dbPath} exists already; pass a new path`);
  process.exit(2);
}

const store = Datastore.open(dbPath);
const NOW = Date.now();
const HOUR = 3_600_000;
let n = 0;
const mint = () => `Seed${String(++n).padStart(4, '0')}`.padEnd(40, 'x') + 'pump';
const create = (m, ageMs, extra = {}) => ({
  kind: 'create', mint: m, receivedAt: new Date(NOW - ageMs).toISOString(), signature: '', name: `Seed token ${n}`, symbol: `S${n}`,
  creator: 'Creator'.padEnd(44, '1'), uri: `https://ipfs.io/ipfs/seed${n}`, pool: 'pump', ...extra,
});
const site = (status, extra = {}) => ({ status, detail: '', httpStatus: 200, finalUrl: 'https://seed.example/', contentType: 'text/html', title: 'Seed', text: 'A seeded page with some words on it.', truncated: false, responseMs: 150, emptyShell: false, ...extra });
const base = { description: 'seeded', imageUrl: null, websiteUrl: 'https://seed.example/', xUrl: null, telegramUrl: null, selectionReason: 'population: website link' };

// Token ages span the last 36 hours, so the all-time and last-24h columns differ.
const age = (i) => (i % 36) * HOUR + 10 * 60_000;

const capturedMints = [];
// Captured with a website: 30 Snapshots, 6 empty app shells, a few that never got a page.
for (let i = 0; i < 30; i++) {
  const m = mint();
  const e = create(m, age(i) + 120_000);
  store.study.recordTokenEvent(e);
  const when = new Date(Date.parse(e.receivedAt) + 61_000);
  const w = i < 6 ? site('ok', { emptyShell: true, text: '' }) : i < 8 ? site('robots-disallowed', { httpStatus: null, text: '', title: '', emptyShell: null }) : i < 9 ? site('blocked', { httpStatus: null, text: '', title: '', emptyShell: null }) : i < 10 ? site('non-html', { contentType: 'application/pdf', text: '', title: '', emptyShell: null }) : site('ok');
  store.study.beginCaptureRun(m, when, 20_000);
  store.study.recordSnapshot({ mint: m, ...base, website: w }, when);
  capturedMints.push(m);
}
// Captured with an X link only.
for (let i = 0; i < 5; i++) {
  const m = mint();
  const e = create(m, age(i + 3) + 120_000);
  store.study.recordTokenEvent(e);
  const when = new Date(Date.parse(e.receivedAt) + 62_000);
  store.study.beginCaptureRun(m, when, 20_000);
  store.study.recordSnapshot({ mint: m, ...base, websiteUrl: null, xUrl: 'https://x.com/seed', selectionReason: 'population: X link', website: null }, when);
}
// Counted: no website and no X link.
for (let i = 0; i < 25; i++) {
  const m = mint();
  store.study.recordTokenEvent(create(m, age(i + 7) + 120_000));
  store.study.beginCaptureRun(m, new Date(NOW - age(i + 7)), 20_000);
  store.study.markToken(m, 'counted', 'no website or X link', { inPopulation: false });
}
// Late, capped, unreadable, pending, other launchpad.
for (const [status, reason, count] of [['late', 'reached after the window', 3], ['capped', 'the daily capture run cap was reached', 2], ['unreadable', 'metadata: HTTP 502', 2]]) {
  for (let i = 0; i < count; i++) {
    const m = mint();
    store.study.recordTokenEvent(create(m, age(i + 11) + 120_000));
    store.study.markToken(m, status, reason);
  }
}
for (let i = 0; i < 4; i++) store.study.recordTokenEvent(create(mint(), 10_000 * (i + 1)));
for (let i = 0; i < 3; i++) store.study.recordTokenEvent(create(mint(), age(i) + 60_000, { pool: 'bonk', uri: '' }));
// Migrations: some of them for tokens that were seen, and 6 whose create never was (missed).
for (const m of capturedMints.slice(0, 5)) {
  store.study.recordTokenEvent({ kind: 'migrate', mint: m, receivedAt: new Date(NOW - 5 * 60_000).toISOString(), signature: '', name: '', symbol: '', creator: '', uri: '', pool: 'pump-amm' });
}
for (let i = 0; i < 6; i++) store.study.recordTokenEvent({ kind: 'migrate', mint: mint(), receivedAt: new Date(NOW - (i + 1) * 2 * HOUR).toISOString(), signature: '', name: '', symbol: '', creator: '', uri: '', pool: 'pump-amm' });
// Gaps: a disconnect that healed and a restart.
store.study.recordConnection({ state: 'down', at: new Date(NOW - 30 * HOUR).toISOString() });
store.study.recordConnection({ state: 'up', at: new Date(NOW - 30 * HOUR + 90_000).toISOString() });
store.study.recordConnection({ state: 'down', at: new Date(NOW - 3 * HOUR).toISOString() });
store.study.recordConnection({ state: 'up', at: new Date(NOW - 3 * HOUR + 600_000).toISOString() });

console.log(JSON.stringify(store.studyStats(new Date(NOW)), null, 2));
store.close();
console.log(`seeded ${dbPath}`);
