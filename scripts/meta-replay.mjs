#!/usr/bin/env node
// Replays the Meta ranking (viral sources ticket 03) on a COPY of the database, as of a past time, and prints the top 20.
// Opt-in; not part of `pnpm check`. Market cap is looked up only with --dex (a live DexScreener call, within the configured budget);
// without it the replay runs on counts alone.
//
// --topdown (meta redesign ticket 05, ADR 0015) also reads the two live trending lists once (at most ARGUS_META_TOPDOWN_CALLS requests),
// prints every candidate with its figures, sources, ranks and the reason a dropped one was dropped, and uses that answer as the tick's
// top-down read, so the leaders are the ones the live tick would find. Use it with --dex: DexScreener verifies the survivors.
//
// --group (meta redesign ticket 06, ADR 0015) runs the AI grouping step ONCE for real: it needs --dex and --topdown, spends a few cents of the real
// Brain (one `meta-group` run, a haiku call of at most $0.05), and is an explicit opt-in (never in `pnpm check`). It prints the rules-only result
// first (the same tick with no step), then the items the model was shown, its raw answer, the validated subjects and the AI result beside it. The
// run is stored in the copy's `brain_runs`, whose row it prints. Without --group the replay is rules only (`namedBy rules`).
//
// Usage: sqlite3 .data/argus.db ".backup <home-disk path>"        (make the copy first; argus code never opens the live file)
//        node scripts/meta-replay.mjs <copy.db> [as-of ISO time, default now] [--dex] [--topdown] [--group]
// The copy is opened with Datastore.open, so it is also migrated (additively): that is the migration rehearsal. Delete the copy afterwards.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCodeBrain } from '../packages/core/src/brain.ts';
import { Datastore } from '../packages/core/src/datastore.ts';
import { recomputeMetas } from '../packages/core/src/meta/compute.ts';
import { metaConfigFromEnv } from '../packages/core/src/meta/config.ts';
import { createGroupStep } from '../packages/core/src/meta/group-pass.ts';
import { createTopDownReader } from '../packages/core/src/meta/topdown-source.ts';
import { DexScreenerClient } from '../packages/core/src/sources/dexscreener.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const useDex = process.argv.includes('--dex');
const useTopDown = process.argv.includes('--topdown');
const useGroup = process.argv.includes('--group');
if (args.length < 1) {
  console.error('usage: node scripts/meta-replay.mjs <copy.db> [as-of ISO time] [--dex] [--topdown] [--group]');
  process.exit(2);
}
if (useGroup && !(useDex && useTopDown)) {
  console.error('--group needs --dex and --topdown: the model is shown the trending tokens that passed the filter, verified on DexScreener');
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
const config = metaConfigFromEnv(process.env);
const money = (n) => (n === undefined ? '-' : `$${Math.round(n).toLocaleString('en-US')}`);

// The live top-down read, once. The tick below reuses this answer instead of asking the lists again.
let topDown;
if (useTopDown) {
  const read = await createTopDownReader({ config, ...(process.env.ARGUS_JUPITER_URL ? { jupiterUrl: process.env.ARGUS_JUPITER_URL } : {}), ...(process.env.ARGUS_GECKOTERMINAL_URL ? { geckoUrl: process.env.ARGUS_GECKOTERMINAL_URL } : {}), log: console.error })();
  topDown = async () => read;
  const ranks = (c) => Object.entries(c.ranks).map(([k, v]) => `${k === 'jupiter' ? 'jup' : 'gt'}#${v}`).join(' ');
  console.log(`== top-down: ${read.requests} request(s) of ${config.topDownCalls} allowed, ${read.candidates.length} kept, ${read.dropped.length} dropped${read.errors.length ? `, FAILED: ${read.errors.join('; ')}` : ''}`);
  for (const c of read.candidates) console.log(`kept     ${(c.symbol || '-').padEnd(12)} ${c.mint}  cap ${money(c.marketCapUsd).padEnd(14)} liq ${money(c.liquidityUsd).padEnd(12)} vol24h ${money(c.volume24hUsd).padEnd(12)} [${c.sources.join('+')}] ${ranks(c)}  ${JSON.stringify(c.name)}`);
  for (const c of read.dropped) console.log(`dropped  ${(c.symbol || '-').padEnd(12)} ${c.mint}  cap ${money(c.marketCapUsd).padEnd(14)} liq ${money(c.liquidityUsd).padEnd(12)} vol24h ${money(c.volume24hUsd).padEnd(12)} [${c.sources.join('+')}] ${ranks(c)}  ${JSON.stringify(c.name)}  => ${c.reason}`);
  console.log('');
}

const cpu0 = process.cpuUsage();
const wall0 = performance.now();
const result = await recomputeMetas(store, { now: asOf, config, ...(useDex ? { dex: new DexScreenerClient() } : {}), ...(topDown ? { topDown } : {}), log: console.error });
const cpu = process.cpuUsage(cpu0);
console.log(`as of ${asOf.toISOString()}: ${result.tokensRead} tokens read, ${result.groups} groups, ${result.dexCalls} DexScreener calls (${result.dexFailures} failed)`);
console.log(`recompute: ${((cpu.user + cpu.system) / 1000).toFixed(0)} ms CPU, ${(performance.now() - wall0).toFixed(0)} ms wall (includes the insert)`);
if (useTopDown) {
  console.log(`\n== candidates as stored for this run (kept ones: DexScreener's verification)`);
  for (const c of store.meta.candidates(result.runId)) console.log(`${c.verified === true ? 'verified' : c.verified === false ? 'FAILED  ' : 'not asked'}  ${(c.symbol || '-').padEnd(12)} ${c.mint}  ${c.reason ?? ''}`);
}

// Market-led Metas (ADR 0014): the Metas and Watching subjects of a run, with their leaders, who named them (ADR 0015) and the themes merged under the name.
function printSubjects(title, run, current) {
  console.log(`\n== ${title}: Metas (${run.metas}) and Watching (${run.watching}); ${run.leaderCalls} of the ${run.dexCalls} DexScreener calls looked up leaders`);
  for (const [kind, list] of [['Meta', current.metas], ['Watching', current.watching]]) {
    for (const m of list) {
      console.log(`${kind.padEnd(8)} ${JSON.stringify(m.label)} [${m.key}] named by ${m.namedBy}  leader ${m.leader.symbol} ${m.leader.mint}  ${money(m.leader.marketCapUsd)} (${m.leader.source}${m.leader.stale ? ', stale' : ''}${m.holding ? ', holding' : ''})  creators 24h ${m.counts['24h'].creators}, tokens 24h ${m.counts['24h'].tokens}`);
      for (const t of m.themes ?? []) console.log(`           theme ${JSON.stringify(t.label)} [${t.key}]  ${t.tokens} tokens, ${t.creators} creators`);
    }
  }
  if (current.metas.length === 0) console.log('No Meta right now.');
}
const current = store.currentMetas();
printSubjects(useGroup ? 'rules only (no grouping step)' : 'rules only', result, current);

// The AI grouping step, once, through the production Brain (an explicit opt-in: a few cents).
if (useGroup) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const brain = new ClaudeCodeBrain({ skillsDir: path.join(repoRoot, '.claude', 'skills') });
  const step = createGroupStep(store, brain, { log: console.log });
  let items = [];
  let answer;
  const group = async (input) => {
    items = input.items;
    answer = await step(input);
    return answer;
  };
  const withAi = await recomputeMetas(store, { now: asOf, config, dex: new DexScreenerClient(), topDown, group, log: console.error });
  console.log(`\n== the items the model was shown (${items.length}): ids only, never mints`);
  for (const i of items) {
    console.log(i.kind === 'token' ? `${i.id.padEnd(4)} token ${JSON.stringify(i.name)} ${JSON.stringify(i.symbol)} cap ${money(i.marketCapUsd)} lists ${i.lists.join('+')}  (${i.mint})` : `${i.id.padEnd(4)} theme [${i.key}] ${i.tokens} tokens, ${i.creators} creators, names ${JSON.stringify(i.names.slice(0, 4))}`);
  }
  console.log(`\n== the model's raw answer`);
  console.log(answer?.raw ?? '(none: the tick used rules)');
  console.log(`\n== the validated subjects (${answer?.subjects.length ?? 0}), the cost ${answer ? `$${answer.costUsd.toFixed(4)}` : 'n/a'}`);
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const s of answer?.subjects ?? []) console.log(`${JSON.stringify(s.name)}: ${s.items.map((id) => { const i = byId.get(id); return `${id}=${i.kind === 'token' ? i.symbol || i.name : i.key}`; }).join(', ')}`);
  const run = store.brainRunsFor(0).filter((r) => r.task === 'meta-group').at(-1);
  console.log(`\n== the brain_runs row\n${JSON.stringify(run)}`);
  printSubjects('with the grouping step', withAi, store.currentMetas());
}
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
