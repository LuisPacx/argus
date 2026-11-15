// Spawns the real page-check script and a real headless browser against a throwaway local server. Slow tier.
// Self-skips when the matching Chromium headless shell is not installed.
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "../packages/core/src/testing/temp.ts";
// @ts-expect-error plain .mjs script, no types
import { chooseBrowser, expectedRevision } from "./page-check.mjs";

const installed = chooseBrowser(path.join(os.homedir(), ".cache", "ms-playwright"), expectedRevision()) !== null;

const BAD = `<!doctype html><title>bad</title><script>console.error("kaboom-from-page")</script><img src="/missing.png" alt="">`;
const GOOD = `<!doctype html><title>good</title><button id="a" data-test="open">Open</button>
<div id="panel" hidden role="dialog"><button id="close">Close</button></div>
<script>
const a = document.getElementById("a"), p = document.getElementById("panel"), c = document.getElementById("close");
a.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); p.hidden = false; c.focus(); } });
p.addEventListener("keydown", (e) => { if (e.key === "Escape") { p.hidden = true; a.focus(); } });
</script>`;

const FORM = `<!doctype html><title>form</title><form method="post" action="/submit"><button id="go" type="submit">Go</button></form>`;
const posts: string[] = [];
const profiles = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("playwright"));

let server: http.Server;
let port = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === "POST") posts.push(req.url ?? "");
    if (req.url === "/form") res.writeHead(200, { "content-type": "text/html" }).end(FORM);
    else if (req.method === "POST") res.writeHead(200).end("posted");
    else
    if (req.url === "/bad") res.writeHead(200, { "content-type": "text/html" }).end(BAD);
    else if (req.url === "/good") res.writeHead(200, { "content-type": "text/html" }).end(GOOD);
    else res.writeHead(404).end("no");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function run(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile("node", [path.resolve(import.meta.dirname, "page-check.mjs"), ...args], { timeout: 50000 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: stdout + stderr });
    });
  });
}

describe.skipIf(!installed)("page-check in a real headless browser", { timeout: 60000 }, () => {
  it("fails a page with a console error and a 404 image, and names both", async () => {
    const out = tempDir("page-check-out-");
    const r = await run(["/bad", "--port", String(port), "--out", out]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("kaboom-from-page");
    expect(r.stdout).toContain("/missing.png");
    expect(fs.existsSync(path.join(out, "bad-1240.png"))).toBe(true);
    expect(fs.existsSync(path.join(out, "bad-390.png"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(out, "bad.json"), "utf8")).exit).toBe(1);
  });

  it("passes a healthy page and records focus and visibility after each key step", async () => {
    const out = tempDir("page-check-out-");
    const r = await run(["/good", "--port", String(port), "--out", out, "--keys", "focus=#a,Enter,Escape", "--watch", "#panel"]);
    expect(r.code).toBe(0);
    const json = JSON.parse(fs.readFileSync(path.join(out, "good.json"), "utf8"));
    const log = json.keys["1240"];
    expect(log.map((s: { focus: { id: string } }) => s.focus.id)).toEqual(["a", "close", "a"]);
    expect(log.map((s: { visible: Record<string, boolean> }) => s.visible["#panel"])).toEqual([false, true, false]);
    expect(fs.existsSync(path.join(out, "good-390-keys.png"))).toBe(true);
  });

  it("blocks a state-changing request that Enter would send, fails, and leaves no temp profile", async () => {
    const before = profiles();
    const out = tempDir("page-check-out-");
    const r = await run(["/form", "--port", String(port), "--out", out, "--keys", "focus=#go,Enter"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("blocked POST");
    expect(posts).toEqual([]);
    expect(profiles()).toEqual(before);
  });

  it("exits 2 for a non-local path", async () => {
    const r = await run(["//evil.example/", "--port", String(port), "--out", tempDir("page-check-out-")]);
    expect(r.code).toBe(2);
  });
});
