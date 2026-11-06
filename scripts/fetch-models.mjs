#!/usr/bin/env node
// Pre-fetches the Narrative embedder's model (docs/adr/0007) into the model cache and checks every file against the pinned
// sha-256, so the worker never has to download on its first clustering pass. Safe to rerun: intact files are not fetched again.
//
//   pnpm models:fetch          (cache: $ARGUS_MODEL_DIR, default ~/.cache/argus/models; host: $ARGUS_MODEL_HOST)
import { SEMANTIC_MODEL, fetchModel, missingFiles, modelCacheDir } from "../apps/worker/src/semantic-embedder.ts";

const dir = modelCacheDir(process.env);
const host = process.env.ARGUS_MODEL_HOST || undefined;
try {
  await fetchModel({ dir, spec: SEMANTIC_MODEL, host, log: console.log });
} catch (err) {
  console.error(`models:fetch failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
const bad = missingFiles(dir, SEMANTIC_MODEL);
if (bad.length > 0) {
  console.error(`models:fetch: still missing or corrupt: ${bad.join(", ")}`);
  process.exit(1);
}
for (const [file, { sha256, bytes }] of Object.entries(SEMANTIC_MODEL.files)) console.log(`ok  ${sha256}  ${bytes} bytes  ${file}`);
console.log(`${SEMANTIC_MODEL.repo}@${SEMANTIC_MODEL.revision} is in ${dir}/${SEMANTIC_MODEL.repo}`);
