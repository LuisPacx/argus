import { spawn } from "node:child_process";
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
async function runOnce(telegram: Record<string, string>, extraArgs: string[] = []) {
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
    const env = { ...process.env, ARGUS_DB: db, ARGUS_PODMAN_BIN, ARGUS_RSS_FEEDS, ARGUS_INGEST_STANDING: "0", ARGUS_EMBEDDER: "hashing", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", ARGUS_TELEGRAM_URL: url, ...telegram };
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

it("a dry run logs the card instead of sending it", async () => {
  const r = await runOnce({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "-100777" }, ["--dry-run"]);
  expect(r.code).toBe(0);
  expect(r.received).toHaveLength(0);
  expect(r.out).toContain("[telegram] dry-run: would send:");
  expect(r.out).toContain("New Proposal: Moon Cat ($MCAT)");
  expect(r.out).not.toContain(TOKEN);
}, 60_000);
