import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Datastore } from "@argus/core";
import { tempDir } from "../../../packages/core/src/testing/temp.ts";
import { expect, it } from "vitest";

const workerDir = join(import.meta.dirname, "..");
const fixtures = join(workerDir, "../../packages/core/src/fixtures");
const ARGUS_PODMAN_BIN = join(workerDir, "../../packages/core/src/testing/fake-podman.mjs");

/** Runs the real worker once (plain node, `--once`) against feeds served from loopback fixtures; no external network. */
async function runOnce(feeds: unknown, routes: Record<string, { status: number; body: string }>, env: Record<string, string> = {}) {
  const dir = tempDir("argus-ingest-");
  const server = createServer((req, res) => {
    const r = routes[req.url ?? ""] ?? { status: 404, body: "" };
    res.writeHead(r.status, { "content-type": "application/rss+xml" }).end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const feedsPath = join(dir, "rss-feeds.json");
  const resolved = (feeds as Array<{ id: string; path: string }>).map((f) => ({ id: f.id, label: f.id.toUpperCase(), url: `${base}${f.path}` }));
  writeFileSync(feedsPath, JSON.stringify(resolved));
  const db = join(dir, "argus.db");
  try {
    const child = spawn(process.execPath, ["src/main.ts", "--once"], {
      cwd: workerDir,
      env: { ...process.env, ARGUS_DB: db, ARGUS_PODMAN_BIN, ARGUS_RSS_FEEDS: feedsPath, ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    const store = Datastore.open(db);
    try {
      return { code, out, signals: store.latestSignals(100), narratives: store.listNarratives() };
    } finally {
      store.close();
    }
  } finally {
    server.close();
  }
}

const routes = {
  "/tech": { status: 200, body: readFileSync(join(fixtures, "tech-news.rss.xml"), "utf8") },
  "/other": { status: 200, body: readFileSync(join(fixtures, "other-feed.rss.xml"), "utf8") },
  "/down": { status: 503, body: "" },
};

it("the worker's ingest tick stores Signals from the feed list", async () => {
  const { code, out, signals } = await runOnce([{ id: "rss:tech", path: "/tech" }, { id: "rss:other", path: "/other" }], routes);
  expect(code).toBe(0);
  expect(out).toContain("[worker] ingest tick: 2 feed(s), 5 new signal(s)");
  expect(signals.map((s) => s.title)).toEqual([
    "Memecoin season rumours",
    "Unsafe link item",
    "Robots & Rockets: A Launch Day",
    "Cat Elected Mayor of Small Town",
    "Undated item",
  ]);
}, 60_000);

it("the ingest tick clusters the new Signals into Narratives", async () => {
  const { code, out, narratives } = await runOnce([{ id: "rss:tech", path: "/tech" }, { id: "rss:other", path: "/other" }], routes);
  expect(code).toBe(0);
  expect(out).toContain("[worker] cluster: 5 signal(s) clustered, 5 new narrative(s)");
  expect(narratives.map((n) => n.signalCount)).toEqual([1, 1, 1, 1, 1]);
}, 60_000);

it("a failing feed is logged and the others are still stored", async () => {
  const { code, out, signals } = await runOnce([{ id: "rss:down", path: "/down" }, { id: "rss:other", path: "/other" }], routes);
  expect(code).toBe(0);
  expect(out).toContain("[ingest] rss:down failed");
  expect(out).toContain("503");
  expect(out).toContain("1 new signal(s), 1 feed(s) failed");
  expect(signals.map((s) => s.sourceId)).toEqual(["rss:other"]);
}, 60_000);

it("a malformed feed list is reported and does not stop the worker", async () => {
  const { code, out } = await runOnce([{ id: "rss:x", path: "/tech" }], routes, { ARGUS_RSS_FEEDS: join(fixtures, "tech-news.rss.xml") });
  expect(code).toBe(0);
  expect(out).toContain("[worker] ingest tick failed");
}, 60_000);

it("a dry run polls nothing", async () => {
  const { code, out, signals, narratives } = await runOnce([{ id: "rss:tech", path: "/tech" }], routes, { ARGUS_DRY_RUN: "1" });
  expect(code).toBe(0);
  expect(out).toContain("ingest tick: dry-run");
  expect(signals).toEqual([]);
  expect(narratives).toEqual([]);
}, 60_000);
