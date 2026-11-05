#!/usr/bin/env node
// Fake `wrangler` for offline tests: deploys nothing. Appends argv, cwd and the CLOUDFLARE_* variables it saw to
// FAKE_WRANGLER_LOG, then prints a workers.dev URL for the --name it was given. FAKE_WRANGLER_FAIL=1 makes it fail;
// FAKE_WRANGLER_URL overrides the printed URL.
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_WRANGLER_LOG) {
  const cf = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("CLOUDFLARE_")));
  appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify({ argv, cwd: process.cwd(), cf, keys: Object.keys(process.env) }) + "\n");
}
if (process.env.FAKE_WRANGLER_FAIL) {
  console.error("[ERROR] A request to the Cloudflare API failed.");
  process.exit(1);
}
const name = argv[argv.indexOf("--name") + 1] ?? "unknown";
console.log("Total Upload: 1.00 KiB / gzip: 0.50 KiB");
console.log(`Deployed ${name} triggers (0.50 sec)`);
console.log(process.env.FAKE_WRANGLER_URL ?? `  https://${name}.fake-account.workers.dev`);
