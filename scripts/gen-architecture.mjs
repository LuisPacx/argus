// `pnpm docs:graph`: rewrites the generated diagrams in docs/architecture.md (the system overview, from the pipeline graph, and the Proposal
// lifecycle, from the transition table). `--check` writes nothing and exits 1 when they are stale (pipeline-docs.test.ts runs the same check
// inside `pnpm check`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderGeneratedDocs } from '../packages/core/src/pipeline-diagrams.ts';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'architecture.md');
const current = fs.readFileSync(file, 'utf8');
const next = renderGeneratedDocs(current);
if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error('docs/architecture.md: the generated diagrams are stale; run `pnpm docs:graph`');
    process.exit(1);
  }
  console.log('docs/architecture.md: the generated diagrams are current');
} else if (next === current) {
  console.log('docs/architecture.md: already current');
} else {
  fs.writeFileSync(file, next);
  console.log('docs/architecture.md: generated diagrams rewritten');
}
