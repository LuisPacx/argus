import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registryDirFor, startTicks } from "./run-registry.mjs";

/**
 * Vitest globalSetup: the suite must not leave a fake `claude`, `gh` or `wrangler` (or a grandchild one of them started)
 * running. Such a leak means a kill path did not reach a whole process group, which is the bug class the process-group tests
 * guard; leftovers also pile up on the machine (idle fakes were found reparented to the user manager hours later).
 *
 * Only this run's fakes count. The run makes a registry directory named after its own pid (see run-registry.mjs); each fake
 * started under this process, and each grandchild a fake starts, records its pid and start time there. After the run, any of
 * those still alive fails the run and is killed. A second vitest run in the same checkout has its own directory and is never
 * looked at. Linux only (reads /proc); elsewhere it does nothing.
 *
 * Temp dirs get the same treatment. The run points TMPDIR at a private directory (`argus-test-run-*`, created under the real
 * temp dir) before any worker starts, so every `os.tmpdir()` in tests and in the code under test lands inside it. Anything
 * still there after the run is a leak: it fails the run and is removed. A second run has its own directory and is never
 * looked at. The private directory itself is always removed, so a clean run leaves nothing in the temp dir.
 */
const CLK_TCK = 100; // USER_HZ is 100 on every Linux ABI node runs on

interface Found {
  pid: number;
  cmdline: string;
}

/** Live (non-zombie) processes recorded in `dir` that are still the processes that were recorded (not a reused pid). */
export function leakedIn(dir: string): Found[] {
  const found: Found[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const recorded = Number(readFileSync(`${dir}/${entry}`, "utf8"));
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      // /proc/<pid>/stat: "pid (comm) state ... starttime" with starttime the 22nd field; comm may hold spaces and parentheses.
      if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] === "Z") continue;
      if (startTicks(Number(entry)) !== recorded) continue;
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").join(" ").trim();
      found.push({ pid: Number(entry), cmdline });
    } catch {
      // gone while being read
    }
  }
  return found;
}

// Node's compile cache for the run's processes. It must NOT live in the run's private temp dir: vitest's fork workers (and the
// node children tests spawn) write it as they exit, which can be after this teardown has started, so removing the dir raced
// those writes (ENOTEMPTY on rmdir, exit 1 after all tests passed). It sits on the home disk under the gitignored
// node_modules/.cache, found from this file's own location, and is shared by runs: Node writes cache entries atomically.
const COMPILE_CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "node_modules", ".cache", "node-compile-cache");
const TOOL_CACHES = ["update-check"]; // update-check: wrangler's version-check cache, written by the real-wrangler tests

/** Removes the run's private temp dir; throws, naming what was left in it, when the run did not clean up after itself. */
export function sweepTempRoot(root: string): void {
  let left: string[] = [];
  try {
    left = readdirSync(root).filter((n) => !TOOL_CACHES.includes(n));
  } catch {
    // never created
  }
  // Backstop only: a tool child killed at the end of a test may still be finishing a write; the retries ride that out.
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  if (left.length > 0) throw new Error(`The test run left ${left.length} temp entr${left.length === 1 ? "y" : "ies"} behind (removed now):\n${left.map((e) => `  ${e}`).join("\n")}`);
}

function isolateTmpdir(): () => void {
  const saved = { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE };
  const root = mkdtempSync(join(tmpdir(), "argus-test-run-"));
  process.env.TMPDIR = root;
  process.env.NODE_COMPILE_CACHE = COMPILE_CACHE_DIR; // configures Node in the run's processes; nothing in a test looks for state through it
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    sweepTempRoot(root);
  };
}

const TRIPWIRE_PREFIX = "real-claude-";

/** Writes the tripwire `claude` into `<dir>/bin` (calls are recorded in `dir`) and returns that bin directory. */
export function writeClaudeTripwire(dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const script = `#!/bin/sh\nprintf '%s\\n' "$*" | tr '\\n' ' ' | cut -c1-300 >'${dir}/${TRIPWIRE_PREFIX}'$$\necho "claude: blocked by the test run's guard (no-leaked-fakes.ts): tests must use the fake claude" >&2\nexit 127\n`;
  writeFileSync(join(bin, "claude"), script);
  chmodSync(join(bin, "claude"), 0o755);
  return bin;
}

/**
 * A `claude` that is first on the run's PATH, so a worker or Brain started without a fake binary (ARGUS_CLAUDE_BIN, or `command` for a
 * ClaudeCodeBrain) reaches this instead of the Operator's real one, which spends the subscription and needs the network. It runs
 * nothing: it records the call in the run's registry directory (a file the teardown looks for) and exits 127, so the code under test sees
 * a failed run and the run as a whole fails. Fakes are started by absolute path and never meet it.
 */
function installClaudeTripwire(dir: string): () => void {
  const bin = writeClaudeTripwire(dir);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${saved ?? ""}`;
  return () => {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  };
}

/** Fails the run when anything reached the tripwire `claude`; names each call's arguments. */
export function failOnRealClaude(dir: string): void {
  let calls: string[] = [];
  try {
    calls = readdirSync(dir)
      .filter((n) => n.startsWith(TRIPWIRE_PREFIX))
      .map((n) => `  ${n.slice(TRIPWIRE_PREFIX.length)}: ${readFileSync(join(dir, n), "utf8").trim()}`);
  } catch {
    return;
  }
  if (calls.length > 0) throw new Error(`The test run tried to start the real \`claude\` ${calls.length} time(s) (blocked); tests must use the fake claude:\n${calls.join("\n")}`);
}

