#!/usr/bin/env node
// Opt-in measurement for Rubric v3 (missed ideas ticket 04); NOT part of `pnpm check`. Spends real Claude calls (judge routing, its
// per-run budget cap), so it does so only with --run, and only when the Operator asks.
// Re-judges Narrative 662, Narrative 485 and 20 other Narratives (the newest with a Score and at least 2 Signals) from a COPY of the
// database under the latest Rubric (v3), and prints the stored legitimacy and total next to the new ones. Nothing is written: the copy
// is opened with Datastore.open (so it is migrated to v3 additively, which is the migration rehearsal) and only read; the Brain run
// is called directly and records no brain_runs row.
//
// Usage: sqlite3 .data/argus.db ".backup /home/unknown/.cache/argus-scratch/rubric-v3.db"   (make the copy first; never open the live file)
//        node scripts/rubric-v3-replay.mjs <copy.db>              (dry by default: prints the plan and one prompt, spawns nothing)
//        node scripts/rubric-v3-replay.mjs <copy.db> --run        (spends real Claude; only with an explicit --run)
// Paste the table into the ticket's Comments, then delete the copy.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ClaudeCodeBrain } from '../packages/core/src/brain.ts';
import { Datastore } from '../packages/core/src/datastore.ts';
import { judgePromptFor, parseJudgeOutput, weightedTotal } from '../packages/core/src/judge.ts';
import { isLiveDb } from './live-db-guard.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// Dry by default: real Claude is spent only with an explicit --run. (--dry is kept as a no-op alias.)
const dry = !process.argv.includes('--run');
if (args.length < 1) {
  console.error('usage: node scripts/rubric-v3-replay.mjs <copy.db> [--run]   (without --run: dry, spawns nothing)');
  process.exit(2);
}
const dbPath = path.resolve(args[0]);
if (isLiveDb(dbPath, [path.resolve(import.meta.dirname, '../.data/argus.db'), process.env.ARGUS_DB])) {
  console.error('refusing to open the live database; make a .backup copy first');
  process.exit(2);
}

const store = Datastore.open(dbPath);
const rubric = store.getRubric();
const raw = new DatabaseSync(dbPath, { readOnly: true });
const others = raw
  .prepare(
    `SELECT n.id FROM narratives n WHERE n.id NOT IN (485, 662) AND n.signal_count >= 2
       AND EXISTS (SELECT 1 FROM scores s WHERE s.narrative_id = n.id) ORDER BY n.id DESC LIMIT 20`,
  )
  .all()
  .map((r) => Number(r.id));
const ids = [662, 485, ...others];
console.log(`Rubric v${rubric.version}; ${ids.length} Narratives: ${ids.join(', ')}${dry ? ' (dry run)' : ''}`);

const brain = new ClaudeCodeBrain({});
console.log('id    old v  old legit  old total   new legit  new total');
for (const id of ids) {
  const narrative = store.getNarrative(id);
  if (!narrative) {
    console.log(`${String(id).padEnd(5)} not in this copy`);
    continue;
  }
  const old = store.latestScore(id);
  const prompt = judgePromptFor(rubric, narrative);
  if (dry) {
    if (id === ids[0]) console.log(`\n--- prompt for ${id} ---\n${prompt}\n---`);
    continue;
  }
  const run = await brain.run('judge', { prompt }, {});
  const parsed = parseJudgeOutput(run.output, rubric);
  const fmt = (n) => (n === undefined ? '-' : n.toFixed(2));
  console.log(
    `${String(id).padEnd(5)} v${old?.rubricVersion ?? '-'}   ${fmt(old?.scores.legitimacy).padStart(9)}  ${fmt(old?.total).padStart(9)}   ${parsed.ok ? fmt(parsed.scores.legitimacy).padStart(9) : 'invalid'.padStart(9)}  ${parsed.ok ? fmt(weightedTotal(rubric, parsed.scores)).padStart(9) : '-'}`,
  );
}
store.close();
raw.close();
