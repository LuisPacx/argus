#!/usr/bin/env node
// Backtest of the Beta finder (viral sources ticket 04, slice 5) on a COPY of the database. Opt-in; not part of `pnpm check`.
// For each hourly time T it ranks the Metas from rows at or before T, takes the top room-left Metas, and measures whether tokens that
// then joined them (new creators, created in (T, T+H]) migrated by T+H, against the base rate and against a size ranking.
//
// Usage: sqlite3 .data/argus.db ".backup <home-disk path>"        (make the copy first; this never opens the live file)
//        node scripts/backtest-beta.mjs <copy.db> [--min-history-hours 24] [--step-minutes 60] [--top 3] [--horizons 6,24] [--min-migrations 0] [--json out.json]
// The copy is opened with Datastore.open (migrated additively) and gets one Meta run per T: delete it afterwards, and use a fresh copy per run.
// No market cap exists as of T, so the lead-cap gate is off; the other gates and the order are what is tested.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isLiveDb } from './live-db-guard.mjs';
import { Datastore } from '../packages/core/src/datastore.ts';
import { DEFAULT_BACKTEST, formatBacktest, runBacktest, summariseBacktest } from '../packages/core/src/beta/backtest.ts';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
if (positional.length < 1) {
  console.error('usage: node scripts/backtest-beta.mjs <copy.db> [--min-history-hours 24] [--step-minutes 60] [--top 3] [--horizons 6,24] [--min-migrations 0] [--json out.json]');
  process.exit(2);
}
const dbPath = path.resolve(positional[0]);
if (isLiveDb(dbPath, [path.resolve(import.meta.dirname, '../.data/argus.db'), process.env.ARGUS_DB])) {
  console.error('refusing to open the live database; make a .backup copy first');
  process.exit(2);
}
const minHistoryHours = Number(flag('min-history-hours', '24'));
const stepMinutes = Number(flag('step-minutes', '60'));
const top = Number(flag('top', '3'));
const horizonsHours = flag('horizons', '6,24').split(',').map(Number);
// 0 is the ticket's rule. A higher number is an exploratory variant (it stands in for the lead-cap gate, which has no history).
const minMigrations = Number(flag('min-migrations', '0'));
if (![minHistoryHours, stepMinutes, top, ...horizonsHours].every((n) => Number.isFinite(n) && n > 0) || !Number.isInteger(minMigrations) || minMigrations < 0) {
  console.error('every numeric option must be a positive number (--min-migrations a non-negative integer)');
  process.exit(2);
}

// The data range, read once from the copy (read-only handle) before Datastore.open migrates it.
const probe = new DatabaseSync(dbPath, { readOnly: true });
const hasRuns = probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta_runs'").get() && probe.prepare('SELECT 1 FROM meta_runs LIMIT 1').get();
if (hasRuns) {
  probe.close();
  console.error('this copy already holds Meta runs (an earlier backtest wrote them): make a fresh .backup copy');
  process.exit(2);
}
const range = probe.prepare('SELECT MIN(created_at) AS start, MAX(created_at) AS lastCreate, MAX(migrated_at) AS lastMigrate FROM study_tokens').get();
probe.close();
const dataStart = new Date(range.start);
const dataEnd = new Date(Math.max(Date.parse(range.lastCreate), Date.parse(range.lastMigrate ?? range.lastCreate)));

const HOUR = 3_600_000;
const firstMs = Math.ceil((dataStart.getTime() + minHistoryHours * HOUR) / (stepMinutes * 60_000)) * stepMinutes * 60_000;
const lastMs = dataEnd.getTime() - Math.min(...horizonsHours) * HOUR;
const times = [];
for (let t = firstMs; t <= lastMs; t += stepMinutes * 60_000) times.push(new Date(t));
if (times.length === 0) {
  console.error('the data is too short for these options');
  process.exit(1);
}

console.error(`data ${dataStart.toISOString()} to ${dataEnd.toISOString()}; ${times.length} snapshots every ${stepMinutes} min from ${times[0].toISOString()}`);
const store = Datastore.open(dbPath);
const t0 = performance.now();
const report = await runBacktest(store, { ...DEFAULT_BACKTEST, rule: { ...DEFAULT_BACKTEST.rule, minMigrations }, top, horizonsHours, times, dataEnd });
store.close();
console.error(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
const summary = summariseBacktest(report);
console.log(formatBacktest(summary));
const jsonOut = flag('json', undefined);
if (jsonOut) writeFileSync(path.resolve(jsonOut), JSON.stringify(summary, null, 1));
