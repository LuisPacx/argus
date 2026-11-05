#!/usr/bin/env node
// Fake `wrangler` for offline tests: deploys nothing. Appends argv, cwd, the CLOUDFLARE_* variables it saw and the text of the
// --config file (read at call time) to FAKE_WRANGLER_LOG, then prints a workers.dev URL for the --name it was given.
// FAKE_WRANGLER_FAIL=1 makes it fail; FAKE_WRANGLER_URL overrides the printed URL.
// FAKE_WRANGLER_STARTED, when set, is written to once the deploy is under way. FAKE_WRANGLER_RELEASE, when set, makes the
// deploy wait until that file exists. FAKE_WRANGLER_HANG=1 never finishes (after starting a grandchild in the same process
// group whose pid goes to FAKE_WRANGLER_GRANDCHILD). FAKE_WRANGLER_STRAGGLER, a file, receives the pid of a SIGTERM-ignoring process
// in the same group that is left running after a normal exit. The log also records the .env* files in the cwd and the contents
// of every --env-file, as wrangler would load them.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_WRANGLER_LOG) {
  const cf = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("CLOUDFLARE_")));
  const configPath = argv.includes("--config") ? argv[argv.indexOf("--config") + 1] : undefined;
  let configText = null;
  try {
    configText = configPath ? readFileSync(configPath, "utf8") : null;
  } catch {
    // no readable config
  }
  const cwdEnvFiles = readdirSync(".").filter((f) => f.startsWith(".env") || f === ".dev.vars");
  const envFiles = argv.flatMap((a, i) => (a === "--env-file" ? [argv[i + 1]] : []));
  const envFileTexts = envFiles.map((f) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return null;
    }
  });
  appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify({ argv, cwd: process.cwd(), cf, keys: Object.keys(process.env), configText, cwdEnvFiles, envFiles, envFileTexts }) + "\n");
}
if (process.env.FAKE_WRANGLER_HANG) {
  if (process.env.FAKE_WRANGLER_GRANDCHILD) {
    const gc = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);', import.meta.dirname], { stdio: "ignore" });
    writeFileSync(process.env.FAKE_WRANGLER_GRANDCHILD, String(gc.pid));
  }
  if (process.env.FAKE_WRANGLER_STARTED) writeFileSync(process.env.FAKE_WRANGLER_STARTED, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  if (process.env.FAKE_WRANGLER_STRAGGLER) {
    const gc = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);', import.meta.dirname], { stdio: "ignore" });
    gc.unref();
    writeFileSync(process.env.FAKE_WRANGLER_STRAGGLER, String(gc.pid));
  }
  if (process.env.FAKE_WRANGLER_STARTED) writeFileSync(process.env.FAKE_WRANGLER_STARTED, String(process.pid));
  while (process.env.FAKE_WRANGLER_RELEASE && !existsSync(process.env.FAKE_WRANGLER_RELEASE)) await new Promise((r) => setTimeout(r, 10));
  if (process.env.FAKE_WRANGLER_FAIL) {
    console.error("[ERROR] A request to the Cloudflare API failed.");
    process.exit(1);
  }
  const name = argv[argv.indexOf("--name") + 1] ?? "unknown";
  console.log("Total Upload: 1.00 KiB / gzip: 0.50 KiB");
  console.log(`Deployed ${name} triggers (0.50 sec)`);
  console.log(process.env.FAKE_WRANGLER_URL ?? `  https://${name}.fake-account.workers.dev`);
}