/**
 * Keeps the run off the network (collision checks, ARGUS_DEXSCREENER_SEARCH_URL and ARGUS_GITHUB_SEARCH_URL, are dead loopback ports too) and away from the Operator's Telegram chat: ARGUS_NO_DOTENV makes a worker skip the repo-root .env (where the bot token
 * lives), and ARGUS_TELEGRAM_URL points the Bot API at a loopback port nothing listens on. Every worker a test spawns inherits both;
 * a test that wants a Telegram sets its own URL and token explicitly (a fake on loopback).
 */
function blockTelegram(): () => void {
  const saved = {
    ARGUS_NO_DOTENV: process.env.ARGUS_NO_DOTENV,
    ARGUS_TELEGRAM_URL: process.env.ARGUS_TELEGRAM_URL,
    ARGUS_DEXSCREENER_SEARCH_URL: process.env.ARGUS_DEXSCREENER_SEARCH_URL,
    ARGUS_GITHUB_SEARCH_URL: process.env.ARGUS_GITHUB_SEARCH_URL,
  };
  process.env.ARGUS_NO_DOTENV = "1";
  process.env.ARGUS_TELEGRAM_URL = "http://127.0.0.1:1";
  // The collision checks of a worker a test spawns reach DexScreener and GitHub through these: dead too, so a check there is "unknown".
  process.env.ARGUS_DEXSCREENER_SEARCH_URL = "http://127.0.0.1:1";
  process.env.ARGUS_GITHUB_SEARCH_URL = "http://127.0.0.1:1";
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

export interface AnthropicTripwire {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** One `METHOD /path` per request that reached it. Headers and bodies are never kept: they hold the key and the prompts. */
  hits: string[];
  close(): Promise<void>;
}

/** A loopback server that refuses (403) every request and records `METHOD /path`: where a test that reaches for the Anthropic API ends up. */
export async function startAnthropicTripwire(): Promise<AnthropicTripwire> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${(req.url ?? "").split("?")[0]}`);
    req.resume();
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "permission_error", message: "blocked by the test run's guard (no-leaked-fakes.ts): tests must use the fake Anthropic server" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Fails the run when anything reached the Anthropic tripwire (a real call costs real money); names each request. */
export function failOnAnthropicCalls(hits: readonly string[]): void {
  if (hits.length > 0) throw new Error(`The test run tried to reach the Anthropic API ${hits.length} time(s) (blocked); tests must use the fake Anthropic server (testing/fake-anthropic.ts):\n${hits.map((h) => `  ${h}`).join("\n")}`);
}

/**
 * Keeps the run away from the real Anthropic API, which bills real money: ARGUS_ANTHROPIC_URL (the endpoint ApiBrain defaults to) and the
 * SDK's own ANTHROPIC_BASE_URL both point at a loopback tripwire, and any API key in the environment is dropped for the run, so neither a
 * worker a test spawns nor an ApiBrain built without a fake endpoint can reach api.anthropic.com or carry the Operator's key. A test that
 * wants an API makes its own fake (testing/fake-anthropic.ts) and passes its URL explicitly.
 */
async function blockAnthropic(): Promise<{ restore: () => void; hits: string[]; close: () => Promise<void> }> {
  const names = ["ARGUS_ANTHROPIC_URL", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  const tripwire = await startAnthropicTripwire();
  process.env.ARGUS_ANTHROPIC_URL = tripwire.url;
  process.env.ANTHROPIC_BASE_URL = tripwire.url;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  return {
    hits: tripwire.hits,
    close: tripwire.close,
    restore: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

export default async function setup(): Promise<() => Promise<void>> {
  const restoreTelegram = blockTelegram();
  const anthropic = await blockAnthropic();
  const restoreTmpdir = isolateTmpdir();
  const endAnthropic = async () => {
    anthropic.restore();
    await anthropic.close();
    failOnAnthropicCalls(anthropic.hits);
  };
  if (process.platform !== "linux") {
    return async () => {
      restoreTelegram();
      restoreTmpdir();
      await endAnthropic();
    };
  }
  const dir = registryDirFor(process.pid); // on the home disk, found by the fakes without any env
  rmSync(dir, { recursive: true, force: true }); // a crashed earlier run whose pid was reused
  mkdirSync(dir, { recursive: true });
  const restorePath = installClaudeTripwire(dir);
  return async () => {
    try {
      restorePath();
      failOnRealClaude(dir);
      await failOnLeakedFakes(dir);
      await endAnthropic();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreTelegram();
      restoreTmpdir();
    }
  };
}

async function failOnLeakedFakes(dir: string): Promise<void> {
  // A process just killed may take a moment to disappear.
  let leaked = leakedIn(dir);
  for (let i = 0; i < 100 && leaked.length > 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
    leaked = leakedIn(dir);
  }
  if (leaked.length === 0) return;
  for (const l of leaked) {
    try {
      process.kill(l.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  throw new Error(`The test run left ${leaked.length} fake process(es) running (killed now):\n${leaked.map((l) => `  ${l.pid} ${l.cmdline}`).join("\n")}`);
}
