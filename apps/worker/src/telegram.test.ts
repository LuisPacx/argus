import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Datastore } from "@argus/core";
import { tempDir } from "../../../packages/core/src/testing/temp.ts";
import { expect, it } from "vitest";

const workerDir = join(import.meta.dirname, "..");
const ARGUS_PODMAN_BIN = join(workerDir, "../../packages/core/src/testing/fake-podman.mjs");
const ARGUS_RSS_FEEDS = join(workerDir, "../../packages/core/src/fixtures/no-feeds.json");
const TOKEN = "987654:WORKER-SECRET-token";

/** Runs the real worker once with a new Proposal in its database, against a fake Telegram API on loopback. */
async function runOnce(telegram: Record<string, string | undefined>, extraArgs: string[] = [], inheritUrl = false) {
  const dir = tempDir("argus-telegram-");
  const db = join(dir, "argus.db");
  const store = Datastore.open(db);
  store.createProposal({ narrativeSummary: "Cats", techOneLiner: "Adopt", whyNow: "Now", name: "Moon Cat", ticker: "MCAT", description: "d", evidenceLinks: [] });
  store.close();
  const received: Array<{ path: string; text: string }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", text: (JSON.parse(raw) as { text: string }).text });
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"result":{}}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const env: NodeJS.ProcessEnv = { ...process.env, ARGUS_DB: db, ARGUS_PODMAN_BIN, ARGUS_RSS_FEEDS, ARGUS_INGEST_STANDING: "0", ARGUS_EMBEDDER: "hashing", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", ARGUS_TELEGRAM_URL: url, ...telegram };
    for (const [k, v] of Object.entries(telegram)) if (v === undefined) delete env[k];
    // inheritUrl: the worker keeps the globalSetup's dead loopback URL instead of the fake server's.
    if (inheritUrl) env.ARGUS_TELEGRAM_URL = process.env.ARGUS_TELEGRAM_URL;
    const child = spawn(process.execPath, ["src/main.ts", "--once", ...extraArgs], { cwd: workerDir, env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    return { code, out, received };
  } finally {
    server.close();
  }
}

it("the worker sends a card for a new Proposal to the configured chat, once, and never prints the token", async () => {
  const r = await runOnce({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "-100777" });
  expect(r.code).toBe(0);
  expect(r.received).toHaveLength(1);
  expect(r.received[0]!.path).toBe(`/bot${TOKEN}/sendMessage`);
  expect(r.received[0]!.text).toContain("New Proposal: Moon Cat ($MCAT)");
  expect(r.out).not.toContain(TOKEN);
}, 60_000);

it("without config the worker warns once, sends nothing and carries on", async () => {
  const r = await runOnce({});
  expect(r.code).toBe(0);
  expect(r.received).toHaveLength(0);
  expect(r.out.split("\n").filter((l) => l.includes("[telegram] notifications are off"))).toHaveLength(1);
}, 60_000);

it("tripwire: a worker spawned the way the tests spawn it inherits the dead Telegram URL and the no-.env marker, so it reaches no real chat", async () => {
  expect(process.env.ARGUS_NO_DOTENV).toBe("1");
  // Even with a token in its environment, the inherited URL is a dead loopback port: the fake sees nothing, the token is not printed.
  const r = await runOnce({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "-100777", ARGUS_TELEGRAM_URL: process.env.ARGUS_TELEGRAM_URL! });
  expect(r.code).toBe(0);
  expect(r.received).toHaveLength(0);
  expect(r.out).not.toContain(TOKEN);
}, 90_000);

it("a spawned worker with ARGUS_NO_DOTENV=1 skips a .env that holds a bot token: it logs so, warns that notifications are off and sends nothing", async () => {
  expect(process.env.ARGUS_NO_DOTENV).toBe("1");
  const envFile = join(tempDir("argus-dotenv-"), ".env");
  writeFileSync(envFile, `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_CHAT_ID=-100777\n`);
  const noEnvVars = { TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined, ARGUS_ENV_FILE: envFile };
  // Control: the same file without the marker is read, notifications turn on and the card reaches the fake server. This proves the
  // file is found and holds a working token, so the skip below is what stops it.
  const control = await runOnce({ ...noEnvVars, ARGUS_NO_DOTENV: undefined });
  expect(control.code).toBe(0);
  expect(control.out).not.toContain(".env skipped");
  expect(control.received).toHaveLength(1);
  expect(control.received[0]!.path).toBe(`/bot${TOKEN}/sendMessage`);
  // Skip run: no TELEGRAM_* in the environment (nothing masks the file), the marker the test run set, and no URL override: the worker
  // keeps the globalSetup's dead loopback URL.
  const r = await runOnce(noEnvVars, [], true);
  expect(r.code).toBe(0);
  expect(r.out).toContain("[worker] .env skipped (ARGUS_NO_DOTENV)");
  expect(r.out).toContain("[telegram] notifications are off");
  expect(r.received).toHaveLength(0);
  expect(r.out).not.toContain(TOKEN);
}, 120_000);

it("a dry run logs the card instead of sending it", async () => {
  const r = await runOnce({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "-100777" }, ["--dry-run"]);
  expect(r.code).toBe(0);
  expect(r.received).toHaveLength(0);
  expect(r.out).toContain("[telegram] dry-run: would send:");
  expect(r.out).toContain("New Proposal: Moon Cat ($MCAT)");
  expect(r.out).not.toContain(TOKEN);
}, 60_000);
