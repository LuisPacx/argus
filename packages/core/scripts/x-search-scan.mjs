#!/usr/bin/env node
// The Moment scanner's child process (Moment scanner ticket 01; ADR 0009 as amended 2026-11-19).
//
// Reads a JSON plan on stdin, a list of { id, url }, opens the dedicated Argus Chrome directory (ARGUS_CHROME_DIR) as a persistent
// context, loads each address serially with 9 to 22 s of jitter and at most 3 wheel scrolls, and prints one JSON line per page
// (posts, status, signals) and a last line { done: true, exit, loads, stopped }. Nothing is saved to disk.
//
// It refuses any address that is not https://x.com/search?q=...&f=top|live or https://x.com/<handle>/status/<id>, exits 3 when
// the directory is locked, and stops at the first STOP signal with no retry. It uses goto, wheel scrolls and reads only.
// Exit codes: 0 ok, 1 error, 2 stop signal, 3 locked, 4 refused plan, 5 selectors found nothing.

import { homedir } from "node:os";
import { join } from "node:path";
import { assertDirSafe, lockHolder } from "../src/x-capture/lock.mjs";
import { EXIT, planProblem, runScan } from "../src/x-capture/scan.mjs";
import { openSession } from "../src/x-capture/session.mjs";

const DIR = process.env.ARGUS_CHROME_DIR || join(homedir(), ".local/share/argus/chrome");
const CHROME = process.env.ARGUS_CHROME_BIN || "/usr/bin/google-chrome";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (lo, hi) => lo + Math.random() * (hi - lo);
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const c of process.stdin) {
    size += c.length;
    if (size > 64 * 1024) throw new Error("the plan is over 64 KiB");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

let plan;
try {
  plan = JSON.parse(await readStdin());
} catch (e) {
  emit({ done: true, exit: EXIT.refused, loads: 0, reason: `the plan is not valid JSON: ${String(e.message).slice(0, 100)}` });
  process.exit(EXIT.refused);
}
// An address or a plan that is refused ends here, before the directory is looked at or any browser opens.
const problem = planProblem(plan);
if (problem) {
  emit({ done: true, exit: EXIT.refused, loads: 0, reason: problem });
  process.exit(EXIT.refused);
}
let exit = EXIT.error;
try {
  const r = await runScan({
    plan,
    lock: () => lockHolder(DIR),
    open: async () => {
      assertDirSafe(DIR);
      return openSession({ dir: DIR, chromeBin: CHROME, sleep, jitter });
    },
    emit,
    sleep,
    jitter,
  });
  exit = r.exit;
} catch (e) {
  emit({ done: true, exit: EXIT.error, loads: 0, reason: String(e && e.message).split("\n")[0].slice(0, 200) });
}
process.exit(exit);
