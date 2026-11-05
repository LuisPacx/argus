#!/usr/bin/env node
// Fake `wrangler` for offline tests: deploys nothing. Appends argv, cwd, the CLOUDFLARE_* variables it saw and the text of the
// --config file (read at call time) to FAKE_WRANGLER_LOG, then prints a workers.dev URL for the --name it was given.
// FAKE_WRANGLER_FAIL=1 makes it fail; FAKE_WRANGLER_URL overrides the printed URL.
// FAKE_WRANGLER_STARTED, when set, is written to once the deploy is under way. FAKE_WRANGLER_RELEASE, when set, makes the
// deploy wait until that file exists. FAKE_WRANGLER_HANG=1 never finishes (after starting a grandchild in the same process
// group whose pid goes to FAKE_WRANGLER_GRANDCHILD). FAKE_WRANGLER_STRAGGLER, a file, receives the pid of a SIGTERM-ignoring process
// in the same group that is left running after a normal exit. The log also records the .env* files in the cwd and the contents
// of every --env-file, as wrangler would load them, and for the config's `main` the text of that file and a listing of the
// directory two levels up (the project root, as the bundler would see it).
// With --dry-run it bundles and deploys nothing: it writes <--outdir>/index.js and, for --metafile, an esbuild-style metafile
// whose inputs (paths relative to the cwd) are the entry point plus FAKE_WRANGLER_META_INPUTS (a JSON array of extra paths,
// as esbuild lists files the entry imported from elsewhere). Like the real one it also writes index.js.map and README.md to
// the outdir, plus a file for each name in FAKE_WRANGLER_OUT_EXTRA (a JSON array), as wrangler's module rules do for an imported .txt.
// The log records a listing of the directory holding the config's `main`.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { registerFake, registerPid } from "./run-registry.mjs";

registerFake();

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
  let main = null;
  let mainText = null;
  let rootListing = null;
  let mainListing = null;
  try {
    main = JSON.parse(configText).main;
    mainText = readFileSync(main, "utf8");
    rootListing = readdirSync(dirname(dirname(main))).sort();
    mainListing = readdirSync(dirname(main)).sort();
  } catch {
    // no config, or no readable main
  }
  appendFileSync(
    process.env.FAKE_WRANGLER_LOG,
    JSON.stringify({ argv, cwd: process.cwd(), cf, keys: Object.keys(process.env), configText, cwdEnvFiles, envFiles, envFileTexts, main, mainText, rootListing, mainListing }) + "\n",
  );
}
if (argv.includes("--dry-run")) {
  const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const outdir = flag("--outdir");
  const metafile = flag("--metafile");
  const main = JSON.parse(readFileSync(flag("--config"), "utf8")).main;
  const rel = (path) => relative(process.cwd(), path);
  if (outdir) {
    mkdirSync(outdir, { recursive: true });
    writeFileSync(join(outdir, "index.js"), "// bundled by the fake\nexport default {};\n");
    writeFileSync(join(outdir, "index.js.map"), "{}");
    writeFileSync(join(outdir, "README.md"), "This folder contains the built output assets for the worker.\n");
    for (const name of JSON.parse(process.env.FAKE_WRANGLER_OUT_EXTRA ?? "[]")) writeFileSync(join(outdir, name), "extra\n");
  }
  if (metafile) {
    // As the bundler would have read them, the extra inputs that lie under the export exist (those outside it are never made).
    const exportDir = resolve(dirname(dirname(main)));
    for (const f of JSON.parse(process.env.FAKE_WRANGLER_META_INPUTS ?? "[]")) {
      const abs = resolve(f);
      if (abs.startsWith(exportDir + "/") && !existsSync(abs)) {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, "");
      }
    }
    const inputs = Object.fromEntries([rel(main), ...JSON.parse(process.env.FAKE_WRANGLER_META_INPUTS ?? "[]")].map((f) => [f, { bytes: 1, imports: [] }]));
    const outputs = outdir ? { [rel(join(outdir, "index.js"))]: { bytes: 1, inputs: {}, imports: [], exports: [], entryPoint: rel(main) } } : {};
    writeFileSync(resolve(metafile), JSON.stringify({ inputs, outputs }));
  }
  console.log("--dry-run: exiting now.");
  process.exit(0);
}
if (process.env.FAKE_WRANGLER_HANG) {
  if (process.env.FAKE_WRANGLER_GRANDCHILD) {
    const gc = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);', import.meta.dirname], { stdio: "ignore" }); registerPid(gc.pid);
    writeFileSync(process.env.FAKE_WRANGLER_GRANDCHILD, String(gc.pid));
  }
  if (process.env.FAKE_WRANGLER_STARTED) writeFileSync(process.env.FAKE_WRANGLER_STARTED, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  if (process.env.FAKE_WRANGLER_STRAGGLER) {
    const gc = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);', import.meta.dirname], { stdio: "ignore" }); registerPid(gc.pid);
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
  // The (fake) account now holds this Worker: the harness's fake Cloudflare API reads this file to answer "taken".
  if (process.env.FAKE_WRANGLER_LOG) appendFileSync(`${process.env.FAKE_WRANGLER_LOG}.deployed`, `${name}\n`);
  console.log("Total Upload: 1.00 KiB / gzip: 0.50 KiB");
  console.log(`Deployed ${name} triggers (0.50 sec)`);
  console.log(process.env.FAKE_WRANGLER_URL ?? `  https://${name}.fake-account.workers.dev`);
}
