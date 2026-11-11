#!/usr/bin/env node
// Replays the Meta ranking (viral sources ticket 03) on a COPY of the database, as of a past time, and prints the top 20.
// Opt-in; not part of `pnpm check`. Market cap is looked up only with --dex (a live DexScreener call, within the configured budget);
// without it the replay runs on counts alone.
//
// Usage: sqlite3 .data/argus.db ".backup <home-disk path>"        (make the copy first; argus code never opens the live file)
//        node scripts/meta-replay.mjs <copy.db> [as-of ISO time, default now] [--dex]
// The copy is opened with Datastore.open, so it is also migrated (additively): that is the migration rehearsal. Delete the copy afterwards.
import path from 'node:path';
import { Datastore } from '../packages/core/src/datastore.ts';
import { recomputeMetas } from '../packages/core/src/meta/compute.ts';
import { metaConfigFromEnv } from '../packages/core/src/meta/config.ts';
import { DexScreenerClient } from '../packages/core/src/sources/dexscreener.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const useDex = process.argv.includes('--dex');
if (args.length < 1) {
  console.error('usage: node scripts/meta-replay.mjs <copy.db> [as-of ISO time] [--dex]');
  process.exit(2);
}
const dbPath = path.resolve(args[0]);
if (/[\\/]\.data[\\/]argus\.db(-wal|-shm)?$/.test(dbPath)) {
  console.error('refusing to open the live database; make a .backup copy first');
  process.exit(2);
}
const asOf = args[1] ? new Date(args[1]) : new Date();
if (Number.isNaN(asOf.getTime())) {
  console.error(`not a time: ${args[1]}`);
  process.exit(2);
}

const store = Datastore.open(dbPath);
const cpu0 = process.cpuUsage();
const wall0 = performance.now();
const result = await recomputeMetas(store, { now: asOf, config: metaConfigFromEnv(process.env), ...(useDex ? { dex: new DexScreenerClient() } : {}), log: console.error });
const cpu = process.cpuUsage(cpu0);
console.log(`as of ${asOf.toISOString()}: ${result.tokensRead} tokens read, ${result.groups} groups, ${result.dexCalls} DexScreener calls (${result.dexFailures} failed)`);
console.log(`recompute: ${((cpu.user + cpu.system) / 1000).toFixed(0)} ms CPU, ${(performance.now() - wall0).toFixed(0)} ms wall (includes the insert)`);

const money = (n) => (n === undefined ? '-' : `$${Math.round(n).toLocaleString('en-US')}`);
for (const window of ['24h', '6h']) {
  const run = store.latestMetas(window, 20);
  console.log(`\n== ${window} window: base migration rate ${run.baseMigrationRate === null ? 'n/a' : (run.baseMigrationRate * 100).toFixed(1) + '%'} (${run.windowMigrations}/${run.windowTokens}, unfiltered)`);
  console.log('rank  tokens creators migr(>60s)  cr/migr  mcap        label');
  for (const r of run.rows) {
    const c = r.counts[window];
    console.log(
      `${String(r.rank).padStart(4)}  ${String(c.tokens).padStart(6)} ${String(c.creators).padStart(8)} ${String(c.migrations).padStart(4)}(${String(c.migrationsAfter60s).padStart(3)})  ${(r.createsPerMigration === null ? '-' : r.createsPerMigration.toFixed(1)).padStart(7)}  ${money(r.marketCapUsd).padEnd(10)}  ${JSON.stringify(r.label)}  [${r.key}]  top: ${r.topTokens.map((t) => `${t.symbol}`).join(', ')}`,
    );
  }
}
store.close();
