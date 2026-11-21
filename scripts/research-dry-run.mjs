#!/usr/bin/env node
// Prints what one Operator-triggered research run would send (human researcher ticket 05): the exact `claude` argv of the `researcher` task and the
// rendered prompt, with sample X posts and sample coins. It starts no model, reads no web page, no X and no DexScreener, and touches no database.
//
// Usage: pnpm research:dry-run "GTA"
import { renderResearchDryRun } from '../packages/core/src/research/dry-run.ts';

const topic = process.argv.slice(2).join(' ');
const r = renderResearchDryRun(topic);
if (!r.ok) {
  console.error(`${r.problem}. usage: pnpm research:dry-run "<topic>"`);
  process.exit(2);
}
// The prompt is argv[1]: shown whole below, so the argv line leaves it out.
console.log(`claude ${r.argv.map((a, i) => (i === 1 ? '<the prompt, below>' : JSON.stringify(a))).join(' ')}`);
console.log('');
console.log('/researcher');
console.log('');
console.log(r.prompt);
