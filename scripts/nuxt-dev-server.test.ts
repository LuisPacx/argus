import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../packages/core/src/testing/temp.ts";
// @ts-expect-error plain .mjs script, no types
import { groupAlive, httpGet, logTail, stopGroup, waitForNuxtReady } from "./nuxt-dev-server.mjs";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function startGroup(source: string): number {
  const child = spawn(process.execPath, ["-e", source], { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid!;
}

describe("shared Nuxt dev server helpers (verify-boot step 4 and page:check --seed)", () => {
  it("httpGet returns status and body, and status 0 when nothing answers", async () => {
    const server = http.createServer((_req, res) => res.writeHead(503).end("loading"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    expect(await httpGet(`http://127.0.0.1:${port}/`, 2000)).toEqual({ status: 503, body: "loading" });
    await new Promise((resolve) => server.close(resolve));
    expect((await httpGet(`http://127.0.0.1:${port}/`, 2000)).status).toBe(0);
  });

  it("stopGroup ends a SIGTERM-able group without SIGKILL", async () => {
    const pgid = startGroup("setInterval(() => {}, 1000)");
    expect(groupAlive(pgid)).toBe(true);
    expect(await stopGroup(pgid, 5000, 20)).toBe(false);
    expect(groupAlive(pgid)).toBe(false);
  });

  it("stopGroup SIGKILLs a group that ignores SIGTERM and says so", async () => {
    const pgid = startGroup("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
    await sleep(1500); // let node start and install the handler, also under load
    expect(await stopGroup(pgid, 300, 20)).toBe(true);
    const deadline = Date.now() + 3000;
    while (groupAlive(pgid) && Date.now() < deadline) await sleep(20);
    expect(groupAlive(pgid)).toBe(false);
  });

  it("waitForNuxtReady reports an exit, a timeout, and a server that is up but not on the log's port", async () => {
    const logFile = path.join(tempDir("nuxt-dev-server-"), "warroom.log");
    fs.writeFileSync(logFile, "line1\nline2\nline3\nline4\n");
    expect(logTail(logFile)).toBe("line2 | line3 | line4");
    // Nothing listens on port 1; the process "exited" at once.
    const exited = await waitForNuxtReady({ port: 1, logFile, hasExited: () => true, timeoutMs: 5000 });
    expect(exited).toContain("dev server not up within 5s");
    expect(exited).toContain("line4");
    // Cancelled before it came up.
    expect(await waitForNuxtReady({ port: 1, logFile, hasExited: () => false, timeoutMs: 5000, cancelled: () => true })).toContain("not up");

    const server = http.createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      // Answers (non-503), but the log does not name the port: another server answered.
      expect(await waitForNuxtReady({ port, logFile, hasExited: () => false, timeoutMs: 5000 })).toContain(`did not bind port ${port}`);
      fs.appendFileSync(logFile, `Local: http://localhost:${port}/\n`);
      expect(await waitForNuxtReady({ port, logFile, hasExited: () => false, timeoutMs: 5000 })).toBeNull();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
